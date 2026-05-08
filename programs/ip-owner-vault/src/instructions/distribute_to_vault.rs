use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::VESTING_VAULT_SEED;
use crate::error::VaultError;
use crate::state::Vault;

/// Account context for `distribute_to_vault`.
///
/// The `authority` signer is whoever owns the source token account. In the
/// canonical DBC integration, `authority` is DBC's `pool_authority` PDA, signed
/// at the parent CPI boundary via `CpiContext::new_with_signer(pool_authority_seeds)`.
/// Anchor preserves the parent CPI's signer status for inner CPIs (the
/// `transfer_checked` call below uses plain `CpiContext::new`, which inherits
/// the already-signed `authority` AccountInfo).
#[derive(Accounts)]
pub struct DistributeToVaultCtx<'info> {
    /// Vesting vault metadata. Created on first call (`init_if_needed`) and
    /// then re-used for all subsequent deposits for the same `token_mint`.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VESTING_VAULT_SEED, token_mint.key().as_ref()],
        bump,
    )]
    pub vault: AccountLoader<'info, Vault>,

    /// Mint of the deposited token. Must match `vault.token_mint` once the vault
    /// has been initialized; on first call we simply record this mint.
    pub token_mint: InterfaceAccount<'info, Mint>,

    /// Source token account being drained. Owned by `authority`.
    #[account(mut, token::mint = token_mint)]
    pub source_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Vault-owned ATA receiving the deposit. Created on first call.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = token_mint,
        associated_token::authority = vault,
    )]
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Authority over `source_token_account` (PDA or wallet). Anchor inherits
    /// signer status from the parent CPI for PDA authorities — see module doc.
    /// CHECK: arbitrary AccountInfo because it may be a PDA owned by another
    /// program; signer enforcement happens at the SPL `transfer_checked` level.
    pub authority: AccountInfo<'info>,

    /// Pays for `init_if_needed` of `vault` + `vault_token_account`.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Records a quote-fee deposit into the vesting vault and forwards the SPL
/// transfer from `source_token_account` to `vault_token_account`.
///
/// First-deposit semantics:
///   - Stamps `vault.vesting_start_unix_timestamp` to `Clock::unix_timestamp`.
///   - Subsequent deposits do NOT reset the clock (linear vesting curve is
///     anchored to first deposit).
///   - Records `vault.token_mint` for downstream verification.
pub fn handle_distribute_to_vault(
    ctx: Context<DistributeToVaultCtx>,
    amount: u64,
) -> Result<()> {
    require_gt!(amount, 0, VaultError::AmountIsZero);

    let now = Clock::get()?.unix_timestamp;
    let vault_bump = ctx.bumps.vault;
    let token_mint_key = ctx.accounts.token_mint.key();

    // ── Phase A: scoped vault mut-borrow (drops before CPI) ──────────────────
    {
        let mut vault = ctx.accounts.vault.load_init().or_else(|_| {
            // Already initialized → load mut.
            ctx.accounts.vault.load_mut()
        })?;

        // First-time init path: token_mint is zero. Otherwise verify match.
        if vault.token_mint == Pubkey::default() {
            vault.token_mint = token_mint_key;
            vault.bump = vault_bump;
        } else {
            require_keys_eq!(vault.token_mint, token_mint_key, VaultError::MintMismatch);
        }

        vault.stamp_clock_on_first_deposit(now);
        vault.add_deposit(amount)?;
    }

    // ── Phase B: SPL transfer from source to vault ATA ───────────────────────
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.source_token_account.to_account_info(),
        mint: ctx.accounts.token_mint.to_account_info(),
        to: ctx.accounts.vault_token_account.to_account_info(),
        authority: ctx.accounts.authority.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    // No `with_signer` here — `authority` was already attested as a signer at
    // the parent CPI boundary (DBC's pool_authority via CpiContext::new_with_signer).
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
    transfer_checked(cpi_ctx, amount, ctx.accounts.token_mint.decimals)?;

    Ok(())
}
