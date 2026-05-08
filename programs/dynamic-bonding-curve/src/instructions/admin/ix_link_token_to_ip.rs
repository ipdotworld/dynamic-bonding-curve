use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;
use crate::state::{IpworldState, TokenVerification, LinkTokenToIpAuth};
use crate::utils::verify_authority_sig::verify_authority_sig;
use crate::PoolError;

/// Links a token pool to an IPA (IP Asset) identifier (backend-authorized).
///
/// Transaction layout:
///   ix[N-1]: Ed25519Program.verify(signature, authority, LinkTokenToIpAuth{pool, ipa_id})
///   ix[N]:   DBC.link_token_to_ip(pool)
///
/// Multiple pools can share the same `ipa_id`, allowing one IP owner to receive
/// fees from multiple token pools. Follows the EVM `linkTokensToIp()` pattern (E-03).
#[derive(Accounts)]
pub struct LinkTokenToIpCtx<'info> {
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

pub fn handle_link_token_to_ip(ctx: Context<LinkTokenToIpCtx>) -> Result<()> {
    let auth: LinkTokenToIpAuth = verify_authority_sig(
        &ctx.accounts.instruction_sysvar,
        &ctx.accounts.ipworld_state,
    )?;

    // Ensure the signed message refers to the same pool as the account passed in.
    require!(
        auth.pool == ctx.accounts.pool.key(),
        PoolError::InvalidAccount
    );

    // Reject zero ipa_id.
    require!(
        auth.ipa_id != Pubkey::default(),
        PoolError::InvalidInput
    );

    ctx.accounts.token_verification.ipa_id = auth.ipa_id;

    Ok(())
}
