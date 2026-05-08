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

/// Signed by backend to authorize IP owner verification for a specific pool.
/// Single-use because TokenVerification PDA can only be initialized once.
#[derive(BorshSerialize, BorshDeserialize)]
pub struct VerifyAuth {
    /// Must match the pool account passed to verify_token
    pub pool: Pubkey,
    /// IP owner wallet to record in the TokenVerification PDA
    pub ip_owner: Pubkey,
}

/// Signed by backend to authorize IP owner transfer proposal.
#[derive(BorshSerialize, BorshDeserialize)]
pub struct TransferIpOwnerAuth {
    /// Must match the pool account passed to transfer_ip_owner
    pub pool: Pubkey,
    /// New IP owner wallet to set as pending_ip_owner
    pub new_ip_owner: Pubkey,
}

/// Signed by backend to authorize setting the IP treasury address (one-time).
#[derive(BorshSerialize, BorshDeserialize)]
pub struct SetIpTreasuryAuth {
    /// Must match the pool account passed to set_ip_treasury
    pub pool: Pubkey,
    /// Community treasury wallet to record in the TokenVerification PDA
    pub treasury: Pubkey,
}

/// Signed by backend to authorize referral proposal.
#[derive(BorshSerialize, BorshDeserialize)]
pub struct SetReferralAuth {
    /// Must match the pool account passed to set_referral
    pub pool: Pubkey,
    /// New referral wallet to set as pending_referral
    pub new_referral: Pubkey,
}

/// Signed by backend to authorize linking a token pool to an IPA identifier.
#[derive(BorshSerialize, BorshDeserialize)]
pub struct LinkTokenToIpAuth {
    /// Must match the pool account passed to link_token_to_ip
    pub pool: Pubkey,
    /// IPA identifier to store in the TokenVerification PDA
    pub ipa_id: Pubkey,
}
