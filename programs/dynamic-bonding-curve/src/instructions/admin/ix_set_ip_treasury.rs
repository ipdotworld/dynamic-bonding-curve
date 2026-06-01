use crate::state::{Operator, TokenVerification};
use crate::PoolError;
use anchor_lang::prelude::*;

/// Sets the IP treasury address on the TokenVerification PDA (one-time, immutable).
///
/// SPEC-DBC-AUDIT-001 Phase 4 (REQ-D-002): authorization is now **operator
/// direct-signing**. The operator signs directly AND must hold the
/// `OperatorPermission::VerifyToken` role (enforced by `#[access_control(...)]` in
/// `lib.rs`). The relayed-Ed25519 path is removed; `treasury` is an instruction
/// argument. Once set, `ip_treasury` cannot be changed (mirrors EVM `setIpTreasury()`).
#[derive(Accounts)]
pub struct SetIpTreasuryCtx<'info> {
    /// Per-pool IP owner verification record.
    #[account(
        mut,
        seeds = [TokenVerification::SEED, pool.key().as_ref()],
        bump = token_verification.bump,
    )]
    pub token_verification: Account<'info, TokenVerification>,

    /// The pool this verification record belongs to.
    /// CHECK: Validated indirectly via TokenVerification PDA seeds.
    pub pool: AccountInfo<'info>,

    /// Operator account holding the `VerifyToken` role. Validated by
    /// `#[access_control(is_valid_operator_role(.., VerifyToken))]` in lib.rs.
    pub operator: AccountLoader<'info, Operator>,

    /// The operator's whitelisted signer — must sign the transaction directly.
    pub signer: Signer<'info>,
}

pub fn handle_set_ip_treasury(ctx: Context<SetIpTreasuryCtx>, treasury: Pubkey) -> Result<()> {
    // Reject zero address.
    require!(treasury != Pubkey::default(), PoolError::InvalidOwnerAccount);

    // One-time only: revert if already set.
    require!(
        ctx.accounts.token_verification.ip_treasury == Pubkey::default(),
        PoolError::IpTreasuryAlreadySet
    );

    ctx.accounts.token_verification.ip_treasury = treasury;

    Ok(())
}
