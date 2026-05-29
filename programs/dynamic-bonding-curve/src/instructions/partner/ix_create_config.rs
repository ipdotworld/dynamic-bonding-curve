use std::u128;

use anchor_lang::{prelude::*, solana_program::clock::SECONDS_PER_DAY};
use anchor_spl::token_interface::Mint;
use damm_v2::constants::MAX_BASIS_POINT;
use locker::types::CreateVestingEscrowParameters;
use static_assertions::const_assert_eq;

use crate::{
    activation_handler::ActivationType,
    constants::{
        fee::{MAX_POOL_CREATION_FEE, MIN_POOL_CREATION_FEE, PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS},
        MAX_CURVE_POINT, MAX_LOCK_DURATION_IN_SECONDS, MAX_MIGRATED_POOL_FEE_BPS,
        MAX_MIGRATION_FEE_PERCENTAGE, MAX_SQRT_PRICE, MIN_LOCKED_LIQUIDITY_BPS,
        MIN_MIGRATED_POOL_FEE_BPS, MIN_SQRT_PRICE, TOKEN_VESTING_NUMBER_OF_PERIODS,
        TOKEN_VESTING_PERIOD_FREQUENCY,
    },
    state::config::FEE_SHARE_PRECISION,
    damm_v2_utils::{
        validate_vesting_parameters, BaseFeeMode as DammV2BaseFeeMode, DammV2DynamicFee,
        DammV2PodAlignedFeeMarketCapScheduler,
    },
    migration_handler::{
        get_migration_handler, CompoundingLiquidity, MigratedCollectFeeMode, MigrationHandler,
    },
    params::{
        fee_parameters::{to_numerator, PoolFeeParameters},
        liquidity_distribution::{
            get_base_token_for_swap, get_migration_threshold_price, LiquidityDistributionParameters,
        },
    },
    safe_math::{SafeCast, SafeMath},
    state::{
        CollectFeeMode, LiquidityVestingInfo, LockedVestingConfig, MigrationFeeOption,
        MigrationOption, PoolConfig, TokenAuthorityOption, TokenType,
    },
    token::{get_token_program_flags, is_supported_quote_mint},
    u128x128_math::Rounding,
    utils_math::safe_mul_div_cast_u128,
    EvtCreateConfig, EvtCreateConfigV2, PoolError,
};

#[derive(AnchorSerialize, AnchorDeserialize, Debug, Clone)]
pub struct ConfigParameters {
    pub pool_fees: PoolFeeParameters,
    pub collect_fee_mode: u8,
    pub migration_option: u8,
    pub activation_type: u8,
    pub token_type: u8,
    pub token_decimal: u8,
    pub partner_liquidity_percentage: u8,
    pub partner_permanent_locked_liquidity_percentage: u8,
    pub creator_liquidity_percentage: u8,
    pub creator_permanent_locked_liquidity_percentage: u8,
    pub migration_quote_threshold: u64,
    pub sqrt_start_price: u128,
    pub locked_vesting: LockedVestingParams,
    pub migration_fee_option: u8,
    pub token_supply: Option<TokenSupplyParams>,
    pub creator_trading_fee_percentage: u8, // percentage of trading fee creator can share with partner
    pub token_update_authority: u8,
    pub migration_fee: MigrationFee,
    pub migrated_pool_fee: MigratedPoolFee,
    /// pool creation fee in SOL lamports value
    pub pool_creation_fee: u64,
    pub partner_liquidity_vesting_info: LiquidityVestingInfoParams,
    pub creator_liquidity_vesting_info: LiquidityVestingInfoParams,
    pub migrated_pool_base_fee_mode: u8,
    pub migrated_pool_market_cap_fee_scheduler_params: MigratedPoolMarketCapFeeSchedulerParams,
    pub enable_first_swap_with_min_fee: bool,
    pub compounding_fee_bps: u16,
    /// padding for future use
    pub padding: [u8; 2],
    pub curve: Vec<LiquidityDistributionParameters>,
    /// IPWorld fee shares (in FEE_SHARE_PRECISION = 1_000_000 units)
    /// ip_owner_share + airdrop_share + referral_share must be < 1_000_000
    /// (SPEC-DBC-004 Phase 3 — REQ-I-001: `creator_share` removed from the
    /// IPWorld 4-way SELL fee model)
    pub ip_owner_share: u32,
    pub airdrop_share: u32,
    pub referral_share: u32,
    /// token_airdrop_share must be < 1_000_000 (independent of quote fee shares)
    pub token_airdrop_share: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, InitSpace)]
pub struct MigrationFee {
    pub fee_percentage: u8,
    pub creator_fee_percentage: u8,
}
const_assert_eq!(MigrationFee::INIT_SPACE, 2);

impl MigrationFee {
    pub fn validate(&self) -> Result<()> {
        require!(
            self.fee_percentage <= MAX_MIGRATION_FEE_PERCENTAGE,
            PoolError::InvalidMigratorFeePercentage
        );
        if self.fee_percentage == 0 {
            require!(
                self.creator_fee_percentage == 0,
                PoolError::InvalidMigratorFeePercentage
            );
        } else {
            require!(
                self.creator_fee_percentage <= 100,
                PoolError::InvalidMigratorFeePercentage
            );
        }
        Ok(())
    }
}

