use anchor_lang::prelude::*;
use anchor_lang::system_program::{create_account, CreateAccount};
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

pub mod state;
pub mod errors;

use state::HookConfig;
use errors::HookError;

// SPEC-DBC-AUDIT-001 Phase 3 (REQ-E-002): real, deployable program id.
// Generated from `target/deploy/ipworld_hook-keypair.json` (a deploy secret,
// gitignored). The prior placeholder `HooK1111...` had no matching private key,
// so Token-2022 pool creation (which sets this as the transfer-hook program and
// CPIs into it) was undeployable. The core DBC program references this exact id
// as its single source of truth via `ipworld_hook::ID` (a re-export of THIS
// `declare_id!` const), so the two can never diverge.
declare_id!("7WDGrFPSEQjh42aLrzDkqWu6RTCeDYJeTRErKDQDLiC1");

/// On-chain program id of the dynamic-bonding-curve (DBC) program.
///
/// SPEC-DBC-AUDIT-001 Phase 2 (REQ-E-003): `initialize_hook_config` must only be
/// callable by DBC's `pool_authority` PDA (the legitimate CPI caller during pool
/// init). We derive that PDA against this program id and require the signer match.
pub const DBC_PROGRAM_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");

/// PDA seed prefix for DBC's `pool_authority` (single static seed, no per-mint
/// component): `pool_authority = find_program_address([b"pool_authority"], DBC)`.
/// Confirmed from DBC `constants::seeds::POOL_AUTHORITY_PREFIX` + `const_pda`.
pub const POOL_AUTHORITY_PREFIX: &[u8] = b"pool_authority";

/// PDA seed prefix for DBC's per-pool token vaults.
///
/// SPEC-DBC-AUDIT-001 Phase 2 (SEC-P2-02): DBC creates the base vault at
/// `[TOKEN_VAULT_PREFIX, base_mint, pool]` (see
/// `ix_initialize_virtual_pool_with_token2022` / `_with_spl_token`). We replicate
/// the seeds (dependency-free) to bind the hook's stored `pool_vault` to the
/// canonical PER-POOL base vault, not merely to the global `pool_authority`.
pub const TOKEN_VAULT_PREFIX: &[u8] = b"token_vault";

/// Derive DBC's `pool_authority` PDA. Pure helper so the derivation is unit-testable.
pub fn derive_pool_authority() -> Pubkey {
    Pubkey::find_program_address(&[POOL_AUTHORITY_PREFIX], &DBC_PROGRAM_ID).0
}

/// Derive DBC's canonical base-vault PDA for `(mint, pool)`.
///
/// SEC-P2-02: the hook's `pool_vault` MUST equal this PDA, proving it is the
/// specific pool's base vault rather than any token account controlled by the
/// global `pool_authority`. Pure helper → unit-testable.
pub fn derive_base_vault(mint: &Pubkey, pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[TOKEN_VAULT_PREFIX, mint.as_ref(), pool.as_ref()],
        &DBC_PROGRAM_ID,
    )
    .0
}

// SPEC-DBC-AUDIT-001 Phase 6 (REQ-B-001): persistent 5% holding-cap percentage.
// Denominated in whole percent (5 == 5%). Exactly 5% is ALLOWED; strictly more
// than 5% is rejected (see `holding_cap_allows`).
pub const HOLDING_CAP_PERCENT: u128 = 5;

