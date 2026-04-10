use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

/// Signed by backend to authorize a token launch. Single-use because
/// pool_pda can only be initialized once (#[account(init)] blocks re-use).
#[derive(BorshSerialize, BorshDeserialize)]
pub struct LaunchAuth {
    /// Must match the creator signer in the launch tx
    pub creator: Pubkey,
    /// Must match the partner config PDA used for this launch
    pub config: Pubkey,
    /// Must match the derived pool PDA — replay protection via init
    pub pool_pda: Pubkey,
}

/// Signed by backend to authorize trading. Reusable within the TTL window.
/// Platform-wide (not per-pool) — user can trade any pool until expiry.
#[derive(BorshSerialize, BorshDeserialize)]
pub struct TradeAuth {
    /// Must match the payer/signer of the swap tx
    pub user: Pubkey,
    /// Unix timestamp — backend sets this to now + 3600 (1 hour)
    pub expires_at: i64,
}
