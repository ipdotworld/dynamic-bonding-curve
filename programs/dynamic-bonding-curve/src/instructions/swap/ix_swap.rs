use std::u64;

use crate::instruction::InitializeVirtualPoolWithToken2022;
use crate::instruction::Swap as SwapInstruction;
use crate::math::safe_math::SafeMath;
use crate::state::MigrationProgress;
use crate::swap::swap_exact_in::process_swap_exact_in;
use crate::swap::swap_exact_out::process_swap_exact_out;
use crate::swap::swap_partial_fill::process_swap_partial_fill;
use crate::swap::{ProcessSwapParams, ProcessSwapResult};
use crate::{
    activation_handler::get_current_point,
    const_pda,
    params::swap::TradeDirection,
    state::fee::FeeMode,
    state::{PoolConfig, VirtualPool},
    token::{transfer_token_from_pool_authority, transfer_token_from_user},
    EvtSwap, PoolError,
};
use crate::{EvtCurveComplete, EvtSwap2};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{
    get_processed_sibling_instruction, get_stack_height, Instruction,
};
use anchor_lang::solana_program::sysvar;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::state::IpworldState;
use crate::state::TokenVerification;
use crate::state::auth_structs::TradeAuth;
use crate::utils::verify_authority_sig::verify_authority_sig;
use num_enum::{IntoPrimitive, TryFromPrimitive};

/// Byte offset of the `referral` field inside `TokenVerification`'s account data.
///
/// Layout: discriminator(8) + ipa_id(32) + ip_owner(32) + pending_ip_owner(32)
/// + ip_treasury(32) + referral(32)…  →  referral begins at 8+32+32+32+32 = 136.
/// (See `state::token_verification::TokenVerification`.)
const TV_REFERRAL_OFFSET: usize = 8 + 32 + 32 + 32 + 32;

/// Validate the supplied `TokenVerification` account and return the registered
/// `referral` wallet for `pool`.
///
/// SPEC-DBC-AUDIT-001 Phase 2 (REQ-A-003). Validation mirrors the vault's
/// REQ-E-004 guard so the same spoof cannot be replayed on the swap path:
///   1. the account MUST be present (referral payout requires it);
///   2. it MUST be owned by THIS program (DBC) — defeats a self-owned look-alike;
///   3. it MUST be the canonical PDA `[TokenVerification::SEED, pool]`;
///   4. its discriminator MUST match Anchor's `TokenVerification` discriminator.
/// Only then is the `referral` field (offset 136) trusted.
fn read_verified_referral(
    token_verification: Option<&UncheckedAccount>,
    pool: &Pubkey,
) -> Result<Pubkey> {
    let tv = token_verification.ok_or(PoolError::MissingTokenVerification)?;

    // (2) owner == DBC program.
    require_keys_eq!(*tv.owner, crate::ID, PoolError::InvalidTokenVerification);

    // (3) canonical PDA for this pool.
    let (expected, _bump) =
        Pubkey::find_program_address(&[TokenVerification::SEED, pool.as_ref()], &crate::ID);
    require_keys_eq!(tv.key(), expected, PoolError::InvalidTokenVerification);

    let data = tv.try_borrow_data()?;
    require!(
        data.len() >= TV_REFERRAL_OFFSET + 32,
        PoolError::InvalidTokenVerification
    );
    // (4) discriminator match (first 8 bytes of sha256("account:TokenVerification")).
    require!(
        &data[..8] == TokenVerification::DISCRIMINATOR,
        PoolError::InvalidTokenVerification
    );

    let mut referral_bytes = [0u8; 32];
    referral_bytes.copy_from_slice(&data[TV_REFERRAL_OFFSET..TV_REFERRAL_OFFSET + 32]);
    Ok(Pubkey::new_from_array(referral_bytes))
}

// only be use for swap exact in
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SwapParameters {
    pub amount_in: u64,
    pub minimum_amount_out: u64,
}

