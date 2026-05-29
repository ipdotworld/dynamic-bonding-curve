use anchor_lang::prelude::*;
use static_assertions::const_assert_eq;

use crate::{
    constants::{BASIS_POINT_MAX, ONE_Q64},
    params::swap::TradeDirection,
    safe_math::SafeMath,
    state::config::FEE_SHARE_PRECISION,
    state::CollectFeeMode,
    state::DynamicFeeConfig,
    u128x128_math::Rounding,
    utils_math::{safe_mul_div_cast_u64, safe_shl_div_cast},
    PoolError,
};

// =============================================================================
// IPWorld fee distribution helpers (SPEC-DBC-004 Phase 2 — REQ-S-003;
// Phase 3 reduced quote distribution to 3 recipients — REQ-I-001)
//
// These functions are the canonical recipient-distribution helpers used by
// `apply_swap_result` (state/virtual_pool.rs) and `ix_harvest`
// (instructions/harvest/ix_harvest.rs). They were previously inlined in both
// call sites; relocating them here removes duplication and gives the test
// module a single source of truth.
//
// Phase 3 (REQ-I-001) reduced the quote distribution from 5-way to 4-way by
// removing the `creator_share` parameter and the corresponding `creator`
// recipient bucket. The IPWorld SELL fee model is now: ip_owner + airdrop +
// referral (immediate, handled outside) + treasury (remainder).
//
// Both functions preserve the existing rounding semantics (Rounding::Down for
// each component, treasury/ip_treasury absorbs any dust from the subtraction)
// so the post-refactor swap output is byte-identical to the prior inline code.
// =============================================================================

// -----------------------------------------------------------------------------
// Fixed fee-share constants (SPEC-DBC-AUDIT-001 Phase 1 — REQ-A-006)
//
// These replace the per-pool CONFIGURABLE share fields (`config.*_share`) on
// both the swap path (`apply_swap_result`) and the harvest path (`ix_harvest`).
// Hard-coding the splits removes a per-pool attack/misconfiguration surface and
// makes the economic model auditable from source alone.
//
// UNIT: all three are denominated in `FEE_SHARE_PRECISION` (= 1_000_000), where
// 1_000_000 == 100%. They are NOT basis points — a value of 400_000 means 40%,
// not 0.04%. The suffix is intentionally NOT `_BPS` to avoid that confusion.
//
// TRADEOFF (accepted): shares are now fixed at compile time. Changing any split
// requires a program upgrade (the upgrade authority must therefore be retained
// until shares are final). A change only affects fees accrued AFTER the upgrade;
// already-accumulated counters are untouched.
//
// Target proportions:
//   BUY  (base side):  token-side airdrop 40%, ip_treasury 60% (residual).
//   SELL (quote side): ip_owner 10%, airdrop 10%, treasury 80% (residual)
//                      — computed over the post-referral `distributable` amount.
// -----------------------------------------------------------------------------

/// BUY-side token-airdrop share of the base fee, in `FEE_SHARE_PRECISION` units.
/// 400_000 / 1_000_000 = 40%. The ip_treasury receives the 60% residual.
pub(crate) const TOKEN_AIRDROP_SHARE: u32 = 400_000;

/// SELL-side IP-owner share of the (post-referral) quote fee, in
/// `FEE_SHARE_PRECISION` units. 100_000 / 1_000_000 = 10%.
pub(crate) const IP_OWNER_SHARE: u32 = 100_000;

/// SELL-side airdrop-pool share of the (post-referral) quote fee, in
/// `FEE_SHARE_PRECISION` units. 100_000 / 1_000_000 = 10%. The treasury
/// receives the residual (80% when ip_owner + airdrop = 20%).
pub(crate) const AIRDROP_SHARE: u32 = 100_000;

