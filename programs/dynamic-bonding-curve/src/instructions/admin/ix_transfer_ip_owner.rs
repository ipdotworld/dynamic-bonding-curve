use crate::state::{Operator, TokenVerification};
use crate::PoolError;
use anchor_lang::prelude::*;

/// Proposes a transfer of IP owner role to a new wallet (backend-authorized).
///
/// SPEC-DBC-AUDIT-001 Phase 4 (REQ-D-002): authorization is now **operator
/// direct-signing**. The operator signs directly AND must hold the
/// `OperatorPermission::VerifyToken` role (enforced by `#[access_control(...)]` in
/// `lib.rs`). The relayed-Ed25519 path is removed; `new_ip_owner` is an instruction
/// argument. The new IP owner must call `accept_ip_owner` to complete the transfer
/// (EVM `claimIp` / `acceptRecipient` 2-step pattern).
#[derive(Accounts)]
pub struct TransferIpOwnerCtx<'info> {
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

pub fn handle_transfer_ip_owner(
    ctx: Context<TransferIpOwnerCtx>,
    new_ip_owner: Pubkey,
) -> Result<()> {
    // Reject zero address to prevent accidental lockout.
    require!(
        new_ip_owner != Pubkey::default(),
        PoolError::InvalidOwnerAccount
    );

    ctx.accounts.token_verification.pending_ip_owner = new_ip_owner;

    Ok(())
}