// can be used for different swap_mode
#[derive(AnchorSerialize, AnchorDeserialize, Default)]
pub struct SwapParameters2 {
    /// When it's exact in, partial fill, this will be amount_in. When it's exact out, this will be amount_out
    pub amount_0: u64,
    /// When it's exact in, partial fill, this will be minimum_amount_out. When it's exact out, this will be maximum_amount_in
    pub amount_1: u64,
    /// Swap mode, refer [SwapMode]
    pub swap_mode: u8,
}

#[repr(u8)]
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    IntoPrimitive,
    TryFromPrimitive,
    AnchorDeserialize,
    AnchorSerialize,
)]
pub enum SwapMode {
    ExactIn,
    PartialFill,
    ExactOut,
}

#[event_cpi]
#[derive(Accounts)]
pub struct SwapCtx<'info> {
    /// CHECK: pool authority
    #[account(
        address = const_pda::pool_authority::ID,
    )]
    pub pool_authority: AccountInfo<'info>,

    /// config key
    pub config: AccountLoader<'info, PoolConfig>,

    /// Pool account
    #[account(mut, has_one = base_vault, has_one = quote_vault, has_one = config)]
    pub pool: AccountLoader<'info, VirtualPool>,

    /// The user token account for input token
    #[account(mut)]
    pub input_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The user token account for output token
    #[account(mut)]
    pub output_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The vault token account for base token
    #[account(mut, token::token_program = token_base_program, token::mint = base_mint)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The vault token account for quote token
    #[account(mut, token::token_program = token_quote_program, token::mint = quote_mint)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The mint of base token
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,

    /// The mint of quote token
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    /// The user performing the swap
    pub payer: Signer<'info>,

    /// Token base program
    pub token_base_program: Interface<'info, TokenInterface>,

    /// Token quote program
    pub token_quote_program: Interface<'info, TokenInterface>,

    /// referral token account
    #[account(mut)]
    pub referral_token_account: Option<Box<InterfaceAccount<'info, TokenAccount>>>,

    /// DBC `TokenVerification` PDA for `pool` — REQUIRED only when a referral
    /// payout is requested (i.e. `referral_token_account` is `Some`).
    ///
    /// SPEC-DBC-AUDIT-001 Phase 2 (REQ-A-003): the referral fee must only be
    /// payable to the on-chain-registered referral wallet. We read the stored
    /// `TokenVerification.referral` and require the supplied
    /// `referral_token_account` to be owned by it. The account is validated for
    /// authenticity (owner == this program AND canonical PDA `[TokenVerification::SEED, pool]`)
    /// inside the handler before any byte is trusted.
    /// CHECK: validated in `handle_swap_wrapper` (owner + canonical PDA + discriminator).
    pub token_verification: Option<UncheckedAccount<'info>>,

    // --- ipworld trade auth accounts (Step 7) ---

    /// IpworldState PDA — holds the authority pubkey we verify the Ed25519 signature against
    #[account(
        seeds = [b"ipworld_state"],
        bump = ipworld_state.bump,
    )]
    pub ipworld_state: Account<'info, IpworldState>,

    /// CHECK: Instructions sysvar — needed to introspect the Ed25519 verify ix
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

impl<'info> SwapCtx<'info> {
    /// Get the trading direction of the current swap. Eg: USDT -> USDC
    pub fn get_trade_direction(&self) -> TradeDirection {
        if self.input_token_account.mint == self.base_mint.key() {
            return TradeDirection::BaseToQuote;
        }
        TradeDirection::QuoteToBase
    }
}