/// Pure holding-cap decision (REQ-B-001). Returns `Ok(())` if the transfer is
/// permitted by the 5% holding cap, or `Err(HookError::HoldingCapExceeded)` if
/// the recipient's POST-transfer balance would strictly exceed 5% of total
/// supply. Exempt recipients always pass.
///
/// Factored out of the Execute context so the decision is unit-testable without
/// constructing Token-2022 accounts.
///
/// # Arguments
/// * `dest_balance`    — the destination token account's CURRENT `amount`
///   (pre-transfer balance).
/// * `transfer_amount` — the Execute `amount` (the quantity being transferred).
/// * `total_supply`    — the mint's `supply`.
/// * `is_exempt`       — true if the recipient is an exempt wallet (pool vault,
///   airdrop, treasury). Exempt recipients bypass the cap entirely.
///
/// # The exact comparison
/// Let `post = dest_balance + transfer_amount`. The transfer is REJECTED iff
///
/// ```text
/// post * 100  >  total_supply * HOLDING_CAP_PERCENT      (== total_supply * 5)
/// ```
///
/// i.e. `post / total_supply > 5%`. Using a cross-multiplied integer comparison
/// (rather than dividing) avoids both floating point and rounding bias:
/// - `post * 100 == total_supply * 5`  → `post` is EXACTLY 5% → ALLOWED.
/// - `post * 100  > total_supply * 5`  → `post` is strictly > 5% → REJECTED.
///
/// All products are computed in `u128`. Each input is a `u64`, so
/// `post <= 2 * u64::MAX < u128::MAX`, and `post * 100` / `total_supply * 5`
/// are both `<= 100 * (2 * u64::MAX)`, far below `u128::MAX` — no overflow for
/// any real SPL supply. The `checked_*` calls are belt-and-suspenders and map to
/// `HoldingCapMathOverflow` instead of wrapping.
///
/// Edge case: `total_supply == 0` makes the RHS `0`, so any `post > 0` is
/// rejected and `post == 0` is allowed. A live mint with the hook installed
/// always has `supply > 0` (the curve is minted at init), so this is only a
/// defensive boundary.
pub fn holding_cap_allows(
    dest_balance: u64,
    transfer_amount: u64,
    total_supply: u64,
    is_exempt: bool,
) -> std::result::Result<(), HookError> {
    if is_exempt {
        return Ok(());
    }

    let post = (dest_balance as u128)
        .checked_add(transfer_amount as u128)
        .ok_or(HookError::HoldingCapMathOverflow)?;

    let lhs = post
        .checked_mul(100)
        .ok_or(HookError::HoldingCapMathOverflow)?;
    let rhs = (total_supply as u128)
        .checked_mul(HOLDING_CAP_PERCENT)
        .ok_or(HookError::HoldingCapMathOverflow)?;

    if lhs > rhs {
        return Err(HookError::HoldingCapExceeded);
    }
    Ok(())
}


#[program]
pub mod ipworld_hook {
    use super::*;

