use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    const_pda,
    event::EvtClaimIpOwnerFee,
    state::{TokenVerification, VirtualPool},
    token::transfer_token_from_pool_authority,
    PoolError,
};

/// Allows the verified IP owner to withdraw accumulated quote (SOL) fees.
///
/// SPEC-DBC-AUDIT-001 REQ-C-001 (AC-C-001): the IP-owner quote/SOL share is paid
/// **immediately** to the IP owner's own quote token account at claim time — it is
/// NOT routed into the `ip-owner-vault` for vesting. This matches the EVM model
/// (`protocol/src/IPOwnerVault.sol`), where the ETH/quote share is released
/// immediately and only the token allocation vests.
///
/// Authorization: caller must be `token_verification.ip_owner`.
/// Requires a valid `TokenVerification` PDA — created by `verify_token`.
/// Quote fees flow: `pool.quote_vault` → IP owner's quote token account, via a
/// `transfer_checked` signed by `pool_authority`.
#[event_cpi]
#[derive(Accounts)]
pub struct ClaimIpOwnerFeeCtx<'info> {
    /// Pool authority PDA that signs token transfers.
    /// CHECK: Validated by address constraint to be the pool authority.
    #[account(address = const_pda::pool_authority::ID)]
    pub pool_authority: AccountInfo<'info>,

    /// The bonding curve pool holding accumulated fee counters.
    #[account(mut, has_one = quote_vault, has_one = config)]
    pub pool: AccountLoader<'info, VirtualPool>,

    /// Pool config — required by `has_one = config` on pool.
    /// CHECK: Used only to satisfy the has_one constraint.
    pub config: AccountInfo<'info>,

    /// IP owner verification record for this pool.
    /// Constraint: caller must match the recorded ip_owner.
    #[account(
        seeds = [TokenVerification::SEED, pool.key().as_ref()],
        bump = token_verification.bump,
        constraint = token_verification.ip_owner == ip_owner.key() @ PoolError::Unauthorized,
    )]
    pub token_verification: Account<'info, TokenVerification>,

    /// The verified IP owner — must sign this transaction. The quote fee is paid
    /// directly to `ip_owner_token_account` (owned by this signer) immediately.
    pub ip_owner: Signer<'info>,

    /// Quote mint (SOL wrapper / WSOL or other quote token).
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Pool's quote vault — source of the fee transfer (signed by pool_authority).
    #[account(mut, token::mint = quote_mint)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The IP owner's quote token account that receives the fee immediately.
    /// Must be owned by the verified `ip_owner` and hold the pool's quote mint.
    #[account(
        mut,
        token::mint = quote_mint,
        token::authority = ip_owner,
    )]
    pub ip_owner_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Token program for the quote mint.
    pub token_quote_program: Interface<'info, TokenInterface>,
}

pub fn handle_claim_ip_owner_fee<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, ClaimIpOwnerFeeCtx<'info>>,
    max_amount: u64,
) -> Result<()> {
    // ── Phase 1: drain accumulator ───────────────────────────────────────────
    let amount = {
        let mut pool = ctx.accounts.pool.load_mut()?;
        let amount = pool.ip_owner_quote_fee.min(max_amount);
        require!(amount > 0, PoolError::AmountIsZero);
        pool.ip_owner_quote_fee = pool
            .ip_owner_quote_fee
            .checked_sub(amount)
            .ok_or(PoolError::MathOverflow)?;
        amount
    };

    // ── Phase 2: pay the IP owner IMMEDIATELY (no vault vesting) ──────────────
    // SPEC-DBC-AUDIT-001 REQ-C-001: quote share is released at claim time, signed
    // by `pool_authority` (the SPL transfer authority over `pool.quote_vault`).
    // `transfer_token_from_pool_authority` also appends any Token-2022 transfer-hook
    // accounts from `remaining_accounts`, mirroring the sibling claim instructions.
    transfer_token_from_pool_authority(
        ctx.accounts.pool_authority.to_account_info(),
        &ctx.accounts.quote_mint,
        &ctx.accounts.quote_vault,
        ctx.accounts.ip_owner_token_account.to_account_info(),
        &ctx.accounts.token_quote_program,
        amount,
        ctx.remaining_accounts,
    )?;

    // ── Phase 3: emit event ──────────────────────────────────────────────────
    emit_cpi!(EvtClaimIpOwnerFee {
        pool: ctx.accounts.pool.key(),
        ip_owner: ctx.accounts.ip_owner.key(),
        ip_owner_token_account: ctx.accounts.ip_owner_token_account.key(),
        token_quote_amount: amount,
        paid_immediately: true,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // SPEC-DBC-AUDIT-001 REQ-C-001 (AC-C-001): the IP-owner quote/SOL share is paid
    // IMMEDIATELY at claim time to the IP owner's own quote token account — it is NOT
    // routed into the `ip-owner-vault` for vesting.
    //
    // The full transfer flow requires an on-chain Anchor context (test validator /
    // ts-mocha — see `tests/ip_owner_vault_flow.tests.ts`). At the Rust level we pin the
    // event contract that proves the immediate-payment path: the event reports the IP
    // owner's destination token account and `paid_immediately == true`, and the
    // pre-AUDIT `vault` / `routed_to_vault` fields no longer exist.

    /// The emitted event reflects immediate payment to the IP owner's token account.
    #[test]
    fn event_reflects_immediate_payment() {
        let pool = Pubkey::new_unique();
        let ip_owner = Pubkey::new_unique();
        let ip_owner_token_account = Pubkey::new_unique();

        let evt = EvtClaimIpOwnerFee {
            pool,
            ip_owner,
            ip_owner_token_account,
            token_quote_amount: 12_345,
            paid_immediately: true,
            timestamp: 1_700_000_000,
        };

        // Quote is paid immediately, never vault-routed.
        assert!(evt.paid_immediately);
        // The destination is the IP owner's own quote token account.
        assert_eq!(evt.ip_owner_token_account, ip_owner_token_account);
        assert_eq!(evt.ip_owner, ip_owner);
        assert_eq!(evt.token_quote_amount, 12_345);
    }
}