pub struct MigratedPoolFeeValidator {
    pub collect_fee_mode: u8,
    pub dynamic_fee: u8,
    pub pool_fee_bps: u16,
    pub compounding_fee_bps: u16,
    pub migrated_pool_base_fee_mode: u8,
    pub number_of_period: u16,
    pub sqrt_price_step_bps: u16,
    pub scheduler_expiration_duration: u32,
    pub reduction_factor: u64,
}

impl MigratedPoolFeeValidator {
    pub fn new(
        migrated_pool_fee: &MigratedPoolFee,
        compounding_fee_bps: u16,
        migrated_pool_market_cap_fee_scheduler_params: &MigratedPoolMarketCapFeeSchedulerParams,
        migrated_pool_base_fee_mode: u8,
    ) -> Self {
        Self {
            collect_fee_mode: migrated_pool_fee.collect_fee_mode,
            dynamic_fee: migrated_pool_fee.dynamic_fee,
            pool_fee_bps: migrated_pool_fee.pool_fee_bps,
            compounding_fee_bps,
            migrated_pool_base_fee_mode,
            number_of_period: migrated_pool_market_cap_fee_scheduler_params.number_of_period,
            sqrt_price_step_bps: migrated_pool_market_cap_fee_scheduler_params.sqrt_price_step_bps,
            scheduler_expiration_duration: migrated_pool_market_cap_fee_scheduler_params
                .scheduler_expiration_duration,
            reduction_factor: migrated_pool_market_cap_fee_scheduler_params.reduction_factor,
        }
    }

    pub fn is_none(&self) -> bool {
        self.collect_fee_mode == 0
            && self.dynamic_fee == 0
            && self.pool_fee_bps == 0
            && self.compounding_fee_bps == 0
            && self.migrated_pool_base_fee_mode == 0
            && self.number_of_period == 0
            && self.sqrt_price_step_bps == 0
            && self.scheduler_expiration_duration == 0
            && self.reduction_factor == 0
    }

    pub fn validate(&self) -> Result<()> {
        require!(
            self.pool_fee_bps >= MIN_MIGRATED_POOL_FEE_BPS
                && self.pool_fee_bps <= MAX_MIGRATED_POOL_FEE_BPS,
            PoolError::InvalidMigratedPoolFee
        );

        // SPEC-DBC-004 REQ-I-002: IPWorld enforces DAMM v2 OnlyB and zero compounding
        // on the migrated pool. The DBC `MigratedCollectFeeMode::QuoteToken` (value 0)
        // is what maps to DAMM v2 OnlyB (value 1) per migration_handler::to_dammv2.
        // The SPEC text references "1 (OnlyB)" using DAMM v2's numeric value; the DBC
        // field stores the DBC enum value, so QuoteToken (==0) is the OnlyB-equivalent.
        let migrated_collect_fee_mode = self.collect_fee_mode;
        let migrated_compounding_fee_bps = self.compounding_fee_bps;
        require!(
            migrated_collect_fee_mode == MigratedCollectFeeMode::QuoteToken as u8,
            PoolError::InvalidMigratedFeeConfig
        );
        require!(
            migrated_compounding_fee_bps == 0,
            PoolError::InvalidMigratedFeeConfig
        );

        // validate collect fee mode
        let migrated_collect_fee_mode = MigratedCollectFeeMode::try_from(self.collect_fee_mode)
            .map_err(|_| PoolError::InvalidCollectFeeMode)?;

        match migrated_collect_fee_mode {
            MigratedCollectFeeMode::Compounding => {
                require!(
                    self.compounding_fee_bps > 0 && self.compounding_fee_bps <= MAX_BASIS_POINT,
                    PoolError::InvalidMigratedPoolFee
                );
            }
            _ => {
                require!(
                    self.compounding_fee_bps == 0,
                    PoolError::InvalidMigratedPoolFee
                );
            }
        }
        // validate migrated dynamic fee option
        require!(
            DammV2DynamicFee::try_from(self.dynamic_fee).is_ok(),
            PoolError::InvalidMigratedPoolFee
        );

        let migrated_base_fee_mode = DammV2BaseFeeMode::try_from(self.migrated_pool_base_fee_mode)
            .map_err(|_| PoolError::TypeCastFailed)?;

        match migrated_base_fee_mode {
            // Old behavior is fixed fee bps for migrated pool
            DammV2BaseFeeMode::FeeTimeSchedulerLinear
            | DammV2BaseFeeMode::FeeTimeSchedulerExponential => {
                require!(
                    self.number_of_period == 0
                        && self.sqrt_price_step_bps == 0
                        && self.scheduler_expiration_duration == 0
                        && self.reduction_factor == 0,
                    PoolError::InvalidMigratedPoolFee
                );
            }
            DammV2BaseFeeMode::FeeMarketCapSchedulerExponential
            | DammV2BaseFeeMode::FeeMarketCapSchedulerLinear => {
                let cliff_fee_numerator = to_numerator(
                    self.pool_fee_bps.into(),
                    damm_v2::constants::FEE_DENOMINATOR.into(),
                )?;

                let market_cap_fee_scheduler = DammV2PodAlignedFeeMarketCapScheduler(
                    damm_v2::accounts::PodAlignedFeeMarketCapScheduler {
                        cliff_fee_numerator,
                        base_fee_mode: self.migrated_pool_base_fee_mode,
                        number_of_period: self.number_of_period,
                        sqrt_price_step_bps: self.sqrt_price_step_bps.into(),
                        scheduler_expiration_duration: self.scheduler_expiration_duration,
                        reduction_factor: self.reduction_factor,
                        padding: [0; 5],
                    },
                );

                market_cap_fee_scheduler.validate()?;
            }
            _ => {
                return Err(PoolError::InvalidMigratedPoolFee.into());
            }
        }

        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, InitSpace)]
