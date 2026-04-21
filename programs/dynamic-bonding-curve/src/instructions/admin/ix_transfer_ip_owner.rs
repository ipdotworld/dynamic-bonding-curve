use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;
use crate::state::{IpworldState, TokenVerification, TransferIpOwnerAuth};
use crate::utils::verify_authority_sig::verify_authority_sig;
use crate::PoolError;

/// Proposes a transfer of IP owner role to a new wallet (backend-authorized).
///
/// Transaction layout:
///   ix[N-1]: Ed25519Program.verify(signature, authority, TransferIpOwnerAuth{pool, new_ip_owner})
///   ix[N]:   DBC.transfer_ip_owner(pool)
///
/// The new IP owner must call `accept_ip_owner` to complete the transfer.
/// Follows the EVM `claimIp` / `acceptRecipient` 2-step pattern (V-03).
#[derive(Accounts)]
pub struct TransferIpOwnerCtx<'info> {
    /// Instructions sysvar — used to verify the preceding Ed25519 instruction.
    /// CHECK: Read-only sysvar; validated inside verify_authority_sig.
    #[account(address = sysvar::instructions::ID)]
    pub instruction_sysvar: AccountInfo<'info>,

    /// Platform-wide state holding the backend authority public key.
    #[account(
        seeds = [IpworldState::SEED],
        bump = ipworld_state.bump,
    )]
    pub ipworld_state: Account<'info, IpworldState>,

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
}

pub fn handle_transfer_ip_owner(ctx: Context<TransferIpOwnerCtx>) -> Result<()> {
    let auth: TransferIpOwnerAuth = verify_authority_sig(
        &ctx.accounts.instruction_sysvar,
        &ctx.accounts.ipworld_state,
    )?;

    // Ensure the signed message refers to the same pool as the account passed in.
    require!(
        auth.pool == ctx.accounts.pool.key(),
        PoolError::InvalidAccount
    );

    // Reject zero address to prevent accidental lockout.
    require!(
        auth.new_ip_owner != Pubkey::default(),
        PoolError::InvalidOwnerAccount
    );

    ctx.accounts.token_verification.pending_ip_owner = auth.new_ip_owner;

    Ok(())
}
