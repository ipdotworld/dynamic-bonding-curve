//! ip-owner-vault — vesting vault for IP owner quote fees.
//!
//! SPEC-DBC-004 Phase 6 (REQ-I-003).
//!
//! Receives quote-token fees from the dynamic-bonding-curve program (DBC) via
//! CPI, holds them in a vault-owned ATA, and releases them linearly to the
//! verified IP owner (the `ip_owner` field of the DBC `TokenVerification` PDA)
//! over `VESTING_DURATION_SECONDS`.
//!
//! No cliff. No claw-back. Linear-only release indexed to the FIRST deposit.
//!
//! Risk-register notes (plan.md):
//!   - R-03: PDA seed `[b"vesting", token_mint]` is unique to this program.
//!     SPEC-DBC-003 was pre-deploy, so no on-chain Operator account in DBC
//!     uses this seed for any deployed token. Documented in cleanup-log.md.
//!   - R-04: u64::MAX deposit overflow handled via u128 intermediate in
//!     `Vault::released_amount`. Verified by `released_amount_overflow_safe_*`
//!     unit test.

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

pub use constants::*;
pub use error::*;
pub use instructions::*;
pub use state::*;

declare_id!("HnLA2rxN4uJM1yaRaKZ3kmV9Dqjz7JoQYpk2haVE4gUf");

#[program]
pub mod ip_owner_vault {
    use super::*;

    /// Records `amount` as a deposit and forwards the SPL transfer from
    /// `source_token_account` to the vault-owned ATA.
    ///
    /// Idempotent vault initialization: first call creates the `Vault` PDA and
    /// the vault-owned ATA, stamps `vesting_start_unix_timestamp`. Subsequent
    /// calls only increment `total_deposited` (no clock reset).
    pub fn distribute_to_vault(
        ctx: Context<DistributeToVaultCtx>,
        amount: u64,
    ) -> Result<()> {
        instructions::handle_distribute_to_vault(ctx, amount)
    }

    /// Drains the currently claimable balance to the verified IP owner.
    ///
    /// Authorization: `claimer` MUST equal `TokenVerification.ip_owner` for the
    /// matching token mint (verified inside the handler via discriminator-checked
    /// raw-byte read of the DBC-owned account).
    ///
    /// Reverts with:
    ///   - `Unauthorized` if `claimer != TokenVerification.ip_owner`
    ///   - `NothingToClaim` if `released - already_claimed == 0`
    ///   - `VestingNotStarted` if no deposit has stamped the clock yet
    pub fn claim_vested(ctx: Context<ClaimVestedCtx>) -> Result<()> {
        instructions::handle_claim_vested(ctx)
    }
}