pub struct MigratedPoolFee {
    pub collect_fee_mode: u8,
    pub dynamic_fee: u8,
    pub pool_fee_bps: u16,
}
const_assert_eq!(MigratedPoolFee::INIT_SPACE, 4);

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, InitSpace)]
pub struct MigratedPoolMarketCapFeeSchedulerParams {
    pub number_of_period: u16,
    pub sqrt_price_step_bps: u16,
    pub scheduler_expiration_duration: u32,
    pub reduction_factor: u64,
}

const_assert_eq!(MigratedPoolMarketCapFeeSchedulerParams::INIT_SPACE, 16);

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct TokenSupplyParams {
    /// pre migration token supply
    pub pre_migration_token_supply: u64,
    /// post migration token supply
    /// because DBC allow user to swap over the migration quote threshold, so in extreme case user may swap more than allowed buffer on curve
    /// that result the total supply in post migration may be increased a bit (between pre_migration_token_supply and post_migration_token_supply)
    pub post_migration_token_supply: u64,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct LockedVestingParams {
    pub amount_per_period: u64,
    pub cliff_duration_from_migration_time: u64,
    pub frequency: u64,
    pub number_of_period: u64,
    pub cliff_unlock_amount: u64,
}

impl LockedVestingParams {
    pub fn to_locked_vesting_config(&self) -> LockedVestingConfig {
        LockedVestingConfig {
            amount_per_period: self.amount_per_period,
            cliff_duration_from_migration_time: self.cliff_duration_from_migration_time,
            frequency: self.frequency,
            number_of_period: self.number_of_period,
            cliff_unlock_amount: self.cliff_unlock_amount,
            ..Default::default()
        }
    }

    /// Builds the Meteora locker escrow params for the migration token-allocation
    /// vesting.
    ///
    /// SPEC-DBC-AUDIT-001 REQ-C-001 (AC-C-001): the token allocation vests **linearly
    /// over a fixed 180 days, with no cliff, anchored to the migration (finish-curve)
    /// timestamp**. The duration is enforced by program constants
    /// (`TOKEN_VESTING_PERIOD_FREQUENCY * TOKEN_VESTING_NUMBER_OF_PERIODS == 180 days`)
    /// and is NO LONGER taken from the mutable per-pool `LockedVestingConfig`
    /// (`frequency` / `number_of_period` / `cliff_duration_from_migration_time`), so the
    /// effective vesting duration cannot be misconfigured. This mirrors the EVM
    /// `IPOwnerVault.sol` linear-no-cliff token vesting.
    ///
    /// The TOTAL vested amount and the RECIPIENT are preserved: the locker debits
    /// exactly `cliff_unlock_amount + amount_per_period * number_of_period` from the
    /// base vault (`CreateVestingEscrowParameters::get_total_deposit_amount`), and we
    /// keep that sum bit-for-bit equal to the configured `get_total_amount()`. The
    /// schedule is made fully linear by spreading the total evenly across 180 daily
    /// periods; the sub-`number_of_periods` integer-division remainder (`0..179` base
    /// units — rounding dust, NOT an economic cliff) is placed in `cliff_unlock_amount`
    /// at `cliff_time == vesting_start_time` so the deposited total stays exact.
    ///
    /// `no cliff` ⇒ `cliff_time == vesting_start_time` (no time delay) and
    /// `cliff_unlock_amount < number_of_period` (no meaningful upfront unlock).
    pub fn to_create_vesting_escrow_params(
        &self,
        finish_curve_timestamp: u64,
    ) -> Result<CreateVestingEscrowParameters> {
        // Preserve the configured total token allocation exactly.
        let total_amount = self.get_total_amount()?;

        // Fully linear over 180 daily periods. Floor-divide and place the remainder at
        // the (zero-delay) cliff so the locker's deposited total == total_amount.
        let amount_per_period = total_amount.safe_div(TOKEN_VESTING_NUMBER_OF_PERIODS)?;
        let cliff_unlock_amount =
            total_amount.safe_sub(amount_per_period.safe_mul(TOKEN_VESTING_NUMBER_OF_PERIODS)?)?;

        Ok(CreateVestingEscrowParameters {
            // Anchored to the migration / finish-curve timestamp.
            vesting_start_time: finish_curve_timestamp,
            // No cliff: cliff_time == vesting_start_time (no delay).
            cliff_time: finish_curve_timestamp,
            // Fixed 180-day linear schedule (program constants, not config).
            frequency: TOKEN_VESTING_PERIOD_FREQUENCY,
            number_of_period: TOKEN_VESTING_NUMBER_OF_PERIODS,
            amount_per_period,
            // Rounding remainder only (`< number_of_period`); not an economic cliff.
            cliff_unlock_amount,
            update_recipient_mode: 2, // only recipient
            // SPEC-DBC-AUDIT-001 REQ-C-001 (AC-C-001): "no clawback".
            // `cancel_mode = 0` (CancelMode::NeitherCreatorOrRecipient) means NO ONE can
            // cancel the escrow — the creator cannot reclaim unvested tokens early (no rug
            // of their own vesting). The Meteora locker gates cancellation on
            // `cancel_mode & signer_flag(signer) > 0`, which is always false when
            // cancel_mode == 0, so cancellation is impossible. Do NOT change back to 1
            // ("only creator"), which would reintroduce a clawback path. This value is the
            // one consumed by the `create_locker` CPI (instructions/migration/create_locker.rs).
            cancel_mode: 0,
        })
    }

    pub fn get_total_amount(&self) -> Result<u64> {
        let total_amount = self
            .cliff_unlock_amount
            .safe_add(self.amount_per_period.safe_mul(self.number_of_period)?)?;
        Ok(total_amount)
    }

    pub fn has_vesting(&self) -> bool {
        *self != LockedVestingParams::default()
    }
    pub fn validate(&self) -> Result<()> {
        if self.has_vesting() {
            let total_amount = self.get_total_amount()?;
            require!(
                self.frequency != 0 && total_amount != 0,
                PoolError::InvalidVestingParameters
            );
        }
        Ok(())
    }
}

#[derive(
    AnchorSerialize, AnchorDeserialize, Debug, Clone, Copy, InitSpace, Default, PartialEq, Eq,
)]
pub struct LiquidityVestingInfoParams {
    pub vesting_percentage: u8,
    pub bps_per_period: u16,
    pub number_of_periods: u16,
    pub cliff_duration_from_migration_time: u32,
    pub frequency: u32,
}

