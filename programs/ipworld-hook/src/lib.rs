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

declare_id!("HooK1111111111111111111111111111111111111111");

/// Maximum ownership per wallet: 5% = 500 basis points
const MAX_OWNERSHIP_BPS: u64 = 500;
const BPS_DENOMINATOR: u64 = 10_000;

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
    pub fn initialize_hook_config(
        ctx: Context<InitializeHookConfig>,
    ) -> Result<()> {
        let cfg = &mut ctx.accounts.hook_config;
        cfg.pool_vault = ctx.accounts.pool_vault.key();
        cfg.bump = ctx.bumps.hook_config;
        Ok(())
    }

    /// Transfer hook handler — called by Token-2022 on every transfer.
    /// Routed here via fallback() because Token-2022 uses SPL discriminator.
    pub fn transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        let cfg = &ctx.accounts.hook_config;
        let src = ctx.accounts.source_token.key();
        let dst = ctx.accounts.destination_token.key();

        // Check 1: One side must be the curve vault (no P2P)
        require!(
            src == cfg.pool_vault || dst == cfg.pool_vault,
            HookError::TransferNotThroughCurve
        );

        // Check 2: Ownership cap on buys (destination != vault = buying)
        // Uses u128 to avoid overflow: balance * 10000 can exceed u64::MAX
        // for tokens with large supply + high decimals
        if dst != cfg.pool_vault {
            // Token-2022 credits destination BEFORE calling the hook,
            // so destination_token.amount already includes the transfer amount.
            let dst_balance = ctx.accounts.destination_token.amount as u128;
            let supply = ctx.accounts.mint.supply as u128;
            require!(
                dst_balance * (BPS_DENOMINATOR as u128)
                    <= (MAX_OWNERSHIP_BPS as u128) * supply,
                HookError::ExceedsMaxOwnership
            );
        }

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

    /// DBC pool_authority PDA must sign this CPI.
    pub authority: Signer<'info>,

    /// CHECK: The base token mint.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: DBC's base token vault.
    pub pool_vault: UncheckedAccount<'info>,

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