/// Distributes a SELL-side (quote) fee among three recipients (4-way model;
/// referral is handled outside this function — see `apply_swap_result`).
///
/// Returns `(ip_owner, airdrop, treasury)` where
/// `ip_owner + airdrop + treasury == distributable`.
///
/// # Arguments
/// * `distributable` — total quote fee available for distribution (already
///   excludes any pre-paid referral cut).
/// * `ip_owner_share` — IP owner share, denominated in `FEE_SHARE_PRECISION`.
/// * `airdrop_share` — airdrop pool share, denominated in `FEE_SHARE_PRECISION`.
pub(crate) fn distribute_quote_fee(
    distributable: u64,
    ip_owner_share: u32,
    airdrop_share: u32,
) -> Result<(u64, u64, u64)> {
    let precision = FEE_SHARE_PRECISION as u64;

    let ip_owner: u64 = safe_mul_div_cast_u64(
        distributable,
        ip_owner_share as u64,
        precision,
        Rounding::Down,
    )?;

    let airdrop: u64 = safe_mul_div_cast_u64(
        distributable,
        airdrop_share as u64,
        precision,
        Rounding::Down,
    )?;

    let treasury = distributable.safe_sub(ip_owner)?.safe_sub(airdrop)?;

    Ok((ip_owner, airdrop, treasury))
}

/// Distributes a BUY-side (base) fee between two recipients.
///
/// Returns `(token_airdrop, ip_treasury)` where
/// `token_airdrop + ip_treasury == total_fee`.
///
/// # Arguments
/// * `total_fee` — total base fee available for distribution.
/// * `token_airdrop_share` — token airdrop pool share, denominated in
///   `FEE_SHARE_PRECISION`. Treasury gets the remainder (no rounding loss).
pub(crate) fn distribute_base_fee(total_fee: u64, token_airdrop_share: u32) -> Result<(u64, u64)> {
    let precision = FEE_SHARE_PRECISION as u64;

    let token_airdrop: u64 = safe_mul_div_cast_u64(
        total_fee,
        token_airdrop_share as u64,
        precision,
        Rounding::Down,
    )?;

    let ip_treasury = total_fee.safe_sub(token_airdrop)?;

    Ok((token_airdrop, ip_treasury))
}

/// Encodes all results of swapping
#[derive(Debug, PartialEq)]
pub struct FeeOnAmountResult {
    pub amount: u64,
    pub trading_fee: u64,
    pub protocol_fee: u64,
    pub referral_fee: u64,
}

#[zero_copy]
#[derive(Debug, InitSpace, Default)]
pub struct VolatilityTracker {
    pub last_update_timestamp: u64,
    pub padding: [u8; 8],           // Add padding for u128 alignment
    pub sqrt_price_reference: u128, // reference sqrt price
    pub volatility_accumulator: u128,
    pub volatility_reference: u128, // decayed volatility accumulator
}

const_assert_eq!(VolatilityTracker::INIT_SPACE, 64);

impl VolatilityTracker {
    // we approximate Px / Py = (1 + b) ^ delta_bin  = 1 + b * delta_bin (if b is too small)
    // Ex: (1+1/10000)^ 5000 / (1+5000 * 1/10000) = 1.1 (10% diff if sqrt_price diff is (1+1/10000)^ 5000 = 1.64 times)
    pub fn get_delta_bin_id(
        bin_step_u128: u128,
        sqrt_price_a: u128,
        sqrt_price_b: u128,
    ) -> Result<u128> {
        let (upper_sqrt_price, lower_sqrt_price) = if sqrt_price_a > sqrt_price_b {
            (sqrt_price_a, sqrt_price_b)
        } else {
            (sqrt_price_b, sqrt_price_a)
        };

        let price_ratio: u128 =
            safe_shl_div_cast(upper_sqrt_price, lower_sqrt_price, 64, Rounding::Down)?;

        let delta_bin_id = price_ratio.safe_sub(ONE_Q64)?.safe_div(bin_step_u128)?;

        Ok(delta_bin_id.safe_mul(2)?)
    }

    pub fn update_volatility_accumulator(
        &mut self,
        dynamic_fee_config: &DynamicFeeConfig,
        sqrt_price: u128,
    ) -> Result<()> {
        let delta_price = VolatilityTracker::get_delta_bin_id(
            dynamic_fee_config.bin_step_u128,
            sqrt_price,
            self.sqrt_price_reference,
        )?;

        let volatility_accumulator = self
            .volatility_reference
            .safe_add(delta_price.safe_mul(BASIS_POINT_MAX.into())?)?;

        self.volatility_accumulator = std::cmp::min(
            volatility_accumulator,
            dynamic_fee_config.max_volatility_accumulator.into(),
        );

        Ok(())
    }

