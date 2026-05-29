use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    const_pda,
    safe_math::SafeMath,
    state::{
        config::PoolConfig,
        fee::{
            distribute_base_fee, distribute_quote_fee, AIRDROP_SHARE, IP_OWNER_SHARE,
            TOKEN_AIRDROP_SHARE,
        },
        MigrationProgress, VirtualPool,
    },
    PoolError,
};

/// Permissionless instruction to harvest accumulated LP fees from a DAMM v2 pool.
///
/// After graduation, all liquidity migrates to DAMM v2 and is permanently locked.
/// LP fees (SOL + token) accumulate in DAMM v2. Anyone (crank/bot) can call this
/// instruction to:
///   1. CPI into DAMM v2 `claim_position_fee` to collect accrued fees into our vaults
///   2. Distribute the collected SOL using the same quote_fee ratios as bonding curve swaps
///   3. Distribute the collected tokens using the same base_fee ratios
///   4. Accumulate into the same pool state counters used by bonding curve fees
///
/// This ensures fee distribution is consistent pre- and post-graduation with a single
/// set of claim instructions (claim_ip_owner_fee, claim_airdrop_fee, etc.).
///
/// Referral: skipped in harvest (no referral account available). Referral share goes
/// to treasury (protocol_quote_fee).
#[derive(Accounts)]
pub struct HarvestCtx<'info> {
    /// The bonding curve virtual pool — must be in CreatedPool state (post-graduation).
    #[account(
        mut,
        has_one = base_vault,
        has_one = quote_vault,
        has_one = config,
    )]
    pub pool: AccountLoader<'info, VirtualPool>,

    /// Pool config — validated via `has_one = config`. Fee shares are fixed
    /// program constants (REQ-A-006), so this account is not read in the handler.
    pub config: AccountLoader<'info, PoolConfig>,

    /// Pool authority PDA — signs the DAMM v2 CPI as the position owner.
    /// CHECK: Validated by address constraint.
    #[account(
        mut,
        address = const_pda::pool_authority::ID,
    )]
    pub pool_authority: AccountInfo<'info>,

    /// DBC base vault — receives the base token fees from DAMM v2.
    #[account(
        mut,
        token::mint = base_mint,
        token::token_program = token_base_program,
    )]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// DBC quote vault — receives the quote (SOL) fees from DAMM v2.
    #[account(
        mut,
        token::mint = quote_mint,
        token::token_program = token_quote_program,
    )]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Base token mint (the bonding curve token).
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Quote token mint (SOL wrapper).
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Payer — anyone can call this instruction (permissionless crank).
    /// Only pays the transaction fee; no authority checks are performed.
    #[account(mut)]
    pub payer: Signer<'info>,

    // --- DAMM v2 accounts required for claim_position_fee CPI ---

    /// DAMM v2 program.
    /// CHECK: Validated by address constraint against the known damm_v2 program ID.
    #[account(address = damm_v2::ID)]
    pub amm_program: UncheckedAccount<'info>,

    /// DAMM v2 pool account (the pool where LP fees have accumulated).
    /// CHECK: Passed directly to the DAMM v2 CPI.
    #[account(mut)]
    pub damm_pool: UncheckedAccount<'info>,

    /// DAMM v2 position account (the permanently locked LP position).
    /// CHECK: Passed directly to the DAMM v2 CPI.
    #[account(mut)]
    pub damm_position: UncheckedAccount<'info>,

    /// DAMM v2 pool authority (the DAMM v2 program PDA, not our pool_authority).
    /// CHECK: Passed directly to the DAMM v2 CPI.
    pub damm_pool_authority: UncheckedAccount<'info>,

    /// DAMM v2 token A vault (holds the base token inside DAMM v2).
    /// CHECK: Passed directly to the DAMM v2 CPI.
    #[account(mut)]
    pub damm_token_a_vault: UncheckedAccount<'info>,

    /// DAMM v2 token B vault (holds the quote token inside DAMM v2).
    /// CHECK: Passed directly to the DAMM v2 CPI.
    #[account(mut)]
    pub damm_token_b_vault: UncheckedAccount<'info>,

    /// The NFT token account that proves ownership of the DAMM v2 position.
    /// Owned by pool_authority PDA.
    /// CHECK: Passed directly to the DAMM v2 CPI.
    pub position_nft_account: UncheckedAccount<'info>,

    /// DAMM v2 event authority (required by Anchor CPI).
    /// CHECK: Passed directly to the DAMM v2 CPI.
    pub damm_event_authority: UncheckedAccount<'info>,

    /// Token program for the base token (Token-2022 for IPWorld pools).
    pub token_base_program: Interface<'info, TokenInterface>,

    /// Token program for the quote token (Token-2022 or SPL Token).
    pub token_quote_program: Interface<'info, TokenInterface>,

    /// System program (required by Anchor).
    pub system_program: Program<'info, System>,
}

