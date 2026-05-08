// Constants for the ip-owner-vault program.
//
// SPEC-DBC-004 Phase 6 (REQ-I-003).

/// Linear vesting duration applied to IP owner fee deposits.
///
/// Formula: `released = total_deposited * min(now - vesting_start, DURATION) / DURATION`.
/// No cliff. Stamp set on first deposit; subsequent deposits do not reset the clock.
///
/// Default: one calendar year (365 days × 86400 seconds = 31_536_000 seconds).
/// This balances UX (predictable annualised release schedule) with anti-rug guarantees
/// (an instant claim of the IP owner side is impossible — the vault must accrue time).
pub const VESTING_DURATION_SECONDS: i64 = 365 * 86_400;

/// PDA seed prefix for the per-mint Vault account.
///
/// Final seed list: `[VESTING_VAULT_SEED, token_mint.as_ref()]`.
pub const VESTING_VAULT_SEED: &[u8] = b"vesting";
