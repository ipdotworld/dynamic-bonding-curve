use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("3DuLUcRJpiSubGnDtE7LLaJVdKxUSoUqKFHHmT6KBSqC");

/// Total BPS must sum to 10_000.
const BPS_DENOMINATOR: u64 = 10_000;

// ─── State ──────────────────────────────────────────────────────────────────

#[account]
pub struct FeeConfig {
    /// The token mint this config is for.
    pub base_mint: Pubkey,
    /// Authority that can update_owner. Typically ipworld backend.
    pub authority: Pubkey,
    /// Treasury wallet (global — same across all tokens).
    pub treasury: Pubkey,
    /// Community wallet (global — backend does holder + UGC airdrops from here).
    pub community: Pubkey,
    /// Owner wallet (per-token — starts as community, updated when verified).
    pub owner: Pubkey,
    /// Split ratios in BPS. Must sum to 10_000.
    pub treasury_bps: u16,
    pub community_bps: u16,
    pub owner_bps: u16,
    /// PDA bump.
    pub bump: u8,
}

impl FeeConfig {
    pub const LEN: usize = 8 // discriminator
        + 32  // base_mint
        + 32  // authority
        + 32  // treasury
        + 32  // community
        + 32  // owner
        + 2   // treasury_bps
        + 2   // community_bps
        + 2   // owner_bps
        + 1;  // bump
}

// ─── Errors ─────────────────────────────────────────────────────────────────

#[error_code]
pub enum SplitterError {
    #[msg("BPS values must sum to 10000")]
    InvalidBps,
    #[msg("Vault is empty — nothing to distribute")]
    EmptyVault,
}

// ─── Instructions ───────────────────────────────────────────────────────────

#[program]
pub mod ipworld_splitter {
    use super::*;

    /// Initialize a fee config for a specific token mint.
    /// Owner defaults to community address until verified.
    pub fn init_fee_config(
        ctx: Context<InitFeeConfig>,
        treasury_bps: u16,
        community_bps: u16,
        owner_bps: u16,
    ) -> Result<()> {
        require!(
            (treasury_bps as u64) + (community_bps as u64) + (owner_bps as u64) == BPS_DENOMINATOR,
            SplitterError::InvalidBps
        );

        let config = &mut ctx.accounts.fee_config;
        config.base_mint = ctx.accounts.base_mint.key();
        config.authority = ctx.accounts.authority.key();
        config.treasury = ctx.accounts.treasury.key();
        config.community = ctx.accounts.community.key();
        config.owner = ctx.accounts.community.key(); // defaults to community
        config.treasury_bps = treasury_bps;
        config.community_bps = community_bps;
        config.owner_bps = owner_bps;
        config.bump = ctx.bumps.fee_config;

        msg!(
            "fee config initialized for mint {} — treasury {}bps, community {}bps, owner {}bps",
            config.base_mint,
            treasury_bps,
            community_bps,
            owner_bps
        );
        Ok(())
    }

