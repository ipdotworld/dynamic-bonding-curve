use anchor_lang::prelude::*;
use static_assertions::const_assert_eq;

use crate::error::VaultError;

/// Per-token-mint vesting record.
///
/// PDA seeds: `[b"vesting", token_mint.as_ref()]`.
///
/// Layout (all fields aligned naturally — no implicit padding):
///   token_mint                        : 32 bytes
///   total_deposited                   :  8 bytes
///   total_claimed                     :  8 bytes
///   vesting_start_unix_timestamp      :  8 bytes
///   bump                              :  1 byte
///   _padding                          : 63 bytes (reserved for future fields)
///   ──────────────────────────────────────────────
///   Total                             : 120 bytes (multiple of 8 → no Pod tail padding)
///
/// SPEC-DBC-004 Phase 6 (REQ-I-003).
#[account(zero_copy(unsafe))]
#[repr(C)]
#[derive(Debug)]
pub struct Vault {
    /// SPL/Token-2022 mint this vault accumulates for.
    /// Validated against the `token_mint` account in every instruction.
    pub token_mint: Pubkey,

    /// Total quote tokens DBC has handed off to the vault since creation.
    /// Monotonically increasing — never reset by subsequent deposits.
    pub total_deposited: u64,

    /// Total quote tokens already drained by `claim_vested`. Bounded above by
    /// `released_amount(now, VESTING_DURATION_SECONDS)`.
    pub total_claimed: u64,

    /// Unix timestamp captured on the FIRST `distribute_to_vault` call.
    /// Subsequent deposits do not reset the clock — the SPEC enforces a single
    /// global vesting curve that begins when the IP owner first earns fees.
    /// `0` until first deposit.
    pub vesting_start_unix_timestamp: i64,

    /// PDA bump.
    pub bump: u8,

    /// Reserved padding for future extensions (e.g. multi-stage vesting,
    /// per-deposit cliffs). Held flat so adding a field later does NOT bump
    /// `INIT_SPACE` and break on-chain account allocations.
    pub _padding: [u8; 63],
}

impl Vault {
    /// Discriminator-less account size (Anchor adds the 8-byte discriminator
    /// outside `INIT_SPACE`; pass `space = 8 + Vault::INIT_SPACE` to `init`).
    pub const INIT_SPACE: usize = 32 + 8 + 8 + 8 + 1 + 63;

    /// Released amount under the linear vesting formula:
    ///
    ///   released = total_deposited * min(elapsed, duration) / duration
    ///
    /// Returns `0` if `total_deposited == 0` (no deposit yet) or if
    /// `now < vesting_start`. Clamps to `total_deposited` after the full
    /// duration has elapsed.
    ///
    /// Note: the function uses `total_deposited == 0` as the "uninitialized"
    /// predicate (NOT `vesting_start_unix_timestamp == 0`), because some
    /// environments (e.g. LiteSVM at boot) operate at unix_timestamp == 0
    /// legitimately, and we want vesting to begin immediately.
    ///
    /// Uses `u128` intermediate to avoid overflow at `u64::MAX` deposit.
    pub fn released_amount(&self, now: i64, duration: i64) -> u64 {
        if self.total_deposited == 0 || now < self.vesting_start_unix_timestamp {
            return 0;
        }

        // Defensive: caller must guarantee duration > 0; treat duration <= 0 as "fully released".
        if duration <= 0 {
            return self.total_deposited;
        }

        // Clamp elapsed to [0, duration] so the formula caps at total_deposited.
        let raw_elapsed = now.saturating_sub(self.vesting_start_unix_timestamp);
        let elapsed = if raw_elapsed > duration {
            duration
        } else {
            raw_elapsed
        };

        let total = self.total_deposited as u128;
        let elapsed_u128 = elapsed as u128;
        let duration_u128 = duration as u128;

        // total * elapsed / duration — u128 absorbs the multiplication safely.
        let released = total
            .checked_mul(elapsed_u128)
            .and_then(|v| v.checked_div(duration_u128))
            .unwrap_or(0);

        // Saturate down to u64::MAX (cannot exceed total_deposited mathematically).
        if released > u64::MAX as u128 {
            u64::MAX
        } else {
            released as u64
        }
    }

