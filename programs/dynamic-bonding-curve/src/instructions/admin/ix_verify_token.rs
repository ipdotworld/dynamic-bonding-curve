use anchor_lang::prelude::*;
use crate::state::{IpworldState, TokenVerification, VirtualPool};
use crate::state::auth_structs::VerifyAuth;
use crate::utils::verify_authority_sig::verify_authority_sig;
use crate::PoolError;

/// Registers the IP owner for a specific pool by creating a TokenVerification PDA.
///
/// Transaction layout:
///   ix[N-1]: Ed25519Program.verify(signature, authority, VerifyAuth{pool, ip_owner})
///   ix[N]:   DBC.verify_token(pool)
#[derive(Accounts)]
pub struct VerifyTokenCtx<'info> {
    /// Fee payer for the new TokenVerification account rent.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The TokenVerification PDA created by this instruction.
    /// Seeds: ["token_verification", pool.key()].
    /// Can only be initialized once — replay protection is structural.
    #[account(
        init,
        seeds = [TokenVerification::SEED, pool.key().as_ref()],
        bump,
        payer = payer,
        space = TokenVerification::LEN,
    )]
    pub token_verification: Account<'info, TokenVerification>,

    /// The bonding curve pool whose IP owner is being verified.
    pub pool: AccountLoader<'info, VirtualPool>,

    /// Platform-wide state holding the backend authority pubkey.
    #[account(
        seeds = [IpworldState::SEED],
        bump = ipworld_state.bump,
    )]
    pub ipworld_state: Account<'info, IpworldState>,

    /// Instructions sysvar — used to read the preceding Ed25519 instruction.
    /// CHECK: Validated by address constraint to be the instructions sysvar.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_verify_token(ctx: Context<VerifyTokenCtx>) -> Result<()> {
    // Deserialize and verify the Ed25519-signed VerifyAuth payload.
    let verify_auth: VerifyAuth = verify_authority_sig(
        &ctx.accounts.instructions_sysvar,
        &ctx.accounts.ipworld_state,
    )?;

    // Ensure the signed payload references this exact pool.
    require!(
        verify_auth.pool == ctx.accounts.pool.key(),
        PoolError::UnauthorizedLaunch
    );

    let tv = &mut ctx.accounts.token_verification;
    tv.ip_owner = verify_auth.ip_owner;
    tv.ipa_id = Pubkey::default();
    tv.pending_ip_owner = Pubkey::default();
    tv.ip_treasury = Pubkey::default();
    tv.referral = Pubkey::default();
    tv.pending_referral = Pubkey::default();
    tv.verified_at = Clock::get()?.unix_timestamp;
    tv.bump = ctx.bumps.token_verification;

    emit!(crate::EvtTokenVerified {
        pool: ctx.accounts.pool.key(),
        ip_owner: verify_auth.ip_owner,
    });

    Ok(())
}