const_assert_eq!(LiquidityVestingInfoParams::INIT_SPACE, 13);

impl LiquidityVestingInfoParams {
    pub fn is_zero(&self) -> bool {
        *self == LiquidityVestingInfoParams::default()
    }

    pub fn validate(&self, current_timestamp: u64) -> Result<()> {
        if self.is_zero() {
            return Ok(());
        }

        let liquidity_vesting_info = self.to_liquidity_vesting_info();

        let total_vested_liquidity = safe_mul_div_cast_u128(
            u128::MAX, // just assume total liquidity is u128::MAX
            self.vesting_percentage.into(),
            100,
            Rounding::Down,
        )?;
        let vesting_parameters = liquidity_vesting_info
            .get_damm_v2_vesting_parameters(total_vested_liquidity, current_timestamp)?;

        validate_vesting_parameters(
            &vesting_parameters,
            current_timestamp,
            MAX_LOCK_DURATION_IN_SECONDS,
        )?;

        Ok(())
    }

    fn to_liquidity_vesting_info(self) -> LiquidityVestingInfo {
        let is_initialized = if self.is_zero() { 0 } else { 1 };
        LiquidityVestingInfo {
            is_initialized,
            vesting_percentage: self.vesting_percentage,
            cliff_duration_from_migration_time: self.cliff_duration_from_migration_time,
            bps_per_period: self.bps_per_period,
            frequency: self.frequency,
            number_of_periods: self.number_of_periods,
            ..Default::default()
        }
    }
}

