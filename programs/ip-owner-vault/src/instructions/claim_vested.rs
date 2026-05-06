use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{VESTING_DURATION_SECONDS, VESTING_VAULT_SEED};
use crate::error::VaultError;
use crate::state::Vault;

/// Account context for `claim_vested`.
///
/// `claimer` must equal the `ip_owner` field stored inside the DBC
/// `TokenVerification` account. We do NOT depend on DBC's Rust types directly
/// (cross-crate dependency would create a build cycle); instead we read the
/// raw account bytes after validating Anchor's 8-byte discriminator.
#[derive(Accounts)]
pub struct ClaimVestedCtx<'info> {
    /// Vesting vault — must be initialized.
    #[account(
        mut,
        seeds = [VESTING_VAULT_SEED, token_mint.key().as_ref()],
        bump = vault.load()?.bump,
        constraint = vault.load()?.token_mint == token_mint.key() @ VaultError::MintMismatch,
    )]
    pub vault: AccountLoader<'info, Vault>,

    /// Mint validated against `vault.token_mint`.
    pub token_mint: InterfaceAccount<'info, Mint>,

    /// Vault-owned ATA holding deposited tokens.
    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = vault,
    )]
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Recipient token account owned by `claimer`.
    #[account(mut, token::mint = token_mint, token::authority = claimer)]
    pub claimer_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Must match `TokenVerification.ip_owner` for this token.
    pub claimer: Signer<'info>,

    /// DBC `TokenVerification` PDA. Owned by the DBC program (not this program),
    /// so we deserialize manually via discriminator + offset read.
    /// CHECK: validated inside the handler against Anchor discriminator.
    pub token_verification: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// Discriminator for the DBC `TokenVerification` account.
///
/// Anchor 0.31 derives the discriminator as the first 8 bytes of
/// `sha256("account:TokenVerification")`. We hard-code the expected bytes so
/// the vault stays decoupled from the DBC crate.
///
/// To verify / regenerate when DBC's account name changes:
/// ```bash
/// python3 -c "import hashlib; print(list(hashlib.sha256(b'account:TokenVerification').digest()[:8]))"
/// # → [4, 223, 96, 231, 30, 222, 144, 130]
/// ```
const TOKEN_VERIFICATION_DISCRIMINATOR: [u8; 8] =
    [0x04, 0xdf, 0x60, 0xe7, 0x1e, 0xde, 0x90, 0x82];

/// Byte offset of the `ip_owner` field inside `TokenVerification`'s
/// account data (after the 8-byte discriminator and the 32-byte `ipa_id`).
const IP_OWNER_OFFSET: usize = 8 + 32;

pub fn handle_claim_vested(ctx: Context<ClaimVestedCtx>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // ── Step 1: validate the TokenVerification account & extract ip_owner ────
    let tv_data = ctx.accounts.token_verification.try_borrow_data()?;
    require!(
        tv_data.len() >= IP_OWNER_OFFSET + 32,
        VaultError::InvalidTokenVerification
    );
    require!(
        tv_data[..8] == TOKEN_VERIFICATION_DISCRIMINATOR,
        VaultError::InvalidTokenVerification
    );

    let mut ip_owner_bytes = [0u8; 32];
    ip_owner_bytes.copy_from_slice(&tv_data[IP_OWNER_OFFSET..IP_OWNER_OFFSET + 32]);
    let ip_owner = Pubkey::new_from_array(ip_owner_bytes);
    drop(tv_data);

    require_keys_eq!(ctx.accounts.claimer.key(), ip_owner, VaultError::Unauthorized);

    // ── Step 2: compute claimable amount and update accounting ───────────────
    let claimable;
    let bump;
    {
        let mut vault = ctx.accounts.vault.load_mut()?;
        // `total_deposited > 0` is the canonical "vault has been seeded" predicate.
        // We do NOT use `vesting_start_unix_timestamp > 0` because environments
        // (e.g. LiteSVM) may legitimately operate at unix_timestamp == 0 at boot.
        require!(vault.total_deposited > 0, VaultError::VestingNotStarted);
        claimable = vault.claimable_amount(now, VESTING_DURATION_SECONDS);
        require_gt!(claimable, 0, VaultError::NothingToClaim);
        vault.add_claim(claimable)?;
        bump = vault.bump;
    }

    // ── Step 3: SPL transfer from vault ATA to claimer ATA ───────────────────
    let token_mint_key = ctx.accounts.token_mint.key();
    let signer_seeds: &[&[u8]] = &[VESTING_VAULT_SEED, token_mint_key.as_ref(), &[bump]];
    let signer_seeds_arr = [signer_seeds];

    let cpi_accounts = TransferChecked {
        from: ctx.accounts.vault_token_account.to_account_info(),
        mint: ctx.accounts.token_mint.to_account_info(),
        to: ctx.accounts.claimer_token_account.to_account_info(),
        authority: ctx.accounts.vault.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, &signer_seeds_arr);
    transfer_checked(cpi_ctx, claimable, ctx.accounts.token_mint.decimals)?;

    Ok(())
}