pub fn handle_swap_wrapper<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, SwapCtx<'info>>,
    params: SwapParameters2,
) -> Result<()> {
    let SwapParameters2 {
        amount_0,
        amount_1,
        swap_mode,
        ..
    } = params;

    let swap_mode = SwapMode::try_from(swap_mode).map_err(|_| PoolError::TypeCastFailed)?;

    let trade_direction = ctx.accounts.get_trade_direction();

    // --- Verify backend-signed TradeAuth (buys only) ---
    // Sells (BaseToQuote) are always allowed so users can exit even if
    // the auth backend is unavailable.
    // SPEC-DBC-AUDIT-001 REQ-D-005 (ACCEPTED RISK): TradeAuth.expires_at has no
    // on-chain TTL cap; a leaked signature is replayable platform-wide until expiry.
    // Accepted under backend-trust (see auth_structs.rs TradeAuth + Risk Register RR-10).
    if trade_direction == TradeDirection::QuoteToBase {
        let trade_auth: TradeAuth = verify_authority_sig(
            &ctx.accounts.instructions_sysvar,
            &ctx.accounts.ipworld_state,
        )?;
        require!(
            trade_auth.user == ctx.accounts.payer.key(),
            PoolError::UnauthorizedTrade
        );
        let clock = Clock::get()?;
        require!(
            trade_auth.expires_at > clock.unix_timestamp,
            PoolError::TradeAuthExpired
        );
    }
    let (
        token_in_mint,
        token_out_mint,
        input_vault_account,
        output_vault_account,
        input_program,
        output_program,
    ) = match trade_direction {
        TradeDirection::BaseToQuote => (
            &ctx.accounts.base_mint,
            &ctx.accounts.quote_mint,
            &ctx.accounts.base_vault,
            &ctx.accounts.quote_vault,
            &ctx.accounts.token_base_program,
            &ctx.accounts.token_quote_program,
        ),
        TradeDirection::QuoteToBase => (
            &ctx.accounts.quote_mint,
            &ctx.accounts.base_mint,
            &ctx.accounts.quote_vault,
            &ctx.accounts.base_vault,
            &ctx.accounts.token_quote_program,
            &ctx.accounts.token_base_program,
        ),
    };

    require!(amount_0 > 0, PoolError::AmountIsZero);

    let has_referral = ctx.accounts.referral_token_account.is_some();

    let config = ctx.accounts.config.load()?;
    let mut pool = ctx.accounts.pool.load_mut()?;

    let current_point = get_current_point(config.activation_type)?;

    // another validation to prevent snipers to craft multiple swap instructions in 1 tx
    // (if we dont do this, they are able to concat 16 swap instructions in 1 tx)
    let rate_limiter = config.pool_fees.base_fee.get_fee_rate_limiter();
    if let Ok(rate_limiter) = &rate_limiter {
        if rate_limiter.is_rate_limiter_applied(
            current_point,
            pool.activation_point,
            trade_direction,
        )? {
            validate_single_swap_instruction(&ctx.accounts.pool.key(), ctx.remaining_accounts)?;
        }
    }

    let eligible_for_first_swap_with_min_fee = config.is_first_swap_with_min_fee_enabled()
        && pool.is_first_swap()
        && validate_contain_initialize_pool_ix_and_no_cpi(
            &ctx.accounts.pool.key(),
            &ctx.accounts.referral_token_account,
            ctx.remaining_accounts,
        )
        .is_ok();

    // validate if it is over threshold
    require!(
        !pool.is_curve_complete(config.migration_quote_threshold),
        PoolError::PoolIsCompleted
    );

    // update for dynamic fee reference
    let current_timestamp = Clock::get()?.unix_timestamp as u64;
    pool.update_pre_swap(&config, current_timestamp)?;

    let fee_mode = &FeeMode::get_fee_mode(config.collect_fee_mode, trade_direction, has_referral)?;

    let process_swap_params = ProcessSwapParams {
        pool: &mut pool,
        config: &config,
        fee_mode,
        trade_direction,
        current_point,
        amount_0,
        amount_1,
        eligible_for_first_swap_with_min_fee,
    };

    let ProcessSwapResult {
        swap_result: swap_result_2,
        swap_in_parameters,
    } = match swap_mode {
        SwapMode::ExactIn => process_swap_exact_in(process_swap_params)?,
        SwapMode::PartialFill => process_swap_partial_fill(process_swap_params)?,
        SwapMode::ExactOut => process_swap_exact_out(process_swap_params)?,
    };

    let swap_result = swap_result_2.get_swap_result();
    pool.apply_swap_result(
        &config,
        &swap_result,
        fee_mode,
        trade_direction,
        current_timestamp,
    )?;

    // send to reserve
    transfer_token_from_user(
        &ctx.accounts.payer,
        token_in_mint,
        &ctx.accounts.input_token_account,
        input_vault_account,
        input_program,
        swap_result_2.included_fee_input_amount,
        ctx.remaining_accounts,
    )?;

    // send to user
    transfer_token_from_pool_authority(
        ctx.accounts.pool_authority.to_account_info(),
        token_out_mint,
        output_vault_account,
        ctx.accounts.output_token_account.to_account_info(),
        output_program,
        swap_result.output_amount,
        ctx.remaining_accounts,
    )?;

    // send to referral
    //
    // SPEC-DBC-AUDIT-001 Phase 2 (REQ-A-009): the former BUY branch
    // (`fees_on_base_token == true`) paid a base-token referral that was ALSO
    // folded into the base-fee counters via `total_fee` in `apply_swap_result`
    // (that branch does NOT subtract `referral_fee`) — a double-spend out of
    // `base_vault`. It is removed. The referral is now paid ONLY on the quote
    // side, gated on `!fee_mode.fees_on_base_token`. This is exactly the set of
    // cases where `apply_swap_result` EXCLUDED `referral_fee` from the on-chain
    // counters (`distributable = total_fee - referral_fee`), so the payout here
    // keeps fund conservation: every excluded `referral_fee` leaves the vault,
    // and nothing that stayed in a counter is also paid out.
    //
    // SPEC-DBC-AUDIT-001 Phase 2 (REQ-A-003): the destination is validated against
    // the on-chain-registered `TokenVerification.referral` for this pool. A
    // caller-supplied `referral_token_account` is no longer trusted blindly.
    if !fee_mode.fees_on_base_token {
        if let Some(referral_token_account) = ctx.accounts.referral_token_account.as_ref() {
            // `has_referral` was true (referral_token_account is Some), so the fee
            // math allocated a (possibly non-zero) `referral_fee` and EXCLUDED it
            // from the on-chain counters. It MUST leave the vault here, to the
            // verified referral, or the tx must revert — skipping would strand
            // `referral_fee` and break conservation.
            let stored_referral = read_verified_referral(
                ctx.accounts.token_verification.as_ref(),
                &ctx.accounts.pool.key(),
            )?;

            // The supplied destination MUST be owned by the registered referral.
            // (When no referrer is configured the stored referral is the default
            // pubkey; clients MUST then omit `referral_token_account` so
            // `has_referral` is false and `referral_fee == 0`. Supplying one here
            // reverts — a safe failure, never a silent drain.)
            require_keys_eq!(
                referral_token_account.owner,
                stored_referral,
                PoolError::InvalidReferralAccount
            );

            transfer_token_from_pool_authority(
                ctx.accounts.pool_authority.to_account_info(),
                &ctx.accounts.quote_mint,
                &ctx.accounts.quote_vault,
                referral_token_account.to_account_info(),
                &ctx.accounts.token_quote_program,
                swap_result.referral_fee,
                ctx.remaining_accounts,
            )?;
        }
    }

    emit_cpi!(EvtSwap {
        pool: ctx.accounts.pool.key(),
        config: ctx.accounts.config.key(),
        trade_direction: trade_direction.into(),
        has_referral,
        params: swap_in_parameters,
        swap_result,
        amount_in: swap_result_2.included_fee_input_amount,
        current_timestamp,
    });

    emit_cpi!(EvtSwap2 {
        pool: ctx.accounts.pool.key(),
        config: ctx.accounts.config.key(),
        trade_direction: trade_direction.into(),
        has_referral,
        swap_parameters: params,
        swap_result: swap_result_2,
        quote_reserve_amount: pool.quote_reserve,
        migration_threshold: config.migration_quote_threshold,
        current_timestamp,
    });

    if pool.is_curve_complete(config.migration_quote_threshold) {
        ctx.accounts.base_vault.reload()?;
        // validate if base reserve is enough token for migration
        let base_vault_balance = ctx.accounts.base_vault.amount;

        let required_base_balance = config
            .migration_base_threshold
            .safe_add(pool.get_protocol_and_trading_base_fee()?)?
            .safe_add(
                config
                    .locked_vesting_config
                    .to_locked_vesting_params()
                    .get_total_amount()?,
            )?;

        require!(
            base_vault_balance >= required_base_balance,
            PoolError::InsufficientLiquidityForMigration
        );

        // set finish time and migration progress
        pool.finish_curve_timestamp = current_timestamp;

        let locked_vesting_params = config.locked_vesting_config.to_locked_vesting_params();
        if locked_vesting_params.has_vesting() {
            pool.set_migration_progress(MigrationProgress::PostBondingCurve.into());
        } else {
            pool.set_migration_progress(MigrationProgress::LockedVesting.into());
        }

        emit_cpi!(EvtCurveComplete {
            pool: ctx.accounts.pool.key(),
            config: ctx.accounts.config.key(),
            base_reserve: pool.base_reserve,
            quote_reserve: pool.quote_reserve,
        })
    }

    Ok(())
}

