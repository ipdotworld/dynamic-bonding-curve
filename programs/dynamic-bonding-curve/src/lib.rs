// cfg attributes are validated by Rust compiler — do not suppress warnings

use anchor_lang::prelude::*;

#[macro_use]
pub mod macros;

pub mod const_pda;
pub mod instructions;
pub use instructions::*;
pub mod constants;
pub mod error;
pub mod state;
pub use error::*;
pub use state::operator::OperatorPermission;
pub mod event;
pub use event::*;
pub mod utils;
pub use utils::*;
pub mod math;
pub use math::*;
pub mod access_control;
pub use access_control::*;
pub mod base_fee;
pub mod curve;
pub mod migration_handler;
pub mod tests;

pub mod params;

declare_id!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");

/// ipworld-hook program ID — used for CPI and account validation.
///
/// SPEC-DBC-AUDIT-001 Phase 3 (REQ-E-002, OQ-4): SINGLE SOURCE OF TRUTH.
/// This re-exports the hook crate's own `declare_id!` constant
/// (`::ipworld_hook::ID`) rather than holding a duplicated raw-byte copy, so the
/// core's view of the hook id can NEVER diverge from the hook program's actual
/// id — a mismatch is impossible by construction, satisfying the build-time
/// consistency requirement without a separate assertion.
///
/// The leading `::` in `::ipworld_hook` forces resolution to the external
/// `ipworld-hook` crate (extern prelude), not to this same-named local module.
///
/// IDL note: the previous implementation used a raw-byte module to keep Anchor's
/// IDL builder from mis-attributing the hook id as DBC's program address. This
/// re-export is equivalently safe: there is NO `declare_id!` for the hook in this
/// crate (only DBC's own `declare_id!("dbcij3...")` at crate root), so the IDL
/// builder reads DBC's address correctly. The hook's `declare_id!` lives in the
/// separate hook crate and produces only that crate's IDL. Verified by inspecting
/// `target/idl/dynamic_bonding_curve.json` after `anchor build`.
pub mod ipworld_hook {
    pub use ::ipworld_hook::ID;
}

#[program]
pub mod dynamic_bonding_curve {
    use super::*;

    #[access_control(is_admin(ctx.accounts.signer.key))]
    pub fn create_operator_account(
        ctx: Context<CreateOperatorAccountCtx>,
        permission: u128,
    ) -> Result<()> {
        instructions::handle_create_operator_account(ctx, permission)
    }

    #[access_control(is_admin(ctx.accounts.signer.key))]
    pub fn close_operator_account(ctx: Context<CloseOperatorAccountCtx>) -> Result<()> {
        Ok(())
    }

    #[access_control(is_admin(ctx.accounts.signer.key))]
    pub fn close_claim_protocol_fee_operator(
        ctx: Context<CloseClaimProtocolFeeOperatorCtx>,
    ) -> Result<()> {
        instructions::handle_close_claim_protocol_fee_operator(ctx)
    }