    /// Claimable = released - already_claimed. Saturates at 0 (cannot go negative).
    pub fn claimable_amount(&self, now: i64, duration: i64) -> u64 {
        let released = self.released_amount(now, duration);
        released.saturating_sub(self.total_claimed)
    }

    /// Stamp `vesting_start_unix_timestamp` only if this is the first deposit.
    /// Returns `true` iff the clock was newly stamped on this call.
    pub fn stamp_clock_on_first_deposit(&mut self, now: i64) -> bool {
        if self.total_deposited == 0 && self.vesting_start_unix_timestamp == 0 {
            self.vesting_start_unix_timestamp = now;
            true
        } else {
            false
        }
    }

    /// Add `amount` to `total_deposited` with overflow protection.
    pub fn add_deposit(&mut self, amount: u64) -> Result<()> {
        self.total_deposited = self
            .total_deposited
            .checked_add(amount)
            .ok_or(error!(VaultError::MathOverflow))?;
        Ok(())
    }

    /// Add `amount` to `total_claimed` with overflow protection.
    pub fn add_claim(&mut self, amount: u64) -> Result<()> {
        self.total_claimed = self
            .total_claimed
            .checked_add(amount)
            .ok_or(error!(VaultError::MathOverflow))?;
        Ok(())
    }
}

// Compile-time guard: any layout regression flips this assertion at build time.
const_assert_eq!(Vault::INIT_SPACE, 120);