pub fn validate_single_swap_instruction<'c, 'info>(
    pool: &Pubkey,
    remaining_accounts: &'c [AccountInfo<'info>],
) -> Result<()> {
    let instruction_sysvar_account_info = remaining_accounts
        .get(0)
        .ok_or_else(|| PoolError::FailToValidateSingleSwapInstruction)?;

    // get current index of instruction
    let current_index =
        sysvar::instructions::load_current_index_checked(instruction_sysvar_account_info)?;
    let current_instruction = sysvar::instructions::load_instruction_at_checked(
        current_index.into(),
        instruction_sysvar_account_info,
    )?;

    if current_instruction.program_id != crate::ID {
        // check if current instruction is CPI
        // disable any stack height greater than 2
        if get_stack_height() > 2 {
            return Err(PoolError::FailToValidateSingleSwapInstruction.into());
        }
        // check for any sibling instruction
        let mut sibling_index = 0;
        while let Some(sibling_instruction) = get_processed_sibling_instruction(sibling_index) {
            if sibling_instruction.program_id == crate::ID {
                require!(
                    !is_instruction_include_pool_swap(&sibling_instruction, pool),
                    PoolError::FailToValidateSingleSwapInstruction
                );
            }

            sibling_index = sibling_index.safe_add(1)?;
        }
    }

    if current_index == 0 {
        // skip for first instruction
        return Ok(());
    }
    for i in 0..current_index {
        let instruction = sysvar::instructions::load_instruction_at_checked(
            i.into(),
            instruction_sysvar_account_info,
        )?;

        if instruction.program_id != crate::ID {
            // we treat any instruction including that pool address is other swap ix
            for i in 0..instruction.accounts.len() {
                if instruction.accounts[i].pubkey.eq(pool) {
                    msg!("Multiple swaps not allowed");
                    return Err(PoolError::FailToValidateSingleSwapInstruction.into());
                }
            }
        } else {
            require!(
                !is_instruction_include_pool_swap(&instruction, pool),
                PoolError::FailToValidateSingleSwapInstruction
            );
        }
    }
    Ok(())
}

