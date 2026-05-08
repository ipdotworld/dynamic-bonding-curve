//! Event module includes information about events of the program
use anchor_lang::prelude::*;

use crate::{
    params::{
        fee_parameters::PoolFeeParameters, liquidity_distribution::LiquidityDistributionParameters,
    },
    state::{SwapResult, SwapResult2},
    ConfigParameters, LockedVestingParams, SwapParameters, SwapParameters2,
};

/// IpworldState initialized
#[event]
pub struct EvtIpworldStateInitialized {
    pub admin: Pubkey,
    pub authority: Pubkey,
}

/// Admin transfer proposed
#[event]
pub struct EvtAdminProposed {
    pub old_admin: Pubkey,
    pub pending_admin: Pubkey,
}

/// Admin transfer accepted
#[event]
pub struct EvtAdminAccepted {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}

/// Authority rotation proposed
#[event]
pub struct EvtAuthorityProposed {
    pub old_authority: Pubkey,
    pub pending_authority: Pubkey,
}

/// Authority rotation accepted
#[event]
pub struct EvtAuthorityAccepted {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

/// IP owner verified for a pool
#[event]
pub struct EvtTokenVerified {
    pub pool: Pubkey,
    pub ip_owner: Pubkey,
}

/// Create partner metadata
#[event]
pub struct EvtPartnerMetadata {
    pub partner_metadata: Pubkey,
    pub fee_claimer: Pubkey,
}

/// Create virtual pool metadata
#[event]
pub struct EvtVirtualPoolMetadata {
    pub virtual_pool_metadata: Pubkey,
    pub virtual_pool: Pubkey,
}

/// Create config
#[deprecated(since = "0.1.8")]
#[event]
pub struct EvtCreateConfig {
    pub config: Pubkey,
    pub quote_mint: Pubkey,
    pub fee_claimer: Pubkey,
    pub owner: Pubkey,
    pub pool_fees: PoolFeeParameters,
    pub collect_fee_mode: u8,
    pub migration_option: u8,
    pub activation_type: u8,
    pub token_decimal: u8,
    pub token_type: u8,
    pub partner_permanent_locked_liquidity_percentage: u8,
    pub partner_liquidity_percentage: u8,
    pub creator_permanent_locked_liquidity_percentage: u8,
    pub creator_liquidity_percentage: u8,
    pub swap_base_amount: u64,
    pub migration_quote_threshold: u64,
    pub migration_base_amount: u64,
    pub sqrt_start_price: u128,
    pub locked_vesting: LockedVestingParams,
    pub migration_fee_option: u8,
    pub fixed_token_supply_flag: u8,
    pub pre_migration_token_supply: u64,
    pub post_migration_token_supply: u64,
    pub curve: Vec<LiquidityDistributionParameters>,
}

#[event]
pub struct EvtCreateConfigV2 {
    pub config: Pubkey,
    pub quote_mint: Pubkey,
    pub fee_claimer: Pubkey,
    pub config_parameters: ConfigParameters,
}

/// Close claim fee operator
#[event]
pub struct EvtCloseClaimFeeOperator {
    pub claim_fee_operator: Pubkey,
    pub operator: Pubkey,
}

#[event]
pub struct EvtInitializePool {
    pub pool: Pubkey,
    pub config: Pubkey,
    pub creator: Pubkey,
    pub base_mint: Pubkey,
    pub pool_type: u8,
    pub activation_point: u64,
}

#[event]
pub struct EvtSwap {
    pub pool: Pubkey,
    pub config: Pubkey,
    pub trade_direction: u8,
    pub has_referral: bool,
    pub params: SwapParameters,
    pub swap_result: SwapResult,
    pub amount_in: u64,
    pub current_timestamp: u64,
}

#[event]
pub struct EvtSwap2 {
    pub pool: Pubkey,
    pub config: Pubkey,
    pub trade_direction: u8,
    pub has_referral: bool,
    pub swap_parameters: SwapParameters2,
    pub swap_result: SwapResult2,
    pub quote_reserve_amount: u64,
    pub migration_threshold: u64,
    pub current_timestamp: u64,
}

#[event]
pub struct EvtCurveComplete {
    pub pool: Pubkey,
    pub config: Pubkey,
    pub base_reserve: u64,
    pub quote_reserve: u64,
}

#[event]
pub struct EvtClaimProtocolFee {
    pub pool: Pubkey,
    pub token_base_amount: u64,
    pub token_quote_amount: u64,
}

/// Emitted by `claim_token_airdrop_fee` (SPEC-DBC-004 REQ-S-007 Phase 5.5).
/// Token-only airdrop fee drain — operators with `ClaimAirdrop` permission
/// move accumulated `pool.token_airdrop_base_fee` to the operator-supplied
/// destination so the backend can perform off-chain UGC distribution.
#[event]
pub struct EvtClaimTokenAirdropFee {
    pub pool: Pubkey,
    pub destination: Pubkey,
    pub token_base_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct EvtClaimTradingFee {
    pub pool: Pubkey,
    pub token_base_amount: u64,
    pub token_quote_amount: u64,
}

// SPEC-DBC-004 Phase 3 (REQ-I-001): `EvtClaimCreatorTradingFee` removed
// alongside the `claim_creator_trading_fee` instruction.

/// Emitted by `claim_ip_owner_fee` (SPEC-DBC-004 Phase 6 REQ-I-003).
///
/// `routed_to_vault: true` indicates the quote fee was forwarded to the
/// `ip-owner-vault` program via CPI for linear vesting; `false` would indicate
/// a legacy direct transfer (not currently used post-Phase 6).
#[event]
pub struct EvtClaimIpOwnerFee {
    pub pool: Pubkey,
    pub ip_owner: Pubkey,
    pub vault: Pubkey,
    pub token_quote_amount: u64,
    pub routed_to_vault: bool,
    pub timestamp: i64,
}

#[event]
pub struct EvtCreatorWithdrawSurplus {
    pub pool: Pubkey,
    pub surplus_amount: u64,
}

#[event]
pub struct EvtWithdrawLeftover {
    pub pool: Pubkey,
    pub ip_treasury: Pubkey,
    pub leftover_amount: u64,
}

#[event]
pub struct EvtUpdatePoolCreator {
    pub pool: Pubkey,
    pub creator: Pubkey,
    pub new_creator: Pubkey,
}

#[event]
pub struct EvtWithdrawMigrationFee {
    pub pool: Pubkey,
    pub fee: u64,
    pub flag: u8,
}

#[event]
pub struct EvtClaimPoolCreationFee {
    pub pool: Pubkey,
    pub receiver: Pubkey,
    pub creation_fee: u64,
}

#[event]
pub struct EvtPartnerClaimPoolCreationFee {
    pub pool: Pubkey,
    pub partner: Pubkey,
    pub creation_fee: u64,
    pub fee_receiver: Pubkey,
}

#[event]
pub struct EvtMigrateDammV2 {
    pub pool: Pubkey,
    pub config: Pubkey,
    pub damm_v2_pool: Pubkey,
    pub timestamp: u64,
}
