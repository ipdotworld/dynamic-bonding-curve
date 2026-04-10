use anchor_lang::prelude::*;

#[account]
pub struct IpworldState {
    /// Backend signing key (lives in KMS). Rotatable via update_ipworld_authority.
    pub authority: Pubkey,
    /// Cold key that can rotate authority. Starts as deployer wallet,
    /// upgrade to multisig later via update_ipworld_admin.
    pub admin: Pubkey,
    pub bump: u8,
}

impl IpworldState {
    pub const SEED: &'static [u8] = b"ipworld_state";
    /// 8 (discriminator) + 32 + 32 + 1 = 73
    pub const LEN: usize = 8 + 32 + 32 + 1;
}
