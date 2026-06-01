use crate::state::{Operator, TokenVerification};
use crate::PoolError;
use anchor_lang::prelude::*;

/// Links a token pool to an IPA (IP Asset) identifier (backend-authorized).
///
/// SPEC-DBC-AUDIT-001 Phase 4 (REQ-D-002): authorization is now **operator
/// direct-signing**. The operator signs directly AND must hold the
/// `OperatorPermission::VerifyToken` role (enforced by `#[access_control(...)]` in
/// `lib.rs`). The relayed-Ed25519 path is removed; `ipa_id` is an instruction
/// argument. Multiple pools can share the same `ipa_id` (EVM `linkTokensToIp()`).
#[derive(Accounts)]
pub struct LinkTokenToIpCtx<'info> {
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

pub fn handle_link_token_to_ip(ctx: Context<LinkTokenToIpCtx>, ipa_id: Pubkey) -> Result<()> {
    // Reject zero ipa_id.
    require!(ipa_id != Pubkey::default(), PoolError::InvalidInput);

    ctx.accounts.token_verification.ipa_id = ipa_id;

    Ok(())
}
