//! Error module includes error messages and codes of the program
use anchor_lang::prelude::*;
use protocol_zap::error::ProtozolZapError;

/// Error messages and codes of the program
#[error_code]
#[derive(PartialEq)]
pub enum PoolError {
    #[msg("Math operation overflow")]
    MathOverflow,

    #[msg("Invalid fee setup")]
    InvalidFee,

    #[msg("Exceeded slippage tolerance")]
    ExceededSlippage,

    #[msg("Exceeded max fee bps")]
    ExceedMaxFeeBps,

    #[msg("Invalid admin")]
    InvalidAdmin,

    #[msg("Amount is zero")]
    AmountIsZero,

    #[msg("Type cast error")]
    TypeCastFailed,

    #[msg("Invalid activation type")]
    InvalidActivationType,

    #[msg("Invalid quote mint")]
    InvalidQuoteMint,

    #[msg("Invalid collect fee mode")]
    InvalidCollectFeeMode,

    #[msg("Invalid migration fee option")]
    InvalidMigrationFeeOption,

    #[msg("Invalid input")]
    InvalidInput,

    #[msg("Not enough liquidity")]
    NotEnoughLiquidity,

    #[msg("Pool is completed")]
    PoolIsCompleted,

    #[msg("Pool is incompleted")]
    PoolIsIncompleted,

    #[msg("Invalid migration option")]
    InvalidMigrationOption,

    #[msg("Invalid token decimals")]
    InvalidTokenDecimals,

    #[msg("Invalid token type")]
    InvalidTokenType,

    #[msg("Invalid fee percentage")]
    InvalidFeePercentage,

    #[msg("Invalid quote threshold")]
    InvalidQuoteThreshold,

    #[msg("Invalid token supply")]
    InvalidTokenSupply,

    #[msg("Invalid curve")]
    InvalidCurve,

    #[msg("Not permit to do this action")]
    NotPermitToDoThisAction,

    #[msg("Invalid owner account")]
    InvalidOwnerAccount,

    #[msg("Invalid config account")]
    InvalidConfigAccount,

    #[msg("Surplus has been withdraw")]
    SurplusHasBeenWithdraw,

    #[msg("Leftover has been withdraw")]
    LeftoverHasBeenWithdraw,

    #[msg("Unsupport native mint token 2022")]
    UnsupportNativeMintToken2022,

    #[msg("Insufficient liquidity for migration")]
    InsufficientLiquidityForMigration,

    #[msg("Missing pool config in remaining account")]
    MissingPoolConfigInRemainingAccount,

    #[msg("Invalid vesting parameters")]
    InvalidVestingParameters,

    // Deprecated (AC-A08): leftover_receiver removed from PoolConfig.
    // Kept for IDL compatibility (error code number must not shift).
    #[msg("Invalid leftover address")]
    InvalidLeftoverAddress,

    #[msg("Liquidity in bonding curve is insufficient")]
    InsufficientLiquidity,

    #[msg("Invalid fee scheduler")]
    InvalidFeeScheduler,

    #[msg("Invalid creator trading fee percentage")]
    InvalidCreatorTradingFeePercentage,

    #[msg("Invalid new creator")]
    InvalidNewCreator,

    #[msg("Invalid token authority option")]
    InvalidTokenAuthorityOption,

    #[msg("Invalid account for the instruction")]
    InvalidAccount,

    #[msg("Invalid migrator fee percentage")]
    InvalidMigratorFeePercentage,

    #[msg("Migration fee has been withdraw")]
    MigrationFeeHasBeenWithdraw,

    #[msg("Invalid base fee mode")]
    InvalidBaseFeeMode,

    #[msg("Invalid fee rate limiter")]
    InvalidFeeRateLimiter,

    #[msg("Fail to validate single swap instruction in rate limiter")]
    FailToValidateSingleSwapInstruction,

    #[msg("Invalid migrated pool fee params")]
    InvalidMigratedPoolFee,

    #[msg("Undertermined error")]
    UndeterminedError,

    #[msg("Rate limiter not supported")]
    RateLimiterNotSupported,

    #[msg("Amount left is not zero")]
    AmountLeftIsNotZero,

    #[msg("Invalid min base fee")]
    InvalidMinBaseFee,

