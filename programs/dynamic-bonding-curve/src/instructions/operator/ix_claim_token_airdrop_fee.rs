use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    const_pda,
    state::{Operator, VirtualPool},
    token::transfer_token_from_pool_authority,
    EvtClaimTokenAirdropFee, PoolError,
};

/// SPEC-DBC-004 REQ-S-007 (Phase 5.5) — token-only airdrop fee drain.
///
/// Allows the airdrop operator (with `ClaimAirdrop` permission) to withdraw
/// the accumulated base-token airdrop counter only:
///
///   - `pool.token_airdrop_base_fee` (base token, accumulated from buy swaps)
///
/// Unlike `claim_airdrop_fee` which drains BOTH the SOL (quote) and token
/// (base) airdrop accumulators, this instruction is scoped to the token side
/// only. Backend uses this when distributing the token portion to UGC creators
/// off-chain on a different cadence than the quote (SOL) portion.
///
/// Authorization: caller must hold an Operator account with `ClaimAirdrop`
/// permission (set via `create_operator_account` with bit 3 of the permission
/// bitmask). Authority is enforced by `#[access_control(is_valid_operator_role)]`
/// at the lib.rs `#[program]` declaration.
///
/// Emits: `EvtClaimTokenAirdropFee { pool, destination, token_base_amount, timestamp }`.
#[event_cpi]
#[derive(Accounts)]
pub struct ClaimTokenAirdropFeeCtx<'info> {
    /// Pool authority PDA that signs the token transfer.
    /// CHECK: Validated by address constraint to be the canonical pool authority.
    #[account(address = const_pda::pool_authority::ID)]
    pub pool_authority: AccountInfo<'info>,

    /// The bonding curve pool holding the accumulated token airdrop counter.
    #[account(mut, has_one = base_vault, has_one = config)]
    pub pool: AccountLoader<'info, VirtualPool>,

    /// Pool config — required by `has_one = config` on pool.
    /// CHECK: Used only to satisfy the has_one constraint.
    pub config: AccountInfo<'info>,

    /// Base mint (the bonding curve token).
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Pool's base vault — source of the token airdrop fee transfer.
    #[account(mut, token::mint = base_mint)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Destination token account for the base (token) airdrop fees.
    /// Owner is the operator-controlled airdrop authority off-chain.
    #[account(mut, token::mint = base_mint)]
    pub airdrop_base_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Operator account authorising this claim.
    /// Permission bit 3 (`OperatorPermission::ClaimAirdrop`) must be set.
    pub operator: AccountLoader<'info, Operator>,

    /// The operator key — must match `operator.whitelisted_address`.
    pub signer: Signer<'info>,

    /// Token program for the base mint.
    pub token_base_program: Interface<'info, TokenInterface>,
}

pub fn handle_claim_token_airdrop_fee<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, ClaimTokenAirdropFeeCtx<'info>>,
    max_base_amount: u64,
) -> Result<()> {
    let mut pool = ctx.accounts.pool.load_mut()?;

    // Determine the drain amount: capped by the operator-supplied max.
    let base_amount = pool.token_airdrop_base_fee.min(max_base_amount);
    require!(base_amount > 0, PoolError::AmountIsZero);

    // Decrement the on-chain counter BEFORE transfer (Effects-then-Interactions).
    pool.token_airdrop_base_fee = pool
        .token_airdrop_base_fee
        .checked_sub(base_amount)
        .ok_or(PoolError::MathOverflow)?;

    // Release the borrow before the CPI.
    drop(pool);

    transfer_token_from_pool_authority(
        ctx.accounts.pool_authority.to_account_info(),
        &ctx.accounts.base_mint,
        &ctx.accounts.base_vault,
        ctx.accounts.airdrop_base_token_account.to_account_info(),
        &ctx.accounts.token_base_program,
        base_amount,
        ctx.remaining_accounts,
    )?;

    emit_cpi!(EvtClaimTokenAirdropFee {
        pool: ctx.accounts.pool.key(),
        destination: ctx.accounts.airdrop_base_token_account.key(),
        token_base_amount: base_amount,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
