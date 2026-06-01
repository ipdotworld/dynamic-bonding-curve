use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{
    DBC_PROGRAM_ID, TOKEN_VERIFICATION_SEED, VESTING_DURATION_SECONDS, VESTING_VAULT_SEED,
};
use crate::error::VaultError;
use crate::state::Vault;

/// Account context for `claim_vested`.
///
/// `claimer` must equal the `ip_owner` field stored inside the DBC
/// `TokenVerification` account. We do NOT depend on DBC's Rust types directly
/// (cross-crate dependency would create a build cycle); instead we read the
/// raw account bytes after validating Anchor's 8-byte discriminator AND
/// validating the account's authenticity (owner + canonical PDA — see
/// `handle_claim_vested`).
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

    /// The DBC `VirtualPool` account that keys the `TokenVerification` PDA.
    ///
    /// SPEC-DBC-AUDIT-001 Phase 2 (REQ-E-004): the canonical `TokenVerification`
    /// PDA is derived as `[b"token_verification", pool.key()]` against the DBC
    /// program. The vault is keyed by `token_mint` only, so we cannot reconstruct
    /// the TV PDA without the pool key — hence `pool` is supplied as an account
    /// and bound to `token_verification` in the handler. This is a BREAKING change
    /// for the off-chain TS SDK: `claim_vested` callers must now pass the pool.
    /// CHECK: only its key participates in the TV PDA derivation; no data is read.
    pub pool: UncheckedAccount<'info>,

    /// DBC `TokenVerification` PDA. Owned by the DBC program (not this program),
    /// so we deserialize manually via discriminator + offset read AFTER verifying
    /// (a) it is owned by the DBC program and (b) it is the canonical PDA for `pool`.
    /// CHECK: validated inside the handler (owner + canonical PDA + discriminator).
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

// `DBC_PROGRAM_ID` and `TOKEN_VERIFICATION_SEED` are defined once in
// `crate::constants` (shared with `distribute_to_vault`) and imported above.
//
// REQ-E-004: the `TokenVerification` account MUST be owned by `DBC_PROGRAM_ID`
// (an attacker cannot fabricate DBC-owned bytes — only DBC's `verify_token`
// writes TVs) AND be the canonical PDA `[TOKEN_VERIFICATION_SEED, pool]`.

/// Derive the canonical DBC `TokenVerification` PDA for a given pool.
///
/// Pure helper (no account access) so the derivation is unit-testable.
pub fn derive_token_verification_pda(pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[TOKEN_VERIFICATION_SEED, pool.as_ref()], &DBC_PROGRAM_ID).0
}

/// Authenticity guard for a `TokenVerification` account presented to the vault.
///
/// Returns `Ok(())` only when the account is (a) owned by the DBC program and
/// (b) the canonical PDA derived from `pool`. Pure helper (operates on plain
/// pubkeys) so both branches are unit-testable without an Anchor `Context`.
pub fn verify_token_verification_account(
    tv_owner: &Pubkey,
    tv_key: &Pubkey,
    pool: &Pubkey,
) -> Result<()> {
    // (a) PRIMARY: the account must be owned by the DBC program. Defeats the
    // self-owned look-alike spoof — an attacker cannot write DBC-owned bytes.
    require_keys_eq!(*tv_owner, DBC_PROGRAM_ID, VaultError::TokenVerificationWrongOwner);
    // (b) DEFENSE-IN-DEPTH: the account must be the canonical TV PDA for `pool`,
    // so a *different* DBC-owned account cannot be substituted.
    require_keys_eq!(*tv_key, derive_token_verification_pda(pool), VaultError::TokenVerificationWrongPda);
    Ok(())
}