pub fn handle_harvest<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, HarvestCtx<'info>>,
) -> Result<()> {
    // --- 1. Verify pool is in post-graduation state ---
    {
        let pool = ctx.accounts.pool.load()?;
        require!(
            pool.get_migration_progress()? == MigrationProgress::CreatedPool,
            PoolError::NotPermitToDoThisAction
        );
    }

    // --- 2. Snapshot vault balances before CPI ---
    ctx.accounts.base_vault.reload()?;
    ctx.accounts.quote_vault.reload()?;
    let base_before = ctx.accounts.base_vault.amount;
    let quote_before = ctx.accounts.quote_vault.amount;

    // --- 3. CPI to DAMM v2 claim_position_fee ---
    // pool_authority PDA is the owner of the position NFT and signs the CPI.
    {
        let bump = const_pda::pool_authority::BUMP;
        let pool_authority_seeds = pool_authority_seeds!(bump);

        damm_v2::cpi::claim_position_fee(
            CpiContext::new_with_signer(
                ctx.accounts.amm_program.to_account_info(),
                damm_v2::cpi::accounts::ClaimPositionFee {
                    pool_authority: ctx.accounts.damm_pool_authority.to_account_info(),
                    pool: ctx.accounts.damm_pool.to_account_info(),
                    position: ctx.accounts.damm_position.to_account_info(),
                    token_a_account: ctx.accounts.base_vault.to_account_info(),
                    token_b_account: ctx.accounts.quote_vault.to_account_info(),
                    token_a_vault: ctx.accounts.damm_token_a_vault.to_account_info(),
                    token_b_vault: ctx.accounts.damm_token_b_vault.to_account_info(),
                    token_a_mint: ctx.accounts.base_mint.to_account_info(),
                    token_b_mint: ctx.accounts.quote_mint.to_account_info(),
                    position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
                    owner: ctx.accounts.pool_authority.to_account_info(),
                    token_a_program: ctx.accounts.token_base_program.to_account_info(),
                    token_b_program: ctx.accounts.token_quote_program.to_account_info(),
                    event_authority: ctx.accounts.damm_event_authority.to_account_info(),
                    program: ctx.accounts.amm_program.to_account_info(),
                },
                &[&pool_authority_seeds[..]],
            ),
        )?;
    }

    // --- 4. Reload vaults and compute collected amounts ---
    ctx.accounts.base_vault.reload()?;
    ctx.accounts.quote_vault.reload()?;
    let base_after = ctx.accounts.base_vault.amount;
    let quote_after = ctx.accounts.quote_vault.amount;

    let collected_base = base_after.safe_sub(base_before)?;
    let collected_quote = quote_after.safe_sub(quote_before)?;

    // Nothing to distribute if DAMM v2 had no accumulated fees.
    if collected_base == 0 && collected_quote == 0 {
        return Ok(());
    }

    // SPEC-DBC-AUDIT-001 Phase 1 (REQ-A-006): the config account is still
    // validated by the `has_one = config` constraint, but the handler no longer
    // reads `config.*_share` — fee shares are now fixed program constants
    // (`IP_OWNER_SHARE`, `AIRDROP_SHARE`, `TOKEN_AIRDROP_SHARE`). No `config`
    // load is required here.
    let mut pool = ctx.accounts.pool.load_mut()?;

    // --- 5. Distribute collected SOL (quote) fees ---
    // SPEC-DBC-004 Phase 2 (REQ-S-005): same recipient ratios as
    // `apply_swap_result` quote distribution. Implementation centralized in
    // `state::fee::distribute_quote_fee`.
    // SPEC-DBC-004 Phase 3 (REQ-I-001): `creator_share` removed; distribution
    // is now 3-way at the helper level (ip_owner + airdrop + treasury).
    // No referral in harvest (no referral account), so the full collected
    // amount is distributable; referral share folds into treasury.
    // SPEC-DBC-AUDIT-001 Phase 1 (REQ-A-006): use the SAME fixed program
    // constants as the swap path (`apply_swap_result`), not mutable per-pool
    // `config.*_share`. Harvest credits ip_owner/airdrop/treasury quote sinks;
    // it does NOT touch `protocol_base_fee` (consistent with REQ-A-001).
    if collected_quote > 0 {
        let (ip_owner, airdrop, treasury) = distribute_quote_fee(
            collected_quote,
            IP_OWNER_SHARE,
            AIRDROP_SHARE,
        )?;

        pool.ip_owner_quote_fee = pool.ip_owner_quote_fee.safe_add(ip_owner)?;
        pool.airdrop_quote_fee = pool.airdrop_quote_fee.safe_add(airdrop)?;
        pool.protocol_quote_fee = pool.protocol_quote_fee.safe_add(treasury)?;
    }

    // --- 6. Distribute collected token (base) fees ---
    // SPEC-DBC-004 Phase 2 (REQ-S-005): same recipient ratios as
    // `apply_swap_result` base distribution. Implementation centralized in
    // `state::fee::distribute_base_fee`.
    if collected_base > 0 {
        // REQ-A-006: fixed `TOKEN_AIRDROP_SHARE` (40%), ip_treasury gets residual.
        let (token_airdrop, ip_treasury) =
            distribute_base_fee(collected_base, TOKEN_AIRDROP_SHARE)?;

        pool.token_airdrop_base_fee = pool.token_airdrop_base_fee.safe_add(token_airdrop)?;
        pool.ip_treasury_base_fee = pool.ip_treasury_base_fee.safe_add(ip_treasury)?;
    }

    Ok(())
}