    /// Permissionless: distribute vault balance to treasury, community, and owner.
    pub fn distribute(ctx: Context<Distribute>) -> Result<()> {
        let vault_balance = ctx.accounts.vault.amount;
        require!(vault_balance > 0, SplitterError::EmptyVault);

        let config = &ctx.accounts.fee_config;
        let treasury_amount = vault_balance
            .checked_mul(config.treasury_bps as u64)
            .unwrap()
            / BPS_DENOMINATOR;
        let community_amount = vault_balance
            .checked_mul(config.community_bps as u64)
            .unwrap()
            / BPS_DENOMINATOR;
        // Owner gets the remainder to avoid dust from rounding
        let owner_amount = vault_balance - treasury_amount - community_amount;

        let mint_key = config.base_mint;
        let seeds: &[&[u8]] = &[b"vault", mint_key.as_ref(), &[ctx.bumps.vault]];

        let decimals = ctx.accounts.base_mint.decimals;

        // Transfer to treasury
        if treasury_amount > 0 {
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.treasury_token_account.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.base_mint.to_account_info(),
                    },
                    &[seeds],
                ),
                treasury_amount,
                decimals,
            )?;
        }

        // Transfer to community
        if community_amount > 0 {
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.community_token_account.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.base_mint.to_account_info(),
                    },
                    &[seeds],
                ),
                community_amount,
                decimals,
            )?;
        }

        // Transfer to owner
        if owner_amount > 0 {
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.owner_token_account.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.base_mint.to_account_info(),
                    },
                    &[seeds],
                ),
                owner_amount,
                decimals,
            )?;
        }

        msg!(
            "distributed {} tokens — treasury: {}, community: {}, owner: {}",
            vault_balance,
            treasury_amount,
            community_amount,
            owner_amount
        );
        Ok(())
    }

    /// Authority-only: distribute all accumulated fees (owner share → NEW owner),
    /// then update the owner address for future distributions.
    pub fn update_owner(ctx: Context<UpdateOwner>) -> Result<()> {
        let vault_balance = ctx.accounts.vault.amount;
        let config = &ctx.accounts.fee_config;
        let mint_key = config.base_mint;
        let seeds: &[&[u8]] = &[b"vault", mint_key.as_ref(), &[ctx.bumps.vault]];
        let decimals = ctx.accounts.base_mint.decimals;

        // Distribute any accumulated balance first, with owner share going to NEW owner
        if vault_balance > 0 {
            let treasury_amount = vault_balance
                .checked_mul(config.treasury_bps as u64)
                .unwrap()
                / BPS_DENOMINATOR;
            let community_amount = vault_balance
                .checked_mul(config.community_bps as u64)
                .unwrap()
                / BPS_DENOMINATOR;
            let owner_amount = vault_balance - treasury_amount - community_amount;

            if treasury_amount > 0 {
                transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        TransferChecked {
                            from: ctx.accounts.vault.to_account_info(),
                            to: ctx.accounts.treasury_token_account.to_account_info(),
                            authority: ctx.accounts.vault.to_account_info(),
                            mint: ctx.accounts.base_mint.to_account_info(),
                        },
                        &[seeds],
                    ),
                    treasury_amount,
                    decimals,
                )?;
            }

            if community_amount > 0 {
                transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        TransferChecked {
                            from: ctx.accounts.vault.to_account_info(),
                            to: ctx.accounts.community_token_account.to_account_info(),
                            authority: ctx.accounts.vault.to_account_info(),
                            mint: ctx.accounts.base_mint.to_account_info(),
                        },
                        &[seeds],
                    ),
                    community_amount,
                    decimals,
                )?;
            }

            // Owner share goes to the NEW owner
            if owner_amount > 0 {
                transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        TransferChecked {
                            from: ctx.accounts.vault.to_account_info(),
                            to: ctx.accounts.new_owner_token_account.to_account_info(),
                            authority: ctx.accounts.vault.to_account_info(),
                            mint: ctx.accounts.base_mint.to_account_info(),
                        },
                        &[seeds],
                    ),
                    owner_amount,
                    decimals,
                )?;
            }

            msg!(
                "flushed {} tokens before owner update — treasury: {}, community: {}, new_owner: {}",
                vault_balance,
                treasury_amount,
                community_amount,
                owner_amount
            );
        }

        // Update the owner address
        let config = &mut ctx.accounts.fee_config;
        let old_owner = config.owner;
        config.owner = ctx.accounts.new_owner.key();

        msg!(
            "owner updated: {} → {}",
            old_owner,
            config.owner
        );
        Ok(())
    }
}

// ─── Account Contexts ───────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitFeeConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The authority that will manage this config (update_owner).
    /// CHECK: stored in config, validated on subsequent calls.
    pub authority: AccountInfo<'info>,

    /// The token mint this fee config is for.
    pub base_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = FeeConfig::LEN,
        seeds = [b"fee_config", base_mint.key().as_ref()],
        bump,
    )]
    pub fee_config: Account<'info, FeeConfig>,

    /// The vault PDA that holds fees before distribution.
    /// Initialized as a token account owned by itself (PDA signer).
    #[account(
        init,
        payer = payer,
        seeds = [b"vault", base_mint.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = vault,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Treasury wallet address — stored in config.
    pub treasury: AccountInfo<'info>,

    /// CHECK: Community wallet address — stored in config.
    pub community: AccountInfo<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Distribute<'info> {
    #[account(
        seeds = [b"fee_config", fee_config.base_mint.as_ref()],
        bump = fee_config.bump,
    )]
    pub fee_config: Account<'info, FeeConfig>,

    pub base_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"vault", fee_config.base_mint.as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = vault,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// Treasury token account (ATA for treasury wallet + base_mint).
    #[account(
        mut,
        token::mint = base_mint,
        constraint = treasury_token_account.owner == fee_config.treasury,
    )]
    pub treasury_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Community token account (ATA for community wallet + base_mint).
    #[account(
        mut,
        token::mint = base_mint,
        constraint = community_token_account.owner == fee_config.community,
    )]
    pub community_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Owner token account (ATA for owner wallet + base_mint).
    #[account(
        mut,
        token::mint = base_mint,
        constraint = owner_token_account.owner == fee_config.owner,
    )]
    pub owner_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct UpdateOwner<'info> {
    #[account(
        mut,
        seeds = [b"fee_config", fee_config.base_mint.as_ref()],
        bump = fee_config.bump,
        has_one = authority,
    )]
    pub fee_config: Account<'info, FeeConfig>,

    pub authority: Signer<'info>,

    pub base_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"vault", fee_config.base_mint.as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = vault,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// Treasury token account.
    #[account(
        mut,
        token::mint = base_mint,
        constraint = treasury_token_account.owner == fee_config.treasury,
    )]
    pub treasury_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Community token account.
    #[account(
        mut,
        token::mint = base_mint,
        constraint = community_token_account.owner == fee_config.community,
    )]
    pub community_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: The new owner wallet.
    pub new_owner: AccountInfo<'info>,

    /// Token account for the new owner (receives accumulated owner share).
    #[account(
        mut,
        token::mint = base_mint,
        constraint = new_owner_token_account.owner == new_owner.key(),
    )]
    pub new_owner_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}