impl ConfigParameters {
    pub fn validate<'info>(
        &self,
        quote_mint: &InterfaceAccount<'info, Mint>,
        current_timestamp: u64,
    ) -> Result<()> {
        // validate quote mint
        require!(
            is_supported_quote_mint(quote_mint)?,
            PoolError::InvalidQuoteMint
        );

        let activation_type = ActivationType::try_from(self.activation_type)
            .map_err(|_| PoolError::TypeCastFailed)?;

        // validate fee
        self.pool_fees
            .validate(self.collect_fee_mode, activation_type)?;

        // validate creator trading fee percentage
        require!(
            self.creator_trading_fee_percentage <= 100,
            PoolError::InvalidCreatorTradingFeePercentage
        );

        self.migration_fee.validate()?;

        // validate collect fee mode
        require!(
            CollectFeeMode::try_from(self.collect_fee_mode).is_ok(),
            PoolError::InvalidCollectFeeMode
        );
        // IPWorld requires OutputToken mode for dual-stream fee distribution
        let collect_fee_mode_enum = CollectFeeMode::try_from(self.collect_fee_mode)
            .map_err(|_| PoolError::InvalidCollectFeeMode)?;
        require!(
            collect_fee_mode_enum == CollectFeeMode::OutputToken,
            PoolError::InvalidCollectFeeMode
        );
        // validate migration option and token type
        let migration_option_value = MigrationOption::try_from(self.migration_option)
            .map_err(|_| PoolError::InvalidMigrationOption)?;

        // validate migrate fee option
        let migration_fee_option = MigrationFeeOption::try_from(self.migration_fee_option)
            .map_err(|_| PoolError::InvalidMigrationFeeOption)?;

        let _token_type_value =
            TokenType::try_from(self.token_type).map_err(|_| PoolError::InvalidTokenType)?;

        let migrated_pool_fee_validator = MigratedPoolFeeValidator::new(
            &self.migrated_pool_fee,
            self.compounding_fee_bps,
            &self.migrated_pool_market_cap_fee_scheduler_params,
            self.migrated_pool_base_fee_mode,
        );

        match migration_option_value {
            MigrationOption::MeteoraDammDisabled => {
                return Err(PoolError::InvalidMigrationOption.into());
            }
            MigrationOption::DammV2 => {
                if migration_fee_option == MigrationFeeOption::Customizable {
                    migrated_pool_fee_validator.validate()?;
                } else {
                    require!(
                        migrated_pool_fee_validator.is_none(),
                        PoolError::InvalidMigratedPoolFee
                    );
                }
                // validate vesting
                self.partner_liquidity_vesting_info
                    .validate(current_timestamp)?;
                self.creator_liquidity_vesting_info
                    .validate(current_timestamp)?;
            }
        }

        // validate token update authority
        require!(
            TokenAuthorityOption::try_from(self.token_update_authority).is_ok(),
            PoolError::InvalidTokenAuthorityOption
        );

        // validate token decimals
        require!(
            self.token_decimal >= 6 && self.token_decimal <= 9,
            PoolError::InvalidTokenDecimals
        );

        let sum_liquidity_percentage = self
            .partner_liquidity_percentage
            .safe_add(self.partner_permanent_locked_liquidity_percentage)?
            .safe_add(self.creator_liquidity_percentage)?
            .safe_add(self.creator_permanent_locked_liquidity_percentage)?
            .safe_add(self.partner_liquidity_vesting_info.vesting_percentage)?
            .safe_add(self.creator_liquidity_vesting_info.vesting_percentage)?;
        require!(
            sum_liquidity_percentage == 100,
            PoolError::InvalidFeePercentage
        );

        require!(
            self.migration_quote_threshold > 0,
            PoolError::InvalidQuoteThreshold
        );

        // validate vesting params
        self.locked_vesting.validate()?;

        // validate pool creation fee
        if self.pool_creation_fee > 0 {
            require!(
                self.pool_creation_fee >= MIN_POOL_CREATION_FEE
                    && self.pool_creation_fee <= MAX_POOL_CREATION_FEE,
                PoolError::InvalidPoolCreationFee
            )
        }

        // validate price and liquidity
        require!(
            self.sqrt_start_price >= MIN_SQRT_PRICE && self.sqrt_start_price < MAX_SQRT_PRICE,
            PoolError::InvalidCurve
        );
        let curve_length = self.curve.len();
        require!(
            curve_length > 0 && curve_length <= MAX_CURVE_POINT,
            PoolError::InvalidCurve
        );
        require!(
            self.curve[0].sqrt_price > self.sqrt_start_price
                && self.curve[0].liquidity > 0
                && self.curve[0].sqrt_price <= MAX_SQRT_PRICE,
            PoolError::InvalidCurve
        );

        for i in 1..curve_length {
            require!(
                self.curve[i].sqrt_price > self.curve[i - 1].sqrt_price
                    && self.curve[i].liquidity > 0,
                PoolError::InvalidCurve
            );
        }

        // the last price in curve must be smaller than or equal max price
        require!(
            self.curve[curve_length - 1].sqrt_price <= MAX_SQRT_PRICE,
            PoolError::InvalidCurve
        );

        // Validate IPWorld fee shares
        // Quote fee shares (SELL side): sum must be strictly less than FEE_SHARE_PRECISION (remainder goes to protocol treasury)
        // SPEC-DBC-004 Phase 3 (REQ-I-001): `creator_share` removed from the sum.
        let total_quote_share = self
            .ip_owner_share
            .checked_add(self.airdrop_share)
            .ok_or(PoolError::MathOverflow)?
            .checked_add(self.referral_share)
            .ok_or(PoolError::MathOverflow)?;
        require!(
            total_quote_share < FEE_SHARE_PRECISION,
            PoolError::InvalidFeePercentage
        );
        // Base fee share (BUY side): must be strictly less than FEE_SHARE_PRECISION (remainder goes to ip_treasury)
        require!(
            self.token_airdrop_share < FEE_SHARE_PRECISION,
            PoolError::InvalidFeePercentage
        );

        Ok(())
    }
}

