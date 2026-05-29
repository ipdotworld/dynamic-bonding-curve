use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    const_pda,
    state::{Operator, VirtualPool},
    token::transfer_token_from_pool_authority,
    PoolError,
};

/// Allows the airdrop operator to withdraw accumulated airdrop fees:
///   - `airdrop_quote_fee`     (SOL / quote token, from sell swaps)
///   - `token_airdrop_base_fee` (base token, from buy swaps)
///
/// The backend is responsible for distributing these funds to UGC creators
/// and token holders off-chain.
///
/// Authorization: caller must hold an Operator account with `ClaimAirdrop` permission
/// (REQ-I-004 Phase 5.4 — was `ClaimProtocolFee` pre-Phase-5).
#[derive(Accounts)]
pub struct ClaimAirdropFeeCtx<'info> {
    /// Pool authority PDA that signs token transfers.
    /// CHECK: Validated by address constraint to be the pool authority.
    #[account(address = const_pda::pool_authority::ID)]
    pub pool_authority: AccountInfo<'info>,

    /// The bonding curve pool holding accumulated fee counters.
    #[account(mut, has_one = quote_vault, has_one = base_vault, has_one = config)]
    pub pool: AccountLoader<'info, VirtualPool>,

    /// Pool config — required by `has_one = config` on pool.
    /// CHECK: Used only to satisfy the has_one constraint.
    pub config: AccountInfo<'info>,

    /// Base mint (the bonding curve token).
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Quote mint (SOL wrapper or other quote token).
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Pool's base vault — source of the token airdrop fee transfer.
    #[account(mut, token::mint = base_mint)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Pool's quote vault — source of the SOL airdrop fee transfer.
    #[account(mut, token::mint = quote_mint)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    // SPEC-DBC-AUDIT-001 REQ-A-008 (SEC-CORE-05): the airdrop fee destinations
    // below are operator-chosen and intentionally UNCONSTRAINED (only the mint is
    // checked). This is a trusted-operator assumption consistent with the EVM model
    // (operator-chosen destination); the ClaimAirdrop operator is trusted to direct
    // funds correctly. No on-chain destination constraint is added by design.
    /// Destination token account for the base (token) airdrop fees.
    #[account(mut, token::mint = base_mint)]
    pub airdrop_base_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Destination token account for the quote (SOL) airdrop fees.
    #[account(mut, token::mint = quote_mint)]
    pub airdrop_quote_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Operator account authorising this claim.
    pub operator: AccountLoader<'info, Operator>,

    /// The operator key — must match `operator.whitelisted_address`.
    pub signer: Signer<'info>,

    /// Token program for the base mint.
    pub token_base_program: Interface<'info, TokenInterface>,

    /// Token program for the quote mint.
    pub token_quote_program: Interface<'info, TokenInterface>,
}

pub fn handle_claim_airdrop_fee<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, ClaimAirdropFeeCtx<'info>>,
    max_quote_amount: u64,
    max_base_amount: u64,
) -> Result<()> {
    let mut pool = ctx.accounts.pool.load_mut()?;

    // --- Quote (SOL) airdrop fee ---
    let quote_amount = pool.airdrop_quote_fee.min(max_quote_amount);
    if quote_amount > 0 {
        pool.airdrop_quote_fee = pool
            .airdrop_quote_fee
            .checked_sub(quote_amount)
            .ok_or(PoolError::MathOverflow)?;
    }

    // --- Base (token) airdrop fee ---
    let base_amount = pool.token_airdrop_base_fee.min(max_base_amount);
    if base_amount > 0 {
        pool.token_airdrop_base_fee = pool
            .token_airdrop_base_fee
            .checked_sub(base_amount)
            .ok_or(PoolError::MathOverflow)?;
    }

    require!(
        quote_amount > 0 || base_amount > 0,
        PoolError::AmountIsZero
    );

    drop(pool);

    // Transfer quote (SOL) fees.
    if quote_amount > 0 {
        transfer_token_from_pool_authority(
            ctx.accounts.pool_authority.to_account_info(),
            &ctx.accounts.quote_mint,
            &ctx.accounts.quote_vault,
            ctx.accounts.airdrop_quote_token_account.to_account_info(),
            &ctx.accounts.token_quote_program,
            quote_amount,
            ctx.remaining_accounts,
        )?;
    }

    // Transfer base (token) fees.
    if base_amount > 0 {
        transfer_token_from_pool_authority(
            ctx.accounts.pool_authority.to_account_info(),
            &ctx.accounts.base_mint,
            &ctx.accounts.base_vault,
            ctx.accounts.airdrop_base_token_account.to_account_info(),
            &ctx.accounts.token_base_program,
            base_amount,
            ctx.remaining_accounts,
        )?;
    }

    Ok(())
}
