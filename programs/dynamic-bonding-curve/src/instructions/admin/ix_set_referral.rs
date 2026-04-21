use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;
use crate::state::{IpworldState, TokenVerification, SetReferralAuth};
use crate::utils::verify_authority_sig::verify_authority_sig;
use crate::PoolError;

/// Proposes a new referral wallet for the pool (backend-authorized).
///
/// Transaction layout:
///   ix[N-1]: Ed25519Program.verify(signature, authority, SetReferralAuth{pool, new_referral})
///   ix[N]:   DBC.set_referral(pool)
///
/// The current IP owner must call `accept_referral` to activate the new referral.
/// Follows the EVM `setReferral()` / `acceptReferral()` 2-step pattern (E-02).
#[derive(Accounts)]
pub struct SetReferralCtx<'info> {
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

pub fn handle_set_referral(ctx: Context<SetReferralCtx>) -> Result<()> {
    let auth: SetReferralAuth = verify_authority_sig(
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
        auth.new_referral != Pubkey::default(),
        PoolError::InvalidOwnerAccount
    );

    ctx.accounts.token_verification.pending_referral = auth.new_referral;

    Ok(())
}