    pub fn update_references(
        &mut self,
        dynamic_fee_config: &DynamicFeeConfig,
        sqrt_price_current: u128,
        current_timestamp: u64,
    ) -> Result<()> {
        // it is fine to use saturating_sub, because never a chance current_timestamp is lesser than last_update_timestamp on-chain
        // but that can benefit off-chain components for simulation when clock is not synced and pool is high frequency trading
        // furthermore, the function doesn't update fee in pre-swap, so quoting won't be affected
        let elapsed = current_timestamp.saturating_sub(self.last_update_timestamp);
        // Not high frequency trade
        if elapsed >= dynamic_fee_config.filter_period as u64 {
            // Update sqrt of last transaction
            self.sqrt_price_reference = sqrt_price_current;
            // filter period < t < decay_period. Decay time window.
            if elapsed < dynamic_fee_config.decay_period as u64 {
                let volatility_reference = self
                    .volatility_accumulator
                    .safe_mul(dynamic_fee_config.reduction_factor.into())?
                    .safe_div(BASIS_POINT_MAX.into())?;

                self.volatility_reference = volatility_reference;
            }
            // Out of decay time window
            else {
                self.volatility_reference = 0;
            }
        }
        Ok(())
    }
}

#[derive(Default, Debug)]
pub struct FeeMode {
    pub fees_on_input: bool,
    pub fees_on_base_token: bool,
    pub has_referral: bool,
}

