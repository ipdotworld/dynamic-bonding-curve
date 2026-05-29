// Constants for the ip-owner-vault program.
//
// SPEC-DBC-004 Phase 6 (REQ-I-003).

use anchor_lang::prelude::*;

/// On-chain program id of the dynamic-bonding-curve (DBC) program.
///
/// The vault deliberately does NOT take a Cargo dependency on the DBC crate
/// (DBC depends on the vault for CPI types — a reverse dependency would create a
/// build cycle), so the program id and the relevant PDA seeds are replicated
/// here and pinned by unit tests.
pub const DBC_PROGRAM_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");

/// DBC `TokenVerification` PDA seed prefix.
/// Canonical seeds: `[TOKEN_VERIFICATION_SEED, pool.key().as_ref()]`.
pub const TOKEN_VERIFICATION_SEED: &[u8] = b"token_verification";

/// DBC `pool_authority` PDA seed prefix (single static seed, no per-pool part):
/// `pool_authority = find_program_address([POOL_AUTHORITY_PREFIX], DBC)`.
pub const POOL_AUTHORITY_PREFIX: &[u8] = b"pool_authority";

/// Derive DBC's global `pool_authority` PDA.
///
/// SPEC-DBC-AUDIT-001 Phase 2 (SEC-P2-01): `distribute_to_vault` requires its
/// `authority` to equal this PDA so that the vault is funded ONLY through DBC's
/// gated CPI (which signs as `pool_authority`). This makes the pool recorded on
/// first deposit trustworthy. Pure helper → unit-testable.
pub fn derive_pool_authority() -> Pubkey {
    Pubkey::find_program_address(&[POOL_AUTHORITY_PREFIX], &DBC_PROGRAM_ID).0
}

/// Linear vesting duration applied to token-allocation deposits.
///
/// Formula: `released = total_deposited * min(now - vesting_start, DURATION) / DURATION`.
/// No cliff. Stamp set on first deposit; subsequent deposits do not reset the clock.
///
/// SPEC-DBC-AUDIT-001 REQ-C-001 (AC-C-001): 180 days (180 × 86400 = 15_552_000 seconds).
/// This matches the EVM `IPOwnerVault.sol` "3-month" token-allocation vesting (linear,
/// no cliff, no clawback, anchored to first deposit — see `protocol/src/IPOwnerVault.sol`).
/// Note: as of REQ-C-001 the IP-owner QUOTE/SOL fee is paid immediately at
/// `claim_ip_owner_fee` and is no longer routed here, so this vault currently has no
/// deposit source (dormant). The constant is kept correct so the vault vests over 180
/// days (not 365) should it ever be reactivated for a token-allocation deposit path.
pub const VESTING_DURATION_SECONDS: i64 = 180 * 86_400;

/// PDA seed prefix for the per-mint Vault account.
///
/// Final seed list: `[VESTING_VAULT_SEED, token_mint.as_ref()]`.
pub const VESTING_VAULT_SEED: &[u8] = b"vesting";

#[cfg(test)]
mod tests {
    use super::*;

    /// SEC-P2-01: the replicated `pool_authority` derivation reproduces DBC's
    /// canonical `pool_authority` (`FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM`
    /// per DBC `const_pda`). Guards the SEC-P2-01 authority gate against a
    /// seed/program-id typo in the (dependency-free) replicated constants.
    #[test]
    fn pool_authority_matches_dbc_canonical() {
        let expected = Pubkey::from_str_const("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
        assert_eq!(derive_pool_authority(), expected);
    }

    /// The replicated DBC program id parses to the documented address.
    #[test]
    fn dbc_program_id_is_pinned() {
        assert_eq!(
            DBC_PROGRAM_ID,
            Pubkey::from_str_const("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN")
        );
    }

    /// SPEC-DBC-AUDIT-001 REQ-C-001 / AC-C-001: the token-allocation vesting duration
    /// is exactly 180 days (matching the EVM `IPOwnerVault.sol` 3-month vesting), not
    /// the previous 365 days. Pins the constant against accidental reversion.
    #[test]
    fn vesting_duration_is_180_days() {
        assert_eq!(VESTING_DURATION_SECONDS, 180 * 86_400);
        assert_eq!(VESTING_DURATION_SECONDS, 15_552_000);
    }
}