    #[msg("Account invariant violation")]
    AccountInvariantViolation,

    #[msg("Invalid pool creation fee")]
    InvalidPoolCreationFee,

    #[msg("Pool creation fee has been claimed")]
    PoolCreationFeeHasBeenClaimed,

    #[msg("Not permit to do this action")]
    Unauthorized,

    #[msg("Pool creation fee is zero")]
    ZeroPoolCreationFee,

    #[msg("Invalid migration locked liquidity")]
    InvalidMigrationLockedLiquidity,

    #[msg("Invalid fee market cap scheduler")]
    InvalidFeeMarketCapScheduler,

    #[msg("Incorrect ATA")]
    IncorrectATA,

    #[msg("Pool has insufficient lamports to perform the operation")]
    InsufficientPoolLamports,

    #[msg("Invalid permission")]
    InvalidPermission,

    #[msg("Invalid withdraw protocol fee zap accounts")]
    InvalidWithdrawProtocolFeeZapAccounts,

    #[msg("SOL,USDC protocol fee cannot be withdrawn via zap")]
    MintRestrictedFromZap,

    #[msg("Invalid zap out parameters")]
    InvalidZapOutParameters,

    #[msg("CPI disabled")]
    CpiDisabled,

    #[msg("Missing zap out instruction")]
    MissingZapOutInstruction,

    #[msg("Invalid zap accounts")]
    InvalidZapAccounts,

    #[msg("Invalid compounding parameters")]
    InvalidCompoundingParameters,

    #[msg("Launch not authorized by ipworld backend")]
    UnauthorizedLaunch,

    #[msg("Trade not authorized by ipworld backend")]
    UnauthorizedTrade,

    #[msg("Trade authorization has expired")]
    TradeAuthExpired,

    #[msg("Must claim accumulated fees before transferring creator role")]
    UnclaimedFees,

    #[msg("Invalid authority address")]
    InvalidAuthority,

    #[msg("No pending admin proposal")]
    NoPendingAdmin,

    #[msg("No pending authority proposal")]
    NoPendingAuthority,

    #[msg("Invalid sqrt price")]
    InvalidSqrtPrice,

    #[msg("IP treasury address is already set and cannot be changed")]
    IpTreasuryAlreadySet,

    #[msg("Token is not verified — TokenVerification PDA does not exist")]
    NotVerified,

    #[msg("No pending IP owner transfer proposal")]
    NoPendingIpOwner,

    #[msg("No pending referral change proposal")]
    NoPendingReferral,

    #[msg("IP treasury address is not set — call set_ip_treasury first")]
    IpTreasuryNotSet,

    #[msg("Migrated DAMM v2 fee config violates IPWorld constraint (OnlyB + zero compounding)")]
    InvalidMigratedFeeConfig,

    #[msg("Operator permission slot is reserved or no longer supported — see SPEC-DBC-004 REQ-I-004")]
    UnsupportedOperatorPermission,

    #[msg("Referral payout requested but TokenVerification account was not provided")]
    MissingTokenVerification,

    #[msg("TokenVerification account is not the canonical PDA / not owned by this program")]
    InvalidTokenVerification,

    #[msg("Referral token account is not owned by the registered referral wallet")]
    InvalidReferralAccount,
}

impl From<ProtozolZapError> for PoolError {
    fn from(e: ProtozolZapError) -> Self {
        match e {
            ProtozolZapError::MathOverflow => PoolError::MathOverflow,
            ProtozolZapError::InvalidZapOutParameters => PoolError::InvalidZapOutParameters,
            ProtozolZapError::TypeCastFailed => PoolError::TypeCastFailed,
            ProtozolZapError::MissingZapOutInstruction => PoolError::MissingZapOutInstruction,
            ProtozolZapError::InvalidWithdrawProtocolFeeZapAccounts => {
                PoolError::InvalidWithdrawProtocolFeeZapAccounts
            }
            ProtozolZapError::MintRestrictedFromZap => PoolError::MintRestrictedFromZap,
            ProtozolZapError::CpiDisabled => PoolError::CpiDisabled,
            ProtozolZapError::InvalidZapAccounts => PoolError::InvalidZapAccounts,
        }
    }
}