fn is_instruction_include_pool_swap(instruction: &Instruction, pool: &Pubkey) -> bool {
    let instruction_discriminator = &instruction.data[..8];
    // Single canonical `swap` entrypoint (former `swap2`; legacy `swap` wrapper removed
    // in SPEC-DBC-AUDIT-001 Phase 8 — REQ-F-003), so only one discriminator to match.
    if instruction_discriminator.eq(SwapInstruction::DISCRIMINATOR) {
        return instruction.accounts[2].pubkey.eq(pool);
    }
    false
}

#[cfg(test)]
mod referral_validation_tests {
    use super::*;
    use anchor_lang::Discriminator;

    /// REQ-A-003: a referral payout requested without the `TokenVerification`
    /// account is rejected (cannot validate the destination).
    #[test]
    fn missing_token_verification_is_rejected() {
        let pool = Pubkey::new_unique();
        let res = read_verified_referral(None, &pool);
        assert!(res.is_err(), "referral payout without TV must be rejected");
    }

    /// REQ-A-003: the referral field offset matches the `TokenVerification` layout
    /// (discriminator + ipa_id + ip_owner + pending_ip_owner + ip_treasury = 136).
    #[test]
    fn referral_offset_matches_layout() {
        assert_eq!(TV_REFERRAL_OFFSET, 136);
        // And the field fits inside the declared account length.
        assert!(TV_REFERRAL_OFFSET + 32 <= TokenVerification::LEN);
    }