#[event_cpi]
#[derive(Accounts)]
pub struct CreateConfigCtx<'info> {
    #[account(
        init,
        signer,
        payer = payer,
        space = 8 + PoolConfig::INIT_SPACE
    )]
    pub config: AccountLoader<'info, PoolConfig>,

    /// CHECK: fee_claimer
    pub fee_claimer: UncheckedAccount<'info>,
    /// quote mint
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_create_config(
    ctx: Context<CreateConfigCtx>,
    config_parameters: ConfigParameters,
) -> Result<()> {
    config_parameters.validate(
        &ctx.accounts.quote_mint,
        Clock::get()?.unix_timestamp as u64,
    )?;

    let ConfigParameters {
        pool_fees,
        collect_fee_mode,
        migration_option,
        activation_type,
        token_type,
        token_decimal,
        partner_liquidity_percentage,
        partner_permanent_locked_liquidity_percentage,
        creator_liquidity_percentage,
        creator_permanent_locked_liquidity_percentage,
        migration_quote_threshold,
        sqrt_start_price,
        locked_vesting,
        migration_fee_option,
        token_supply,
        curve,
        creator_trading_fee_percentage,
        token_update_authority,
        migration_fee,
        migrated_pool_fee,
        pool_creation_fee,
        partner_liquidity_vesting_info,
        creator_liquidity_vesting_info,
        migrated_pool_base_fee_mode,
        migrated_pool_market_cap_fee_scheduler_params,
        enable_first_swap_with_min_fee,
        compounding_fee_bps,
        ip_owner_share,
        airdrop_share,
        referral_share,
        token_airdrop_share,
        ..
    } = config_parameters.clone();

    let migration_sqrt_price =
        get_migration_threshold_price(migration_quote_threshold, sqrt_start_price, &curve)?;
    // migration price must be smaller than max sqrt price
    require!(
        migration_sqrt_price < MAX_SQRT_PRICE,
        PoolError::InvalidCurve
    );

    let swap_base_amount_256 =
        get_base_token_for_swap(sqrt_start_price, migration_sqrt_price, &curve)?;
    let swap_base_amount: u64 = swap_base_amount_256
        .try_into()
        .map_err(|_| PoolError::TypeCastFailed)?;
    let migration_option_enum = MigrationOption::try_from(migration_option)
        .map_err(|_| PoolError::InvalidMigrationOption)?;
    let migrated_collect_fee_mode = migrated_pool_fee.collect_fee_mode.safe_cast()?;

    let liquidity_handler = get_migration_handler(
        migration_option_enum,
        migrated_collect_fee_mode,
        migration_sqrt_price,
    );
    let (included_protocol_fee_migration_base_amount, included_protocol_fee_migration_quote_amount) =
        liquidity_handler.get_included_protocol_fee_migration_amounts_1(
            migration_quote_threshold,
            migration_fee.fee_percentage,
        )?;

    require!(
        // this is fine to add redundant check
        included_protocol_fee_migration_base_amount > 0 && swap_base_amount > 0,
        PoolError::InvalidCurve
    );

    if migration_option_enum == MigrationOption::DammV2
        && migrated_collect_fee_mode == MigratedCollectFeeMode::Compounding
    {
        let compounding_liquidity = CompoundingLiquidity {
            migration_sqrt_price,
        };
        let (protocol_migration_base_fee, protocol_migration_quote_fee) = compounding_liquidity
            .get_migration_protocol_fees(
                included_protocol_fee_migration_base_amount,
                included_protocol_fee_migration_quote_amount,
                PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS.into(),
            )?;

        let excluded_protocol_fee_migration_base_amount =
            included_protocol_fee_migration_base_amount.safe_sub(protocol_migration_base_fee)?;
        let excluded_protocol_fee_migration_quote_amount =
            included_protocol_fee_migration_quote_amount.safe_sub(protocol_migration_quote_fee)?;

        CompoundingLiquidity::validate_initial_pool_information(
            excluded_protocol_fee_migration_base_amount,
            excluded_protocol_fee_migration_quote_amount,
            migration_sqrt_price,
        )?;
    }

    let (fixed_token_supply_flag, pre_migration_token_supply, post_migration_token_supply) =
        if let Some(TokenSupplyParams {
            pre_migration_token_supply,
            post_migration_token_supply,
        }) = token_supply
        {
            let swap_base_amount_buffer = PoolConfig::get_swap_amount_with_buffer(
                swap_base_amount,
                sqrt_start_price,
                &curve,
            )?;

            let minimum_base_supply_with_buffer = PoolConfig::get_total_token_supply(
                swap_base_amount_buffer,
                included_protocol_fee_migration_base_amount,
                &locked_vesting,
            )?;

            let minimum_base_supply_without_buffer = PoolConfig::get_total_token_supply(
                swap_base_amount,
                included_protocol_fee_migration_base_amount,
                &locked_vesting,
            )?;

            require!(
                minimum_base_supply_without_buffer <= post_migration_token_supply
                    && post_migration_token_supply <= pre_migration_token_supply
                    && minimum_base_supply_with_buffer <= pre_migration_token_supply,
                PoolError::InvalidTokenSupply
            );
            (1, pre_migration_token_supply, post_migration_token_supply)
        } else {
            (0, 0, 0)
        };

    let MigratedPoolFee {
        pool_fee_bps: migrated_pool_fee_bps,
        collect_fee_mode: migrated_collect_fee_mode,
        dynamic_fee: migrated_dynamic_fee,
    } = migrated_pool_fee;

    let mut config = ctx.accounts.config.load_init()?;
    config.init(
        &ctx.accounts.quote_mint.key(),
        ctx.accounts.fee_claimer.key,
        &pool_fees,
        creator_trading_fee_percentage,
        token_update_authority,
        migration_fee,
        collect_fee_mode,
        migration_option,
        activation_type,
        token_decimal,
        token_type,
        get_token_program_flags(&ctx.accounts.quote_mint).into(),
        partner_permanent_locked_liquidity_percentage,
        partner_liquidity_percentage,
        creator_permanent_locked_liquidity_percentage,
        creator_liquidity_percentage,
        &locked_vesting,
        migration_fee_option,
        swap_base_amount,
        migration_quote_threshold,
        included_protocol_fee_migration_base_amount,
        migration_sqrt_price,
        sqrt_start_price,
        fixed_token_supply_flag,
        pre_migration_token_supply,
        post_migration_token_supply,
        migrated_pool_fee_bps,
        migrated_collect_fee_mode,
        migrated_dynamic_fee,
        pool_creation_fee,
        partner_liquidity_vesting_info.to_liquidity_vesting_info(),
        creator_liquidity_vesting_info.to_liquidity_vesting_info(),
        migrated_pool_base_fee_mode,
        compounding_fee_bps,
        migrated_pool_market_cap_fee_scheduler_params,
        &curve,
        enable_first_swap_with_min_fee.into(),
        ip_owner_share,
        airdrop_share,
        referral_share,
        token_airdrop_share,
    )?;

    // re-validate total locked liquidity
    require!(
        config.get_total_liquidity_locked_bps_at_n_seconds(SECONDS_PER_DAY)?
            >= MIN_LOCKED_LIQUIDITY_BPS,
        PoolError::InvalidMigrationLockedLiquidity
    );

    emit_cpi!(EvtCreateConfig {
        config: ctx.accounts.config.key(),
        fee_claimer: ctx.accounts.fee_claimer.key(),
        quote_mint: ctx.accounts.quote_mint.key(),
        owner: Pubkey::default(),
        pool_fees,
        collect_fee_mode,
        migration_option,
        activation_type,
        token_decimal,
        token_type,
        partner_permanent_locked_liquidity_percentage,
        partner_liquidity_percentage,
        creator_permanent_locked_liquidity_percentage,
        creator_liquidity_percentage,
        swap_base_amount,
        migration_quote_threshold,
        migration_base_amount: included_protocol_fee_migration_base_amount,
        sqrt_start_price,
        fixed_token_supply_flag,
        pre_migration_token_supply,
        post_migration_token_supply,
        locked_vesting,
        migration_fee_option,
        curve
    });

    emit_cpi!(EvtCreateConfigV2 {
        config: ctx.accounts.config.key(),
        fee_claimer: ctx.accounts.fee_claimer.key(),
        quote_mint: ctx.accounts.quote_mint.key(),
        config_parameters: config_parameters
    });

    Ok(())
}

