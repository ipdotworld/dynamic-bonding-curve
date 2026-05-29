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
    pub fn transfer_hook(ctx: Context<TransferHook>, _amount: u64) -> Result<()> {
        let cfg = &ctx.accounts.hook_config;
        let src = ctx.accounts.source_token.key();
        let dst = ctx.accounts.destination_token.key();

        // Only check: one side must be the curve vault (no P2P transfers)
        require!(
            src == cfg.pool_vault || dst == cfg.pool_vault,
            HookError::TransferNotThroughCurve
        );

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
}