    /// The canonical TV PDA used for validation is derived from
    /// `[TokenVerification::SEED, pool]` against THIS program — the same seeds
    /// every DBC instruction uses to load the account.
    #[test]
    fn canonical_tv_pda_uses_expected_seeds() {
        let pool = Pubkey::new_unique();
        let (expected, _b) =
            Pubkey::find_program_address(&[TokenVerification::SEED, pool.as_ref()], &crate::ID);
        let (again, _b2) =
            Pubkey::find_program_address(&[b"token_verification", pool.as_ref()], &crate::ID);
        assert_eq!(expected, again);
    }

    /// The discriminator we compare against is the canonical Anchor account
    /// discriminator for `TokenVerification` (8 bytes), matching the value the
    /// vault hard-codes for the same account.
    #[test]
    fn token_verification_discriminator_is_eight_bytes() {
        assert_eq!(TokenVerification::DISCRIMINATOR.len(), 8);
        // Same bytes the ip-owner-vault hard-codes: sha256("account:TokenVerification")[..8].
        assert_eq!(
            TokenVerification::DISCRIMINATOR,
            &[0x04, 0xdf, 0x60, 0xe7, 0x1e, 0xde, 0x90, 0x82]
        );
    }
}

// Note: initialize_pool ix must be before swap ix and at the top level (no cpi)
pub fn validate_contain_initialize_pool_ix_and_no_cpi<'c: 'info, 'info>(
    pool: &Pubkey,
    referral_token_account: &Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    remaining_accounts: &'c [AccountInfo<'info>],
) -> Result<()> {
    // just use a random error
    // not allow user to bypass referral fee
    require!(
        referral_token_account.is_none(),
        PoolError::UndeterminedError
    );
    let instruction_sysvar_account_info = remaining_accounts
        .get(0)
        .ok_or_else(|| PoolError::UndeterminedError)?;

    require!(
        instruction_sysvar_account_info
            .key
            .eq(&sysvar::instructions::ID),
        PoolError::UndeterminedError
    );

    let current_index =
        sysvar::instructions::load_current_index_checked(instruction_sysvar_account_info)?;

    let current_instruction = sysvar::instructions::load_instruction_at_checked(
        current_index.into(),
        instruction_sysvar_account_info,
    )?;

    require!(
        current_instruction.program_id.eq(&crate::ID),
        PoolError::UndeterminedError
    );

    for i in 0..current_index {
        let instruction = sysvar::instructions::load_instruction_at_checked(
            i.into(),
            instruction_sysvar_account_info,
        )?;

        if instruction.program_id == crate::ID {
            let disc = &instruction.data[..8];

            // SPEC-DBC-AUDIT-001 Phase 6 (REQ-G-001): the SPL pool-init
            // discriminator branch was dropped with the SPL path. Only
            // Token-2022 pools can be created, so a same-tx pool-init bundled
            // with this swap can only be the Token-2022 instruction.
            if disc.eq(InitializeVirtualPoolWithToken2022::DISCRIMINATOR) {
                const VIRTUAL_POOL_ACCOUNT_INDEX: usize = 5;
                let Some(account) = instruction.accounts.get(VIRTUAL_POOL_ACCOUNT_INDEX) else {
                    continue;
                };

                if account.pubkey.eq(pool) {
                    //pass
                    return Ok(());
                }
            }
        }
    }

    Err(PoolError::UndeterminedError.into())
}