// Manual Default impl — derive(Default) does not handle `[u8; 63]` because
// `Default` is implemented for arrays only up to length 32 in core.
impl Default for Vault {
    fn default() -> Self {
        Self {
            token_mint: Pubkey::default(),
            total_deposited: 0,
            total_claimed: 0,
            vesting_start_unix_timestamp: 0,
            bump: 0,
            _padding: [0u8; 63],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::VESTING_DURATION_SECONDS;

    fn make_vault(total_deposited: u64, total_claimed: u64, vesting_start: i64) -> Vault {
        Vault {
            token_mint: Pubkey::default(),
            total_deposited,
            total_claimed,
            vesting_start_unix_timestamp: vesting_start,
            bump: 0,
            _padding: [0u8; 63],
        }
    }

    #[test]
    fn released_amount_zero_when_no_deposit() {
        // Empty vault (total_deposited == 0) → always 0 regardless of clock.
        let vault = make_vault(0, 0, 1_700_000_000);
        assert_eq!(vault.released_amount(1_700_000_000, VESTING_DURATION_SECONDS), 0);
        assert_eq!(
            vault.released_amount(
                1_700_000_000 + VESTING_DURATION_SECONDS,
                VESTING_DURATION_SECONDS
            ),
            0
        );
    }

    #[test]
    fn released_amount_at_vesting_start_returns_zero() {
        let start = 1_700_000_000_i64;
        let vault = make_vault(1_000_000_000, 0, start);
        // now == start → elapsed=0 → released=0
        assert_eq!(vault.released_amount(start, VESTING_DURATION_SECONDS), 0);
    }

    #[test]
    fn released_amount_at_half_duration_returns_half() {
        let start = 1_700_000_000_i64;
        let vault = make_vault(1_000_000_000, 0, start);
        let half = start + VESTING_DURATION_SECONDS / 2;
        // 1B * (DURATION/2) / DURATION = 500M
        assert_eq!(vault.released_amount(half, VESTING_DURATION_SECONDS), 500_000_000);
    }

    #[test]
    fn released_amount_at_full_duration_returns_total() {
        let start = 1_700_000_000_i64;
        let vault = make_vault(1_000_000_000, 0, start);
        let full = start + VESTING_DURATION_SECONDS;
        assert_eq!(vault.released_amount(full, VESTING_DURATION_SECONDS), 1_000_000_000);
    }

    #[test]
    fn released_amount_after_full_duration_clamps() {
        let start = 1_700_000_000_i64;
        let vault = make_vault(1_000_000_000, 0, start);
        let way_past = start + VESTING_DURATION_SECONDS * 100;
        // Clamps to total_deposited regardless of how far in the future now is.
        assert_eq!(vault.released_amount(way_past, VESTING_DURATION_SECONDS), 1_000_000_000);
    }

    #[test]
    fn released_amount_overflow_safe_at_u64_max_deposit() {
        let start = 1_700_000_000_i64;
        let vault = make_vault(u64::MAX, 0, start);
        let half = start + VESTING_DURATION_SECONDS / 2;
        // u64::MAX * (DURATION/2) overflows u64 but NOT u128.
        // Expected: floor(u64::MAX / 2) = 9223372036854775807 (close enough; integer-divided).
        let half_amount = vault.released_amount(half, VESTING_DURATION_SECONDS);
        let expected = (u64::MAX as u128) * ((VESTING_DURATION_SECONDS / 2) as u128)
            / (VESTING_DURATION_SECONDS as u128);
        assert_eq!(half_amount as u128, expected);
        // Sanity: must be approximately half of u64::MAX.
        assert!(half_amount > u64::MAX / 2 - 10);
        assert!(half_amount < u64::MAX / 2 + 10);
    }

    #[test]
    fn released_amount_now_before_start_returns_zero() {
        let start = 1_700_000_000_i64;
        let vault = make_vault(1_000_000_000, 0, start);
        // now < vesting_start → 0
        assert_eq!(vault.released_amount(start - 100, VESTING_DURATION_SECONDS), 0);
    }

    #[test]
    fn claimable_amount_subtracts_already_claimed() {
        let start = 1_700_000_000_i64;
        // 1B deposited, 200M already claimed
        let vault = make_vault(1_000_000_000, 200_000_000, start);
        let half = start + VESTING_DURATION_SECONDS / 2;
        // released = 500M; claimable = 500M - 200M = 300M
        assert_eq!(vault.claimable_amount(half, VESTING_DURATION_SECONDS), 300_000_000);
    }

    #[test]
    fn claimable_amount_saturates_at_zero_when_overclaimed() {
        let start = 1_700_000_000_i64;
        // Pathological: total_claimed > released (shouldn't occur in practice but math must not panic).
        let vault = make_vault(1_000_000_000, 600_000_000, start);
        let half = start + VESTING_DURATION_SECONDS / 2;
        // released = 500M, total_claimed = 600M → saturating_sub = 0.
        assert_eq!(vault.claimable_amount(half, VESTING_DURATION_SECONDS), 0);
    }

    #[test]
    fn vault_init_idempotent_on_second_deposit() {
        let mut vault = make_vault(0, 0, 0);
        let first_now = 1_700_000_000_i64;
        let second_now = first_now + 1_000_000;

        let stamped_first = vault.stamp_clock_on_first_deposit(first_now);
        vault.add_deposit(1_000_000_000).unwrap();
        assert!(stamped_first);
        assert_eq!(vault.vesting_start_unix_timestamp, first_now);

        // Second deposit must NOT reset the clock.
        let stamped_second = vault.stamp_clock_on_first_deposit(second_now);
        vault.add_deposit(500_000_000).unwrap();
        assert!(!stamped_second);
        assert_eq!(vault.vesting_start_unix_timestamp, first_now);
        assert_eq!(vault.total_deposited, 1_500_000_000);
    }

    #[test]
    fn add_deposit_overflow_returns_error() {
        let mut vault = make_vault(u64::MAX, 0, 1);
        assert!(vault.add_deposit(1).is_err());
    }

    #[test]
    fn add_claim_overflow_returns_error() {
        let mut vault = make_vault(u64::MAX, u64::MAX, 1);
        assert!(vault.add_claim(1).is_err());
    }

    #[test]
    fn init_space_is_120() {
        // Hard regression guard against layout drift.
        assert_eq!(Vault::INIT_SPACE, 120);
    }
}