#[cfg(test)]
mod token_vesting_tests {
    use super::*;
    use crate::constants::TOKEN_VESTING_DURATION_SECONDS;

    // SPEC-DBC-AUDIT-001 REQ-C-001 / AC-C-001: the migration locker token-allocation
    // vesting is a fixed 180-day, linear, no-cliff schedule anchored to the migration
    // (finish-curve) timestamp, regardless of the per-pool LockedVestingConfig — while
    // preserving the configured TOTAL amount and RECIPIENT.

    /// The fixed schedule constants span exactly 180 days.
    #[test]
    fn effective_duration_is_180_days() {
        assert_eq!(
            TOKEN_VESTING_PERIOD_FREQUENCY * TOKEN_VESTING_NUMBER_OF_PERIODS,
            TOKEN_VESTING_DURATION_SECONDS
        );
        assert_eq!(TOKEN_VESTING_DURATION_SECONDS, 180 * 86_400);
    }

    /// SPEC-DBC-AUDIT-001 REQ-C-001 (AC-C-001) "no clawback": the locker CPI params use
    /// `cancel_mode == 0` (CancelMode::NeitherCreatorOrRecipient) for every config, so no
    /// one — including the creator — can cancel the escrow and reclaim unvested tokens.
    #[test]
    fn cancel_mode_is_no_clawback() {
        // A config with a real vesting amount.
        let params = LockedVestingParams {
            amount_per_period: 1_000_000,
            cliff_duration_from_migration_time: 0,
            frequency: 1,
            number_of_period: 10,
            cliff_unlock_amount: 1_000_000_000,
        };
        let escrow = params.to_create_vesting_escrow_params(1_700_000_000).unwrap();
        assert_eq!(
            escrow.cancel_mode, 0,
            "cancel_mode must be 0 (no clawback): no one can cancel the vesting escrow"
        );

        // Also holds for the all-zero (no-vesting) config.
        let zero = LockedVestingParams::default();
        let escrow_zero = zero.to_create_vesting_escrow_params(42).unwrap();
        assert_eq!(escrow_zero.cancel_mode, 0);
    }