pub fn handle_claim_vested(ctx: Context<ClaimVestedCtx>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // ── Step 0: authenticate the TokenVerification account ───────────────────
    // SPEC-DBC-AUDIT-001 Phase 2 (REQ-E-004): before trusting ANY bytes in the
    // account, prove it is the genuine DBC-owned canonical TV PDA. Without this,
    // an attacker passes a self-owned account carrying the right discriminator
    // and their own pubkey at `IP_OWNER_OFFSET` and drains any vault.
    verify_token_verification_account(
        ctx.accounts.token_verification.owner,
        &ctx.accounts.token_verification.key(),
        &ctx.accounts.pool.key(),
    )?;

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

        // SPEC-DBC-AUDIT-001 Phase 2 (SEC-P2-01): the authenticated (pool, TV)
        // pair authorizes a claim ONLY if `pool` is the pool that funded THIS
        // vault. Without this, an attacker who is the `ip_owner` of their own
        // pool_B presents a self-consistent (canonical(pool_B), pool_B, TV_B)
        // against a vault funded by pool_A — every other check passes and the
        // vault drains. `vault.pool` was recorded at first deposit under the
        // `pool_authority`-gated CPI, so it is the genuine funding pool.
        require_keys_eq!(ctx.accounts.pool.key(), vault.pool, VaultError::PoolMismatch);

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

#[cfg(test)]
mod tests {
    use super::*;

    /// SPEC-DBC-AUDIT-001 Phase 2 (REQ-E-004) case (a):
    /// a TokenVerification account NOT owned by the DBC program is rejected,
    /// even if it sits at the canonical PDA address. This defeats the self-owned
    /// look-alike spoof (attacker controls the bytes / `ip_owner` field).
    #[test]
    fn rejects_token_verification_with_wrong_owner() {
        let pool = Pubkey::new_unique();
        // Use the canonical key so we isolate the owner failure from the PDA check.
        let canonical_tv = derive_token_verification_pda(&pool);
        let attacker_owned = Pubkey::new_unique(); // attacker's program / system, NOT DBC

        let res = verify_token_verification_account(&attacker_owned, &canonical_tv, &pool);
        assert!(res.is_err(), "wrong-owner TV must be rejected");
    }

    /// REQ-E-004 case (b): an account legitimately owned by the DBC program but
    /// at the WRONG address (a different DBC PDA / another pool's TV) is rejected.
    /// Defeats cross-pool substitution among genuine DBC-owned accounts.
    #[test]
    fn rejects_dbc_owned_account_at_wrong_pda() {
        let pool = Pubkey::new_unique();
        let other_pool = Pubkey::new_unique();
        // DBC-owned but it is the TV of a DIFFERENT pool.
        let wrong_tv = derive_token_verification_pda(&other_pool);

        let res = verify_token_verification_account(&DBC_PROGRAM_ID, &wrong_tv, &pool);
        assert!(res.is_err(), "DBC-owned account at the wrong PDA must be rejected");
    }

    /// REQ-E-004 case (c): the genuine path — DBC-owned account at the canonical
    /// PDA for the supplied pool passes authentication.
    #[test]
    fn accepts_genuine_dbc_owned_canonical_pda() {
        let pool = Pubkey::new_unique();
        let canonical_tv = derive_token_verification_pda(&pool);

        let res = verify_token_verification_account(&DBC_PROGRAM_ID, &canonical_tv, &pool);
        assert!(res.is_ok(), "genuine canonical TV owned by DBC must be accepted");
    }

    /// REQ-E-004: a spoof that is BOTH wrong-owner AND wrong-PDA is rejected
    /// (the realistic attacker-fabricated account).
    #[test]
    fn rejects_fully_spoofed_account() {
        let pool = Pubkey::new_unique();
        let spoof_key = Pubkey::new_unique();
        let spoof_owner = Pubkey::new_unique();

        let res = verify_token_verification_account(&spoof_owner, &spoof_key, &pool);
        assert!(res.is_err(), "fully spoofed TV must be rejected");
    }

    /// Sanity: the replicated TV seeds + DBC program id reproduce the same PDA
    /// that `Pubkey::find_program_address` yields from the canonical seeds.
    /// Guards against a typo in `TOKEN_VERIFICATION_SEED` or `DBC_PROGRAM_ID`.
    #[test]
    fn token_verification_pda_matches_canonical_seeds() {
        let pool = Pubkey::new_unique();
        let derived = derive_token_verification_pda(&pool);
        let (expected, _bump) = Pubkey::find_program_address(
            &[b"token_verification", pool.as_ref()],
            &Pubkey::from_str_const("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"),
        );
        assert_eq!(derived, expected);
    }

    /// The `ip_owner` byte offset matches the DBC `TokenVerification` layout
    /// (discriminator(8) + ipa_id(32) → ip_owner at 40).
    #[test]
    fn ip_owner_offset_is_correct() {
        assert_eq!(IP_OWNER_OFFSET, 40);
    }

    /// SEC-P2-01 REGRESSION (the exact reported attack): a self-consistent
    /// `(canonical(pool_B), pool_B, TV_B)` triple — which PASSES TV authenticity
    /// because pool_B's TV genuinely exists and the attacker is its ip_owner — is
    /// REJECTED at claim time when presented against a vault bound to pool_A.
    ///
    /// This exercises the claim-side binding check `pool.key() == vault.pool`
    /// (the handler's `require_keys_eq!`) via the same `Vault` state it reads.
    #[test]
    fn self_consistent_attacker_pool_rejected_against_pool_a_vault() {
        let pool_a = Pubkey::new_unique();
        let pool_b = Pubkey::new_unique(); // attacker's own, legitimately-launched pool

        // Vault funded by pool_A: binding recorded at first (pool_authority-gated) deposit.
        let mut vault = Vault::default();
        vault.bind_or_check_pool(pool_a).unwrap();
        vault.total_deposited = 1_000_000;

        // The attacker's TV authenticates fine for pool_B (owner==DBC, canonical PDA):
        let tv_b = derive_token_verification_pda(&pool_b);
        assert!(
            verify_token_verification_account(&DBC_PROGRAM_ID, &tv_b, &pool_b).is_ok(),
            "attacker's own TV is genuinely authentic for pool_B"
        );

        // …but the claim-side binding rejects pool_B against a pool_A-bound vault.
        // (`bind_or_check_pool` enforces the same equality the handler does.)
        assert!(
            vault.bind_or_check_pool(pool_b).is_err(),
            "presenting pool_B against a vault bound to pool_A must be rejected"
        );

        // And the legitimate pool_A path still matches the binding.
        assert!(
            vault.bind_or_check_pool(pool_a).is_ok(),
            "legitimate pool_A still authorizes the pool_A-bound vault"
        );
    }
}
