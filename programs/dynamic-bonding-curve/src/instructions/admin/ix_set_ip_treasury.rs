use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;
use crate::state::{IpworldState, TokenVerification, SetIpTreasuryAuth};
use crate::utils::verify_authority_sig::verify_authority_sig;
use crate::PoolError;

/// Sets the IP treasury address on the TokenVerification PDA (one-time, immutable).
///
/// Transaction layout:
///   ix[N-1]: Ed25519Program.verify(signature, authority, SetIpTreasuryAuth{pool, treasury})
///   ix[N]:   DBC.set_ip_treasury(pool)
///
/// Once set, `ip_treasury` cannot be changed. Any attempt to call this instruction
/// again will fail with `IpTreasuryAlreadySet`. Follows EVM `setIpTreasury()` (E-01).
#[derive(Accounts)]
pub struct SetIpTreasuryCtx<'info> {
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

pub fn handle_set_ip_treasury(ctx: Context<SetIpTreasuryCtx>) -> Result<()> {
    let auth: SetIpTreasuryAuth = verify_authority_sig(
        &ctx.accounts.instruction_sysvar,
        &ctx.accounts.ipworld_state,
    )?;

    // Ensure the signed message refers to the same pool as the account passed in.
    require!(
        auth.pool == ctx.accounts.pool.key(),
        PoolError::InvalidAccount
    );

    // Reject zero address.
    require!(
        auth.treasury != Pubkey::default(),
        PoolError::InvalidOwnerAccount
    );

    // One-time only: revert if already set.
    require!(
        ctx.accounts.token_verification.ip_treasury == Pubkey::default(),
        PoolError::IpTreasuryAlreadySet
    );

    ctx.accounts.token_verification.ip_treasury = auth.treasury;

    Ok(())
}