impl FeeMode {
    pub fn get_fee_mode(
        collect_fee_mode: u8,
        trade_direction: TradeDirection,
        has_referral: bool,
    ) -> Result<FeeMode> {
        let collect_fee_mode = CollectFeeMode::try_from(collect_fee_mode)
            .map_err(|_| PoolError::InvalidCollectFeeMode)?;

        let (fees_on_input, fees_on_base_token) = match (collect_fee_mode, trade_direction) {
            // When collecting fees on output token
            (CollectFeeMode::OutputToken, TradeDirection::BaseToQuote) => (false, false),
            (CollectFeeMode::OutputToken, TradeDirection::QuoteToBase) => (false, true),

            // When collecting fees on quote token
            (CollectFeeMode::QuoteToken, TradeDirection::BaseToQuote) => (false, false),
            (CollectFeeMode::QuoteToken, TradeDirection::QuoteToBase) => (true, false),
        };

        Ok(FeeMode {
            fees_on_input,
            fees_on_base_token,
            has_referral,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // SPEC-DBC-AUDIT-001 Phase 1 (REQ-A-006): fixed fee-share constants.
    // -------------------------------------------------------------------------

    #[test]
    fn test_fixed_share_constants_have_expected_values() {
        // Unit is FEE_SHARE_PRECISION (1_000_000 == 100%), NOT basis points.
        assert_eq!(FEE_SHARE_PRECISION, 1_000_000);
        assert_eq!(TOKEN_AIRDROP_SHARE, 400_000); // 40%
        assert_eq!(IP_OWNER_SHARE, 100_000); // 10%
        assert_eq!(AIRDROP_SHARE, 100_000); // 10%
    }

    #[test]
    fn test_distribute_base_fee_uses_fixed_40_60_split() {
        // BUY side: token airdrop 40%, ip_treasury 60% residual.
        let total_fee = 1_000u64;
        let (token_airdrop, ip_treasury) =
            distribute_base_fee(total_fee, TOKEN_AIRDROP_SHARE).unwrap();
        assert_eq!(token_airdrop, 400);
        assert_eq!(ip_treasury, 600);
        // Conservation: the two sinks sum to exactly the input (single-counted).
        assert_eq!(token_airdrop.checked_add(ip_treasury).unwrap(), total_fee);
    }

    #[test]
    fn test_distribute_quote_fee_uses_fixed_10_10_residual_split() {
        // SELL side: ip_owner 10%, airdrop 10%, treasury 80% residual.
        let distributable = 1_000u64;
        let (ip_owner, airdrop, treasury) =
            distribute_quote_fee(distributable, IP_OWNER_SHARE, AIRDROP_SHARE).unwrap();
        assert_eq!(ip_owner, 100);
        assert_eq!(airdrop, 100);
        assert_eq!(treasury, 800);
        // Conservation: the three sinks sum to exactly the distributable amount.
        assert_eq!(
            ip_owner
                .checked_add(airdrop)
                .unwrap()
                .checked_add(treasury)
                .unwrap(),
            distributable
        );
    }

    #[test]
    fn test_distribute_quote_fee_residual_absorbs_rounding_dust() {
        // With an amount not divisible by the precision, ip_owner/airdrop round
        // down and the treasury (residual) absorbs the dust; total is preserved.
        let distributable = 1_001u64;
        let (ip_owner, airdrop, treasury) =
            distribute_quote_fee(distributable, IP_OWNER_SHARE, AIRDROP_SHARE).unwrap();
        // floor(1001 * 0.10) == 100 for each.
        assert_eq!(ip_owner, 100);
        assert_eq!(airdrop, 100);
        assert_eq!(treasury, 801);
        assert_eq!(
            ip_owner
                .checked_add(airdrop)
                .unwrap()
                .checked_add(treasury)
                .unwrap(),
            distributable
        );
    }

    #[test]
    fn test_fee_mode_output_token_base_to_quote() {
        let fee_mode = FeeMode::get_fee_mode(
            CollectFeeMode::OutputToken as u8,
            TradeDirection::BaseToQuote,
            false,
        )
        .unwrap();

        assert_eq!(fee_mode.fees_on_input, false);
        assert_eq!(fee_mode.fees_on_base_token, false);
        assert_eq!(fee_mode.has_referral, false);
    }

    #[test]
    fn test_fee_mode_output_token_quote_to_base() {
        let fee_mode = FeeMode::get_fee_mode(
            CollectFeeMode::OutputToken as u8,
            TradeDirection::QuoteToBase,
            true,
        )
        .unwrap();

        assert_eq!(fee_mode.fees_on_input, false);
        assert_eq!(fee_mode.fees_on_base_token, true);
        assert_eq!(fee_mode.has_referral, true);
    }

    #[test]
    fn test_fee_mode_quote_token_base_to_quote() {
        let fee_mode = FeeMode::get_fee_mode(
            CollectFeeMode::QuoteToken as u8,
            TradeDirection::BaseToQuote,
            false,
        )
        .unwrap();

        assert_eq!(fee_mode.fees_on_input, false);
        assert_eq!(fee_mode.fees_on_base_token, false);
        assert_eq!(fee_mode.has_referral, false);
    }

    #[test]
    fn test_fee_mode_quote_token_quote_to_base() {
        let fee_mode = FeeMode::get_fee_mode(
            CollectFeeMode::QuoteToken as u8,
            TradeDirection::QuoteToBase,
            true,
        )
        .unwrap();

        assert_eq!(fee_mode.fees_on_input, true);
        assert_eq!(fee_mode.fees_on_base_token, false);
        assert_eq!(fee_mode.has_referral, true);
    }

    #[test]
    fn test_invalid_collect_fee_mode() {
        let result = FeeMode::get_fee_mode(
            2, // Invalid mode
            TradeDirection::QuoteToBase,
            false,
        );

        assert!(result.is_err());
    }

    #[test]
    fn test_fee_mode_default() {
        let fee_mode = FeeMode::default();

        assert_eq!(fee_mode.fees_on_input, false);
        assert_eq!(fee_mode.fees_on_base_token, false);
        assert_eq!(fee_mode.has_referral, false);
    }

    // Property-based test to ensure consistent behavior
    #[test]
    fn test_fee_mode_properties() {
        // When trading BaseToQuote, fees should never be on input
        let fee_mode = FeeMode::get_fee_mode(
            CollectFeeMode::QuoteToken as u8,
            TradeDirection::BaseToQuote,
            true,
        )
        .unwrap();
        assert_eq!(fee_mode.fees_on_input, false);

        // When using QuoteToken mode, base_token should always be false
        let fee_mode = FeeMode::get_fee_mode(
            CollectFeeMode::QuoteToken as u8,
            TradeDirection::QuoteToBase,
            false,
        )
        .unwrap();
        assert_eq!(fee_mode.fees_on_base_token, false);
    }
}