    /// Called once per mint (CPI from DBC, Step 3).
    /// Creates the ExtraAccountMetaList PDA — tells Token-2022
    /// which extra accounts to pass to Execute on every transfer.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        let account_metas = vec![
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: b"hook_config".to_vec() },
                    Seed::AccountKey { index: 1 }, // index 1 = mint in Execute layout
                ],
                false, false, // not signer, not writable
            )?,
        ];

        let account_size = ExtraAccountMetaList::size_of(account_metas.len())? as u64;
        let lamports = Rent::get()?.minimum_balance(account_size as usize);
        let mint = ctx.accounts.mint.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"extra-account-metas",
            mint.as_ref(),
            &[ctx.bumps.extra_account_meta_list],
        ]];

        create_account(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.extra_account_meta_list.to_account_info(),
                },
            )
            .with_signer(signer_seeds),
            lamports,
            account_size,
            ctx.program_id,
        )?;

        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &account_metas,
        )?;

        Ok(())
    }

    /// Called once per mint (CPI from DBC, Step 3).
    /// Stores pool_vault so Execute knows the curve address.
    ///
    /// SPEC-DBC-AUDIT-001 Phase 2: a front-runner must not be able to initialize
    /// this config (which would brick the token / neuter the transfer cap) nor
    /// seed an unverified `pool_vault`. Three guards close the gap:
    ///   1. (REQ-E-003) `authority` MUST equal DBC's `pool_authority` PDA — only
    ///      the legitimate pool-init CPI signs as that PDA;
    ///   2. (REQ-E-003) `pool_vault` is constrained (accounts struct) to be a real
    ///      token account for `mint` whose authority is that `pool_authority`; and
    ///   3. (SEC-P2-02) `pool_vault` MUST be the canonical PER-POOL base vault
    ///      `[TOKEN_VAULT_PREFIX, mint, pool]` under DBC — so the stored vault is
    ///      bound to THIS pool, not to any token account the global pool_authority
    ///      controls. Guard 1 alone only proves "some DBC pool-init is signing".
    ///
    /// CPI guarantee: the sole caller, DBC `ix_initialize_virtual_pool_with_token2022`,
    /// already passes the freshly-created canonical base vault and `base_mint`/`pool`.
    /// Guard 3 makes the hook self-validating regardless, as defense-in-depth.
    pub fn initialize_hook_config(
        ctx: Context<InitializeHookConfig>,
    ) -> Result<()> {
        // Guard 1: signer must be the canonical DBC pool_authority PDA.
        require_keys_eq!(
            ctx.accounts.authority.key(),
            derive_pool_authority(),
            HookError::InvalidAuthority
        );

        // Guard 3: pool_vault must be THIS pool's canonical base vault under DBC.
        require_keys_eq!(
            ctx.accounts.pool_vault.key(),
            derive_base_vault(&ctx.accounts.mint.key(), &ctx.accounts.pool.key()),
            HookError::InvalidPoolVault
        );

        let cfg = &mut ctx.accounts.hook_config;
        cfg.pool_vault = ctx.accounts.pool_vault.key();
        cfg.bump = ctx.bumps.hook_config;
        Ok(())
    }

    /// Transfer hook handler — called by Token-2022 on every transfer.
    /// Routed here via fallback() because Token-2022 uses SPL discriminator.
    ///
    /// GRADUATION SCOPING (SPEC-DBC-AUDIT-001 Phase 6 investigation): the DBC
    /// DAMM-v2 migration (`migrate_damm_v2_initialize_pool`, Step 6) NULLS this
    /// hook's `program_id` AND its authority on the mint's TransferHook
    /// extension. After graduation Token-2022 therefore never invokes this hook
    /// again. So this handler ONLY runs PRE-graduation, which means the P2P
    /// block (REQ-B-002) and the 5% holding cap (REQ-B-001) apply
    /// UNCONDITIONALLY whenever the hook runs — no `is_migrated`/graduation flag
    /// is needed (and none is available: the Execute context only carries
    /// source/mint/destination/owner + the hook's own PDAs, not the pool state).
    pub fn transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        let cfg = &ctx.accounts.hook_config;
        let src = ctx.accounts.source_token.key();
        let dst = ctx.accounts.destination_token.key();

        // REQ-B-002 (retained): pre-graduation P2P block. Permit a transfer only
        // if ONE side is the curve vault; block transfers between two non-vault
        // wallets. This is unchanged from the prior implementation.
        require!(
            src == cfg.pool_vault || dst == cfg.pool_vault,
            HookError::TransferNotThroughCurve
        );

        // REQ-B-001 (5% holding cap): the decision LOGIC is implemented and
        // unit-tested as the pure helper `holding_cap_allows(dest_balance,
        // transfer_amount, total_supply, is_exempt)`. It is intentionally NOT
        // activated on this live path yet, because doing so soundly requires the
        // set of EXEMPT recipients, and that set is NOT determinable here:
        //   - pool vault: known (cfg.pool_vault) and always exempt. ✓
        //   - airdrop wallet: NOT a fixed/stable address. Base-token airdrop
        //     fees accumulate in `pool.token_airdrop_base_fee` and are drained
        //     by an operator (ClaimAirdrop permission) to an OPERATOR-SUPPLIED
        //     destination chosen per-claim — there is no single airdrop wallet
        //     to record at hook-config time, and a stored one would be wrong the
        //     moment the operator drains to a different account.
        //   - treasury wallet: `ip_treasury` is set AFTER pool creation
        //     (`set_ip_treasury`) and lives in the per-pool TokenVerification
        //     account (keyed by pool, not mint) — not visible to this Execute
        //     context and not known at hook-config time.
        // Both airdrop and treasury claims move base tokens vault -> recipient
        // signed by `pool_authority`, which is STRUCTURALLY identical to a BUY
        // (vault -> buyer, also pool_authority-signed). The hook cannot tell a
        // protocol distribution from a whale BUY, so it cannot exempt one
        // without an explicit recipient allow-list — which the airdrop side
        // makes impossible without an out-of-scope change to the operator/claim
        // instructions or the hook account model.
        //
        // Per SPEC §"If the exempt addresses (airdrop/treasury) are NOT
        // determinable at hook-config time ... STOP and report rather than
        // guessing", the live wiring is deferred to a human decision on the
        // exempt-source mechanism. Activating it now with a single stored
        // airdrop/treasury wallet would BRICK any legitimate airdrop/treasury
        // claim whose recipient legitimately exceeds 5% of supply.
        //
        // Once the exempt mechanism is decided, activation is one line:
        //   let dest_balance = ctx.accounts.destination_token.amount;
        //   let total_supply = ctx.accounts.mint.supply;
        //   let is_exempt = dst == cfg.pool_vault /* || dst is airdrop/treasury */;
        //   holding_cap_allows(dest_balance, amount, total_supply, is_exempt)?;
        let _ = amount; // see note above — `amount` will feed `holding_cap_allows` once wired.

        Ok(())
    }

    /// Fallback: catches Token-2022 CPIs that use SPL discriminator format
    /// (not Anchor's). Routes Execute calls to transfer_hook.
    /// STANDARD PATTERN for all Anchor-based transfer hooks.
    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        let instruction = TransferHookInstruction::unpack(data)?;
        match instruction {
            TransferHookInstruction::Execute { amount } => {
                let amount_bytes = amount.to_le_bytes();
                __private::__global::transfer_hook(program_id, accounts, &amount_bytes)
            }
            _ => Err(ProgramError::InvalidInstructionData.into()),
        }
    }
}

