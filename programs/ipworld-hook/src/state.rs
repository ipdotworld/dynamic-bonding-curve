use anchor_lang::prelude::*;

#[account]
pub struct HookConfig {
    pub pool_vault: Pubkey, // DBC's base token vault — the curve itself
    pub bump: u8,           // Anchor PDA plumbing
}
// Seeds: [b"hook_config", mint.key()]
// Size: 8 (discriminator) + 32 (pool_vault) + 1 (bump) = 41 bytes
