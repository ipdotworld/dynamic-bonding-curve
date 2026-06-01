use crate::state::{Operator, TokenVerification, VirtualPool};
use crate::PoolError;
use anchor_lang::prelude::*;

/// Registers the IP owner for a specific pool by creating a TokenVerification PDA.
///
/// SPEC-DBC-AUDIT-001 Phase 4 (REQ-D-002): authorization is now **operator
/// direct-signing**. The operator signs the transaction directly AND must hold the
/// `OperatorPermission::VerifyToken` role (enforced by `#[access_control(...)]` in
/// `lib.rs`). The previous relayed-Ed25519 signature path (`verify_authority_sig`)
/// is removed — there is no signed message to replay because the operator is the
/// direct caller. `ip_owner` is now an instruction argument.
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

    /// Operator account holding the `VerifyToken` role. Validated by
    /// `#[access_control(is_valid_operator_role(.., VerifyToken))]` in lib.rs.
    pub operator: AccountLoader<'info, Operator>,

    /// The operator's whitelisted signer — must sign the transaction directly.
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_verify_token(ctx: Context<VerifyTokenCtx>, ip_owner: Pubkey) -> Result<()> {
    // Reject zero address to prevent registering an unusable IP owner.
    require!(ip_owner != Pubkey::default(), PoolError::InvalidOwnerAccount);

    let tv = &mut ctx.accounts.token_verification;
    tv.ip_owner = ip_owner;
    tv.ipa_id = Pubkey::default();
    tv.pending_ip_owner = Pubkey::default();
    tv.ip_treasury = Pubkey::default();
    tv.referral = Pubkey::default();
    tv.pending_referral = Pubkey::default();
    tv.verified_at = Clock::get()?.unix_timestamp;
    tv.bump = ctx.bumps.token_verification;

    emit!(crate::EvtTokenVerified {
        pool: ctx.accounts.pool.key(),
        ip_owner,
    });

    Ok(())
}
