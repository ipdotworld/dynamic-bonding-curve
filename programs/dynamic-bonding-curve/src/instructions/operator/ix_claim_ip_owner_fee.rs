use anchor_lang::prelude::*;
use anchor_lang::system_program::System;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    const_pda,
    constants::seeds::POOL_AUTHORITY_PREFIX,
    event::EvtClaimIpOwnerFee,
    state::{TokenVerification, VirtualPool},
    PoolError,
};

/// Allows the verified IP owner to drain accumulated quote fees into the
/// `ip-owner-vault` program for linear vesting (SPEC-DBC-004 Phase 6 REQ-I-003).
///
/// Authorization: caller must be `token_verification.ip_owner`.
/// Requires a valid `TokenVerification` PDA — created by `verify_token`.
/// Quote fees flow: pool quote_vault → vault ATA (CPI signed by pool_authority).
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

    /// The verified IP owner — must sign this transaction. The fee is NOT
    /// transferred directly to this signer's wallet; it is forwarded to the
    /// vault for linear vesting and later claimed via `ip_owner_vault::claim_vested`.
    pub ip_owner: Signer<'info>,

    /// Quote mint (SOL wrapper / WSOL or other quote token).
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Pool's quote vault — source of the fee transfer (signed by pool_authority).
    #[account(mut, token::mint = quote_mint)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    // ── Vault CPI accounts (SPEC-DBC-004 Phase 6 REQ-I-003) ─────────────────

    /// Vault data PDA in the ip-owner-vault program.
    /// `init_if_needed` happens inside the vault program's CPI handler.
    /// CHECK: Owned by ip-owner-vault; validated by seeds inside the vault program.
    #[account(mut)]
    pub vault: AccountInfo<'info>,

    /// Vault-owned ATA receiving the quote fee.
    /// `init_if_needed` happens inside the vault program's CPI handler.
    /// CHECK: Validated by associated_token constraints inside the vault program.
    #[account(mut)]
    pub vault_token_account: AccountInfo<'info>,

    /// Pays for `init_if_needed` of the vault data PDA + ATA on first deposit.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The ip-owner-vault program (target of the CPI).
    pub ip_owner_vault_program: Program<'info, ip_owner_vault::program::IpOwnerVault>,

    /// Token program for the quote mint.
    pub token_quote_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
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

    // ── Phase 2: CPI to ip_owner_vault::distribute_to_vault ──────────────────
    // pool_authority is a PDA owned by the DBC program; we sign with its seeds
    // at the boundary so the vault program's inner SPL transfer inherits the
    // signer status of pool_authority.
    let pool_authority_signer_seeds: &[&[u8]] =
        &[POOL_AUTHORITY_PREFIX, &[const_pda::pool_authority::BUMP]];
    let signer_seeds_arr = [pool_authority_signer_seeds];

    let cpi_accounts = ip_owner_vault::cpi::accounts::DistributeToVaultCtx {
        vault: ctx.accounts.vault.to_account_info(),
        token_mint: ctx.accounts.quote_mint.to_account_info(),
        source_token_account: ctx.accounts.quote_vault.to_account_info(),
        vault_token_account: ctx.accounts.vault_token_account.to_account_info(),
        authority: ctx.accounts.pool_authority.to_account_info(),
        payer: ctx.accounts.payer.to_account_info(),
        token_program: ctx.accounts.token_quote_program.to_account_info(),
        associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
    };

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.ip_owner_vault_program.to_account_info(),
        cpi_accounts,
        &signer_seeds_arr,
    );

    ip_owner_vault::cpi::distribute_to_vault(cpi_ctx, amount)?;

    // ── Phase 3: emit event ──────────────────────────────────────────────────
    emit_cpi!(EvtClaimIpOwnerFee {
        pool: ctx.accounts.pool.key(),
        ip_owner: ctx.accounts.ip_owner.key(),
        vault: ctx.accounts.vault.key(),
        token_quote_amount: amount,
        routed_to_vault: true,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