    /// For an arbitrary config, the built escrow params:
    /// - span exactly 180 days (`frequency * number_of_period`),
    /// - have no cliff (`cliff_time == vesting_start_time`, `cliff_unlock < number_of_period`),
    /// - are anchored to `finish_curve_timestamp`,
    /// - and preserve the configured total (`get_total_deposit_amount == get_total_amount`).
    fn assert_180d_linear_no_cliff(params: LockedVestingParams, finish_curve_timestamp: u64) {
        let configured_total = params.get_total_amount().unwrap();
        let escrow = params
            .to_create_vesting_escrow_params(finish_curve_timestamp)
            .unwrap();

        // Effective duration = frequency * number_of_period = 180 days.
        assert_eq!(
            escrow.frequency * escrow.number_of_period,
            TOKEN_VESTING_DURATION_SECONDS,
            "effective token-vesting duration must be 180 days"
        );

        // Anchored to migration timestamp, no cliff delay.
        assert_eq!(escrow.vesting_start_time, finish_curve_timestamp);
        assert_eq!(
            escrow.cliff_time, escrow.vesting_start_time,
            "cliff_time must equal vesting_start_time (no cliff delay)"
        );

        // No meaningful upfront unlock: remainder dust only (< number_of_period).
        assert!(
            escrow.cliff_unlock_amount < escrow.number_of_period,
            "cliff_unlock_amount ({}) must be rounding dust < number_of_period ({})",
            escrow.cliff_unlock_amount,
            escrow.number_of_period
        );

        // Total deposited by the locker == configured total (bit-for-bit). The locker
        // debits `cliff_unlock_amount + amount_per_period * number_of_period` (its
        // `get_total_deposit_amount`); the IDL-generated type exposes only the fields,
        // so we reconstruct the sum here.
        let deposited = escrow.cliff_unlock_amount
            + escrow.amount_per_period * escrow.number_of_period;
        assert_eq!(
            deposited, configured_total,
            "locker deposit total must equal configured get_total_amount()"
        );

        // update_recipient_mode unchanged (2 = only recipient).
        assert_eq!(escrow.update_recipient_mode, 2);
        // SPEC-DBC-AUDIT-001 REQ-C-001 (AC-C-001) "no clawback": cancel_mode == 0
        // (CancelMode::NeitherCreatorOrRecipient) — no one can cancel the escrow, so the
        // creator cannot reclaim unvested tokens early.
        assert_eq!(
            escrow.cancel_mode, 0,
            "cancel_mode must be 0 (no clawback): no one can cancel the vesting escrow"
        );
    }

    /// Mirrors the on-chain test config (`tests/create_locker.tests.ts`): a large
    /// upfront `cliff_unlock_amount` (1e9) + a short 10-step linear stream. The
    /// rebuilt schedule must neutralise that cliff into a fully-linear 180-day
    /// schedule while preserving the exact total.
    #[test]
    fn rebuilds_existing_cliff_config_into_180d_linear() {
        let params = LockedVestingParams {
            amount_per_period: 1_000_000,
            cliff_duration_from_migration_time: 0,
            frequency: 1,
            number_of_period: 10,
            cliff_unlock_amount: 1_000_000_000,
        };
        // total = 1e9 + 1e6 * 10 = 1_010_000_000
        assert_eq!(params.get_total_amount().unwrap(), 1_010_000_000);
        assert_180d_linear_no_cliff(params, 1_700_000_000);

        // Spot-check the exact split: 1_010_000_000 / 180 = 5_611_111 rem 20.
        let escrow = params.to_create_vesting_escrow_params(1_700_000_000).unwrap();
        assert_eq!(escrow.amount_per_period, 5_611_111);
        assert_eq!(escrow.cliff_unlock_amount, 20); // 1_010_000_000 - 5_611_111*180
        assert_eq!(escrow.number_of_period, 180);
        assert_eq!(escrow.frequency, 86_400);
    }

    /// A total that divides evenly by 180 yields zero cliff_unlock (pure linear).
    #[test]
    fn evenly_divisible_total_has_zero_cliff_unlock() {
        let params = LockedVestingParams {
            amount_per_period: 1_000_000,
            cliff_duration_from_migration_time: 999, // ignored by the fixed schedule
            frequency: 7,                            // ignored
            number_of_period: 180,
            cliff_unlock_amount: 0,
        };
        // total = 1e6 * 180 = 180_000_000, divisible by 180.
        let escrow = params.to_create_vesting_escrow_params(42).unwrap();
        assert_eq!(escrow.cliff_unlock_amount, 0);
        assert_eq!(escrow.amount_per_period, 1_000_000);
        assert_eq!(escrow.frequency * escrow.number_of_period, 15_552_000);
        assert_eq!(
            escrow.cliff_unlock_amount + escrow.amount_per_period * escrow.number_of_period,
            180_000_000
        );
    }
}