// ============================================================
// Account structs
// ============================================================

/// Accounts for initialize_extra_account_meta_list
#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: ExtraAccountMetaList PDA. Created manually via create_account
    /// (not Anchor init) because it needs special TLV data format.
    #[account(
        mut,
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: AccountInfo<'info>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

/// Accounts for initialize_hook_config
#[derive(Accounts)]
pub struct InitializeHookConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// DBC pool_authority PDA must sign this CPI. Equality against the canonical
    /// `pool_authority` PDA is enforced in the handler (REQ-E-003 Guard 1).
    pub authority: Signer<'info>,

    /// The base token mint.
    pub mint: InterfaceAccount<'info, Mint>,

    /// The DBC `VirtualPool` this hook config belongs to. Used to bind `pool_vault`
    /// to the canonical per-pool base vault (SEC-P2-02 Guard 3, enforced in handler).
    /// CHECK: only its key participates in the base-vault PDA derivation.
    pub pool: UncheckedAccount<'info>,

    /// DBC's base token vault.
    /// REQ-E-003 Guard 2: a genuine token account for `mint` whose authority is the
    /// `pool_authority` signer. SEC-P2-02 Guard 3 (handler) additionally pins it to
    /// the canonical per-pool PDA `[TOKEN_VAULT_PREFIX, mint, pool]`, so it is THIS
    /// pool's vault — not merely some token account the global pool_authority owns.
    #[account(
        token::mint = mint,
        token::authority = authority,
    )]
    pub pool_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        seeds = [b"hook_config", mint.key().as_ref()],
        bump,
        payer = payer,
        space = 8 + 32 + 1, // discriminator + pool_vault + bump
    )]
    pub hook_config: Account<'info, HookConfig>,

    pub system_program: Program<'info, System>,
}