    #[access_control(is_valid_operator_role(&ctx.accounts.operator, ctx.accounts.signer.key, OperatorPermission::ClaimProtocolFee))]
    pub fn claim_protocol_fee<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, ClaimProtocolFeesCtx<'info>>,
        max_base_amount: u64,
        max_quote_amount: u64,
    ) -> Result<()> {
        instructions::handle_claim_protocol_fee(ctx, max_base_amount, max_quote_amount)
    }

    /// Verified IP owner claims their accumulated SOL (quote) fees.
    /// Requires a valid TokenVerification PDA created by verify_token.
    pub fn claim_ip_owner_fee<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, ClaimIpOwnerFeeCtx<'info>>,
        max_amount: u64,
    ) -> Result<()> {
        instructions::handle_claim_ip_owner_fee(ctx, max_amount)
    }

    /// Operator claims accumulated airdrop fees: SOL (quote) and token (base).
    /// Backend distributes these to UGC creators and holders off-chain.
    /// Authorization: Operator with `ClaimAirdrop` permission (REQ-I-004 Phase 5.4).
    #[access_control(is_valid_operator_role(&ctx.accounts.operator, ctx.accounts.signer.key, OperatorPermission::ClaimAirdrop))]
    pub fn claim_airdrop_fee<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, ClaimAirdropFeeCtx<'info>>,
        max_quote_amount: u64,
        max_base_amount: u64,
    ) -> Result<()> {
        instructions::handle_claim_airdrop_fee(ctx, max_quote_amount, max_base_amount)
    }

    /// Operator drains the token-only airdrop fee accumulator (SPEC-DBC-004 REQ-S-007 Phase 5.5).
    /// Token (base) variant of `claim_airdrop_fee` for cadence-independent backend distribution.
    /// Authorization: Operator with `ClaimAirdrop` permission.
    #[access_control(is_valid_operator_role(&ctx.accounts.operator, ctx.accounts.signer.key, OperatorPermission::ClaimAirdrop))]
    pub fn claim_token_airdrop_fee<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, ClaimTokenAirdropFeeCtx<'info>>,
        max_base_amount: u64,
    ) -> Result<()> {
        instructions::handle_claim_token_airdrop_fee(ctx, max_base_amount)
    }

    /// IP treasury address claims accumulated token (base) fees.
    /// Requires ip_treasury to be set on the TokenVerification PDA.
    pub fn claim_ip_treasury_fee<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, ClaimIpTreasuryFeeCtx<'info>>,
        max_amount: u64,
    ) -> Result<()> {
        instructions::handle_claim_ip_treasury_fee(ctx, max_amount)
    }

    // claim_protocol_pool_creation_fee removed in A-04 (partner system removal)
    // zap_protocol_fee removed in A-04 (partner system removal)

    /// IPWORLD ADMIN FUNCTIONS ///

    /// One-shot: creates the platform-wide IpworldState PDA.
    /// Payer becomes initial admin. Authority is the backend KMS key.
    #[access_control(is_admin(ctx.accounts.payer.key))]
    pub fn init_ipworld_state(
        ctx: Context<InitIpworldStateCtx>,
        authority: Pubkey,
    ) -> Result<()> {
        instructions::handle_init_ipworld_state(ctx, authority)
    }

    /// Proposes authority rotation to a new key. Admin-only. New key must call accept_ipworld_authority.
    pub fn update_ipworld_authority(
        ctx: Context<UpdateIpworldAuthorityCtx>,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::handle_update_ipworld_authority(ctx, new_authority)
    }

    /// Proposes admin transfer to a new key. Admin-only. New key must call accept_ipworld_admin.
    pub fn update_ipworld_admin(
        ctx: Context<UpdateIpworldAdminCtx>,
        new_admin: Pubkey,
    ) -> Result<()> {
        instructions::handle_update_ipworld_admin(ctx, new_admin)
    }

    /// Accepts pending admin transfer. Must be called by the pending admin.
    pub fn accept_ipworld_admin(
        ctx: Context<AcceptIpworldAdminCtx>,
    ) -> Result<()> {
        instructions::handle_accept_ipworld_admin(ctx)
    }

    /// Accepts pending authority rotation. Must be called by the pending authority.
    pub fn accept_ipworld_authority(
        ctx: Context<AcceptIpworldAuthorityCtx>,
    ) -> Result<()> {
        instructions::handle_accept_ipworld_authority(ctx)
    }

    /// Verifies the IP owner for a pool. SPEC-DBC-AUDIT-001 Phase 4 (REQ-D-002):
    /// operator direct-signing — the signer must hold the `VerifyToken` role.
    /// Creates a TokenVerification PDA recording the `ip_owner` address.
    #[access_control(is_valid_operator_role(&ctx.accounts.operator, ctx.accounts.signer.key, OperatorPermission::VerifyToken))]
    pub fn verify_token(ctx: Context<VerifyTokenCtx>, ip_owner: Pubkey) -> Result<()> {
        instructions::handle_verify_token(ctx, ip_owner)
    }

    /// Proposes a transfer of IP owner role to a new wallet. V-03.
    /// REQ-D-002: operator direct-signing (`VerifyToken` role).
    #[access_control(is_valid_operator_role(&ctx.accounts.operator, ctx.accounts.signer.key, OperatorPermission::VerifyToken))]
    pub fn transfer_ip_owner(ctx: Context<TransferIpOwnerCtx>, new_ip_owner: Pubkey) -> Result<()> {
        instructions::handle_transfer_ip_owner(ctx, new_ip_owner)
    }

    /// Accepts a pending IP owner transfer. Must be called by the current ip_owner. V-03.
    pub fn accept_ip_owner(ctx: Context<AcceptIpOwnerCtx>) -> Result<()> {
        instructions::handle_accept_ip_owner(ctx)
    }

    /// Sets the IP treasury address on a TokenVerification PDA (one-time). E-01.
    /// REQ-D-002: operator direct-signing (`VerifyToken` role).
    #[access_control(is_valid_operator_role(&ctx.accounts.operator, ctx.accounts.signer.key, OperatorPermission::VerifyToken))]
    pub fn set_ip_treasury(ctx: Context<SetIpTreasuryCtx>, treasury: Pubkey) -> Result<()> {
        instructions::handle_set_ip_treasury(ctx, treasury)
    }

    /// Proposes a new referral wallet. E-02.
    /// REQ-D-002: operator direct-signing (`VerifyToken` role).
    #[access_control(is_valid_operator_role(&ctx.accounts.operator, ctx.accounts.signer.key, OperatorPermission::VerifyToken))]
    pub fn set_referral(ctx: Context<SetReferralCtx>, new_referral: Pubkey) -> Result<()> {
        instructions::handle_set_referral(ctx, new_referral)
    }

    /// Accepts a pending referral change. Must be called by the current ip_owner. E-02.
    pub fn accept_referral(ctx: Context<AcceptReferralCtx>) -> Result<()> {
        instructions::handle_accept_referral(ctx)
    }

    /// Links a token pool to an IPA identifier. E-03.
    /// REQ-D-002: operator direct-signing (`VerifyToken` role).
    #[access_control(is_valid_operator_role(&ctx.accounts.operator, ctx.accounts.signer.key, OperatorPermission::VerifyToken))]
    pub fn link_token_to_ip(ctx: Context<LinkTokenToIpCtx>, ipa_id: Pubkey) -> Result<()> {
        instructions::handle_link_token_to_ip(ctx, ipa_id)
    }

    /// PARTNER FUNCTIONS ///
    pub fn create_partner_metadata(
        ctx: Context<CreatePartnerMetadataCtx>,
        metadata: CreatePartnerMetadataParameters,
    ) -> Result<()> {
        instructions::handle_create_partner_metadata(ctx, metadata)
    }

    pub fn create_config(
        ctx: Context<CreateConfigCtx>,
        config_parameters: ConfigParameters,
    ) -> Result<()> {
        instructions::handle_create_config(ctx, config_parameters)
    }

    // claim_trading_fee removed in A-04 (partner system removal)
    // claim_partner_pool_creation_fee removed in A-04 (partner system removal)
    // partner_withdraw_surplus removed in A-04 (partner system removal)

    /// POOL CREATOR FUNCTIONS ////
    // SPEC-DBC-AUDIT-001 Phase 6 (REQ-G-001): the plain-SPL pool-creation
    // entrypoint (`initialize_virtual_pool_with_spl_token`) was removed. Plain
    // SPL mints cannot carry the Token-2022 transfer hook that enforces the
    // IPWorld holding cap / P2P block, so IPWorld is Token-2022 ONLY. The
    // Token-2022 path below is the sole pool-creation entrypoint.
    pub fn initialize_virtual_pool_with_token2022<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, InitializeVirtualPoolWithToken2022Ctx<'info>>,
        params: InitializePoolParameters,
    ) -> Result<()> {
        instructions::handle_initialize_virtual_pool_with_token2022(ctx, params)
    }

    #[access_control(is_pool_creator(&ctx.accounts.virtual_pool, ctx.accounts.creator.key))]
    pub fn create_virtual_pool_metadata(
        ctx: Context<CreateVirtualPoolMetadataCtx>,
        metadata: CreateVirtualPoolMetadataParameters,
    ) -> Result<()> {
        instructions::handle_create_virtual_pool_metadata(ctx, metadata)
    }

    // SPEC-DBC-004 Phase 3 (REQ-I-001): `claim_creator_trading_fee` removed.
    // The creator side of the SELL fee distribution is gone (creator_share field
    // and creator_quote_fee accumulator both deleted). Creator earnings flow
    // exclusively via `creator_withdraw_surplus` below.

    // withdraw surplus on quote token
    #[access_control(is_pool_creator(&ctx.accounts.virtual_pool, ctx.accounts.creator.key))]
    pub fn creator_withdraw_surplus<'c: 'info, 'info>(ctx: Context<'_, '_, 'c, 'info, CreatorWithdrawSurplusCtx<'info>>) -> Result<()> {
        instructions::handle_creator_withdraw_surplus(ctx)
    }

    #[access_control(is_pool_creator(&ctx.accounts.virtual_pool, ctx.accounts.creator.key))]
    pub fn transfer_pool_creator<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, TransferPoolCreatorCtx>,
    ) -> Result<()> {
        instructions::handle_transfer_pool_creator(ctx)
    }

    /// BOTH partner and creator FUNCTIONS ///
    pub fn withdraw_migration_fee<'c: 'info, 'info>(ctx: Context<'_, '_, 'c, 'info, WithdrawMigrationFeeCtx<'info>>, flag: u8) -> Result<()> {
        instructions::handle_withdraw_migration_fee(ctx, flag)
    }

    /// TRADING BOTS FUNCTIONS ////
    pub fn swap<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, SwapCtx<'info>>,
        params: SwapParameters,
    ) -> Result<()> {
        instructions::handle_swap_wrapper(
            ctx,
            SwapParameters2 {
                amount_0: params.amount_in,
                amount_1: params.minimum_amount_out,
                swap_mode: SwapMode::ExactIn.into(),
                ..Default::default()
            },
        )
    }

    pub fn swap2<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, SwapCtx<'info>>,
        params: SwapParameters2,
    ) -> Result<()> {
        instructions::handle_swap_wrapper(ctx, params)
    }

    /// PERMISSIONLESS FUNCTIONS ///
    /// create locker
    pub fn create_locker(ctx: Context<CreateLockerCtx>) -> Result<()> {
        instructions::handle_create_locker(ctx)
    }

    // withdraw leftover on base token, can only call after pool is initialized
    pub fn withdraw_leftover<'c: 'info, 'info>(ctx: Context<'_, '_, 'c, 'info, WithdrawLeftoverCtx<'info>>) -> Result<()> {
        instructions::handle_withdraw_leftover(ctx)
    }

    // migrate damm v2
    #[deprecated(
        since = "0.1.7",
        note = "It's unneeded. Will be removed in next release version"
    )]
    pub fn migration_damm_v2_create_metadata<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, MigrationDammV2CreateMetadataCtx<'info>>,
    ) -> Result<()> {
        instructions::handle_migration_damm_v2_create_metadata(ctx)
    }

    pub fn migration_damm_v2<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, MigrateDammV2Ctx<'info>>,
    ) -> Result<()> {
        instructions::handle_migrate_damm_v2(ctx)
    }

    /// Permissionless instruction to harvest accumulated LP fees from a DAMM v2 pool.
    ///
    /// After graduation, all liquidity migrates to DAMM v2 and is permanently locked.
    /// LP fees (SOL + token) accumulate in DAMM v2. Anyone (crank/bot) can call this
    /// to collect fees and distribute them using the same ratios as bonding curve swaps.
    ///
    /// Requirements:
    ///   - pool must be in MigrationProgress::CreatedPool state
    ///   - permissionless: no signer authority check on payer
    pub fn harvest<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, HarvestCtx<'info>>,
    ) -> Result<()> {
        instructions::handle_harvest(ctx)
    }
}
