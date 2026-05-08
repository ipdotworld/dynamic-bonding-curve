use anchor_lang::prelude::*;

/// Per-pool IP owner verification record.
///
/// Created by `verify_token` (Ed25519-authenticated backend call).
/// Once created, `claim_ip_owner_fee` gates on this PDA.
#[account]
pub struct TokenVerification {
    /// IPA (IP Asset) identifier linking multiple pools to one IP owner.
    /// Set by `link_token_to_ip`. Zero until set.
    pub ipa_id: Pubkey,
    /// Verified IP owner wallet — may call `claim_ip_owner_fee`.
    pub ip_owner: Pubkey,
    /// Pending new IP owner during 2-step transfer (`transfer_ip_owner` → `accept_ip_owner`).
    /// Zero until a transfer is proposed.
    pub pending_ip_owner: Pubkey,
    /// Community treasury address for `claim_ip_treasury_fee`.
    /// Set once by `set_ip_treasury` (immutable after set). Zero until set.
    pub ip_treasury: Pubkey,
    /// Active referral wallet receiving immediate referral fees during swaps.
    /// Zero until set by `set_referral` + `accept_referral`.
    pub referral: Pubkey,
    /// Pending new referral during 2-step change. Zero until proposed.
    pub pending_referral: Pubkey,
    /// Unix timestamp when this record was created.
    pub verified_at: i64,
    /// PDA bump seed.
    pub bump: u8,
}

impl TokenVerification {
    /// PDA seed prefix.
    pub const SEED: &'static [u8] = b"token_verification";

    /// On-chain account size:
    /// discriminator(8) + ipa_id(32) + ip_owner(32) + pending_ip_owner(32)
    /// + ip_treasury(32) + referral(32) + pending_referral(32)
    /// + verified_at(8) + bump(1) = 209
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 32 + 32 + 8 + 1; // 209
}