/// Accounts for transfer_hook (Execute handler).
/// Token-2022 passes the first 4 accounts in fixed order:
///   [0] source_token  [1] mint  [2] destination_token  [3] owner
///   [4] extra_account_meta_list (resolved by Token-2022)
///   [5+] extra accounts from the meta list (our HookConfig)
#[derive(Accounts)]
pub struct TransferHook<'info> {
    #[account(token::mint = mint)]
    pub source_token: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: source token account owner/delegate
    pub owner: UncheckedAccount<'info>,

    /// CHECK: ExtraAccountMetaList PDA
    #[account(
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// Our custom extra account: HookConfig PDA
    #[account(
        seeds = [b"hook_config", mint.key().as_ref()],
        bump = hook_config.bump,
    )]
    pub hook_config: Account<'info, HookConfig>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SPEC-DBC-AUDIT-001 Phase 2 (REQ-E-003): the `pool_authority` PDA derived
    /// in this program reproduces the canonical DBC `pool_authority` (documented
    /// as `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` in DBC `const_pda`).
    /// Guards the equality check used by Guard 1 against a seed/program-id typo.
    #[test]
    fn pool_authority_derivation_matches_dbc_canonical() {
        let derived = derive_pool_authority();
        let expected =
            Pubkey::from_str_const("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
        assert_eq!(
            derived, expected,
            "derived pool_authority must equal DBC's canonical pool_authority"
        );
    }

    /// A non-pool_authority signer is not the derived authority — the handler's
    /// `require_keys_eq!` (Guard 1) would therefore reject it.
    #[test]
    fn random_signer_is_not_pool_authority() {
        let random = Pubkey::new_unique();
        assert_ne!(random, derive_pool_authority());
    }

    /// SEC-P2-02: the per-pool base vault derivation uses the canonical DBC seeds
    /// `[TOKEN_VAULT_PREFIX, mint, pool]`. Guards Guard 3 against a seed typo.
    #[test]
    fn base_vault_uses_canonical_per_pool_seeds() {
        let mint = Pubkey::new_unique();
        let pool = Pubkey::new_unique();
        let derived = derive_base_vault(&mint, &pool);
        let (expected, _bump) = Pubkey::find_program_address(
            &[b"token_vault", mint.as_ref(), pool.as_ref()],
            &Pubkey::from_str_const("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"),
        );
        assert_eq!(derived, expected);
    }

    /// SEC-P2-02: the base vault is bound PER-POOL — the same mint under a
    /// different pool yields a different vault PDA, so a vault from another pool
    /// (even with the same mint) is rejected by Guard 3.
    #[test]
    fn base_vault_is_pool_specific() {
        let mint = Pubkey::new_unique();
        let pool_a = Pubkey::new_unique();
        let pool_b = Pubkey::new_unique();
        assert_ne!(
            derive_base_vault(&mint, &pool_a),
            derive_base_vault(&mint, &pool_b),
            "base vault must differ per pool even for the same mint"
        );
    }

    // =====================================================================
    // SPEC-DBC-AUDIT-001 Phase 6 (REQ-B-001): 5% holding-cap decision helper.
    // 1B-token supply with 9 decimals is the IPWorld norm; 5% = 50M whole
    // tokens. Tests use a round 1_000_000 supply (5% = 50_000) for readability,
    // plus an odd supply to exercise the strict-greater boundary precisely.
    //
    // `HookError` (an Anchor #[error_code] enum) does not derive PartialEq, so
    // these helpers assert the SPECIFIC outcome without comparing error values
    // directly (and without adding a derive to the production error type).
    // =====================================================================

    const SUPPLY: u64 = 1_000_000;
    const FIVE_PCT: u64 = 50_000; // exactly 5% of SUPPLY

    /// True iff the cap REJECTED the transfer with the holding-cap error.
    fn rejected(r: std::result::Result<(), HookError>) -> bool {
        matches!(r, Err(HookError::HoldingCapExceeded))
    }
    /// True iff the cap ALLOWED the transfer.
    fn allowed(r: std::result::Result<(), HookError>) -> bool {
        r.is_ok()
    }

    /// (a) Strictly more than 5% to a NON-exempt recipient is REJECTED.
    #[test]
    fn cap_rejects_above_5pct_for_non_exempt() {
        // dest starts empty; a single transfer of 50_001 (> 5%) must be rejected.
        assert!(rejected(holding_cap_allows(0, FIVE_PCT + 1, SUPPLY, false)));
    }

    /// (a') The crossing into >5% can come from the EXISTING balance plus the
    /// new amount, not just a single big transfer. 49_999 + 2 = 50_001 (> 5%).
    #[test]
    fn cap_rejects_when_post_balance_crosses_5pct() {
        assert!(rejected(holding_cap_allows(FIVE_PCT - 1, 2, SUPPLY, false)));
    }

    /// (b) EXACTLY 5% is ALLOWED (the boundary is inclusive).
    #[test]
    fn cap_allows_exactly_5pct_boundary() {
        assert!(allowed(holding_cap_allows(0, FIVE_PCT, SUPPLY, false)));
        // also reachable as existing + new == exactly 5%
        assert!(allowed(holding_cap_allows(FIVE_PCT - 10, 10, SUPPLY, false)));
    }

    /// (b') Just under 5% is allowed; one unit over is the first rejection.
    #[test]
    fn cap_boundary_is_strict_greater_than() {
        assert!(allowed(holding_cap_allows(0, FIVE_PCT - 1, SUPPLY, false)));
        assert!(allowed(holding_cap_allows(0, FIVE_PCT, SUPPLY, false)));
        assert!(rejected(holding_cap_allows(0, FIVE_PCT + 1, SUPPLY, false)));
    }

    /// (b'') Odd supply not divisible by 20: the cross-multiplied comparison
    /// must still treat exactly-5% as allowed and the next unit as rejected,
    /// with no rounding drift. supply=1_000_003 → 5% = 50_000.15, so the largest
    /// integer post-balance that is <= 5% is 50_000 (50_000*100=5_000_000 <=
    /// 1_000_003*5=5_000_015), and 50_001 (*100=5_000_100 > 5_000_015) rejects.
    #[test]
    fn cap_odd_supply_no_rounding_bias() {
        let odd_supply: u64 = 1_000_003;
        assert!(allowed(holding_cap_allows(0, 50_000, odd_supply, false)));
        assert!(rejected(holding_cap_allows(0, 50_001, odd_supply, false)));
    }

    /// (c) Each EXEMPT recipient bypasses the cap even FAR above 5% — including
    /// taking essentially the entire supply (the pool vault holds ~all supply
    /// pre-graduation, so this must always pass). `is_exempt` stands in for the
    /// pool vault / airdrop / treasury recipients.
    #[test]
    fn cap_exempt_recipient_always_allowed() {
        // 100% of supply to an exempt recipient: allowed.
        assert!(allowed(holding_cap_allows(0, SUPPLY, SUPPLY, true)));
        // exempt already holding most of supply, receiving more: allowed.
        assert!(allowed(holding_cap_allows(SUPPLY - 1, SUPPLY, SUPPLY, true)));
        // the SAME numbers that reject a non-exempt recipient pass when exempt.
        assert!(rejected(holding_cap_allows(0, FIVE_PCT + 1, SUPPLY, false)));
        assert!(allowed(holding_cap_allows(0, FIVE_PCT + 1, SUPPLY, true)));
    }

    /// Overflow safety: even the largest possible u64 inputs do not panic; the
    /// u128 intermediates absorb `2 * u64::MAX * 100` comfortably. A non-exempt
    /// recipient taking u64::MAX against a tiny supply is (correctly) rejected,
    /// and the same against an exempt recipient is allowed — neither overflows.
    #[test]
    fn cap_no_overflow_on_u64_extremes() {
        assert!(rejected(holding_cap_allows(u64::MAX, u64::MAX, 1, false)));
        assert!(allowed(holding_cap_allows(u64::MAX, u64::MAX, u64::MAX, true)));
    }

    /// Defensive boundary: zero supply rejects any positive post-balance for a
    /// non-exempt recipient (RHS is 0), and allows a zero-amount transfer. A live
    /// hooked mint always has supply > 0, so this only guards the math.
    #[test]
    fn cap_zero_supply_edge() {
        assert!(rejected(holding_cap_allows(0, 1, 0, false)));
        assert!(allowed(holding_cap_allows(0, 0, 0, false)));
    }
}
