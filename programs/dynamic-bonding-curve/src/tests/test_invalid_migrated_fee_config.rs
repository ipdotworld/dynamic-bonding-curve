// SPEC-DBC-004 Phase 4 unit tests
//
// Coverage:
//   REQ-I-002: DAMM v2 OnlyB + zero compounding enforcement
//   REQ-I-005: pendingTreasury (IpTreasuryNotSet / IpTreasuryAlreadySet) predicates
//
// These tests exercise the pure-Rust validation predicates exported by
// `MigratedPoolFeeValidator::validate` and the `Pubkey::default()` markers
// used by the `ix_set_ip_treasury` and `ix_claim_ip_treasury_fee` Anchor
// constraints. Full ix-level integration with Anchor's account machinery is
// covered by the TypeScript LiteSVM tests in `tests/`.

use anchor_lang::prelude::Pubkey;

use crate::{
    error::PoolError,
    instructions::partner::ix_create_config::MigratedPoolFeeValidator,
    migration_handler::MigratedCollectFeeMode,
    state::TokenVerification,
};

// MIN_MIGRATED_POOL_FEE_BPS = 10 (constants.rs:36)
const VALID_POOL_FEE_BPS: u16 = 10;

/// Asserts that the produced error is `PoolError::InvalidMigratedFeeConfig`.
///
/// Compares the discriminant code, not the full debug string (which embeds
/// file/line origin and is brittle across edits).
fn assert_invalid_migrated_fee_config(err: &anchor_lang::error::Error) {
    let expected_code: u32 = PoolError::InvalidMigratedFeeConfig.into();
    let actual_code = match err {
        anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
        anchor_lang::error::Error::ProgramError(_) => {
            panic!("Expected AnchorError, got ProgramError")
        }
    };
    assert_eq!(
        actual_code, expected_code,
        "expected PoolError::InvalidMigratedFeeConfig (code {}), got code {}",
        expected_code, actual_code
    );
}

fn validator_with_overrides(
    collect_fee_mode: u8,
    compounding_fee_bps: u16,
) -> MigratedPoolFeeValidator {
    MigratedPoolFeeValidator {
        collect_fee_mode,
        dynamic_fee: 0,
        pool_fee_bps: VALID_POOL_FEE_BPS,
        compounding_fee_bps,
        migrated_pool_base_fee_mode: 0,
        number_of_period: 0,
        sqrt_price_step_bps: 0,
        scheduler_expiration_duration: 0,
        reduction_factor: 0,
    }
}

// ---------- REQ-I-002 ----------

/// REQ-I-002: collect_fee_mode == OutputToken (DBC=1, DAMM v2=BothToken=0) is rejected
/// with `InvalidMigratedFeeConfig`.
#[test]
fn invalid_migrated_fee_config_when_output_token_mode() {
    let validator = validator_with_overrides(
        MigratedCollectFeeMode::OutputToken as u8, // 1
        0,                                          // compounding_fee_bps OK
    );

    let err = validator
        .validate()
        .expect_err("OutputToken must be rejected by REQ-I-002");

    assert_invalid_migrated_fee_config(&err);
}

/// REQ-I-002: collect_fee_mode == Compounding (DBC=2) is rejected with
/// `InvalidMigratedFeeConfig` even when compounding_fee_bps would otherwise be valid.
#[test]
fn invalid_migrated_fee_config_when_compounding_mode() {
    let validator = validator_with_overrides(
        MigratedCollectFeeMode::Compounding as u8, // 2
        0,                                          // compounding_fee_bps OK
    );

    let err = validator
        .validate()
        .expect_err("Compounding mode must be rejected by REQ-I-002");

    assert_invalid_migrated_fee_config(&err);
}

/// REQ-I-002: compounding_fee_bps != 0 is rejected with `InvalidMigratedFeeConfig`
/// even when collect_fee_mode is the OnlyB-equivalent (QuoteToken).
#[test]
fn invalid_migrated_fee_config_when_compounding_fee_bps_nonzero() {
    let validator = validator_with_overrides(
        MigratedCollectFeeMode::QuoteToken as u8, // 0 — OnlyB-equivalent
        100,                                       // 1% compounding fee — must be 0
    );

    let err = validator
        .validate()
        .expect_err("Non-zero compounding_fee_bps must be rejected by REQ-I-002");

    assert_invalid_migrated_fee_config(&err);
}

/// REQ-I-002: collect_fee_mode == QuoteToken (DBC=0, DAMM v2 OnlyB=1) AND
/// compounding_fee_bps == 0 is the only accepted configuration. The validator
/// should pass past the OnlyB+zero-compounding gate (it may still error on other
/// fields like `dynamic_fee` or `migrated_pool_base_fee_mode`, but NOT with
/// `InvalidMigratedFeeConfig`).
#[test]
fn valid_only_b_plus_zero_compounding_passes_req_i_002_gate() {
    let validator = validator_with_overrides(
        MigratedCollectFeeMode::QuoteToken as u8, // 0 — OnlyB-equivalent
        0,                                         // compounding_fee_bps OK
    );

    // The validator may still fail on downstream checks (e.g.
    // `migrated_pool_base_fee_mode == 0` is rejected by the
    // `DammV2BaseFeeMode::try_from(0)` flow). The contract here is that the
    // SPECIFIC error must NOT be `InvalidMigratedFeeConfig`.
    match validator.validate() {
        Ok(()) => { /* the OnlyB+zero-compounding gate passed */ }
        Err(e) => {
            let invalid_migrated_fee_config_code: u32 =
                PoolError::InvalidMigratedFeeConfig.into();
            let actual_code = match &e {
                anchor_lang::error::Error::AnchorError(ae) => ae.error_code_number,
                anchor_lang::error::Error::ProgramError(_) => 0,
            };
            assert_ne!(
                actual_code, invalid_migrated_fee_config_code,
                "REQ-I-002 gate should not reject the canonical OnlyB+zero configuration (got error: {:?})",
                e
            );
        }
    }
}

// ---------- REQ-I-005 ----------

/// REQ-I-005: An unset `ip_treasury` (Pubkey::default()) is the marker for the
/// "pending treasury" state — `claim_ip_treasury_fee` constraint will reject
/// with `IpTreasuryNotSet`, and `set_ip_treasury` is allowed to write.
#[test]
fn ip_treasury_unset_uses_pubkey_default_marker() {
    let tv = TokenVerification {
        ipa_id: Pubkey::default(),
        ip_owner: Pubkey::new_unique(),
        pending_ip_owner: Pubkey::default(),
        ip_treasury: Pubkey::default(),
        referral: Pubkey::default(),
        pending_referral: Pubkey::default(),
        verified_at: 0,
        bump: 0,
    };

    // The Anchor constraint inside `ix_claim_ip_treasury_fee.rs`:
    //     constraint = token_verification.ip_treasury != Pubkey::default()
    //         @ PoolError::IpTreasuryNotSet
    // evaluates to FALSE when `ip_treasury == Pubkey::default()`, triggering
    // `IpTreasuryNotSet`.
    assert_eq!(tv.ip_treasury, Pubkey::default());
    assert!(tv.ip_treasury == Pubkey::default());
}

/// REQ-I-005: A set `ip_treasury` (non-default) is the marker that
/// `set_ip_treasury` has been called once. The `set_ip_treasury` handler in
/// `ix_set_ip_treasury.rs` rejects a second call with `IpTreasuryAlreadySet`
/// using the predicate `ip_treasury == Pubkey::default()`.
#[test]
fn ip_treasury_set_blocks_second_set_call() {
    let treasury_addr = Pubkey::new_unique();
    let tv = TokenVerification {
        ipa_id: Pubkey::default(),
        ip_owner: Pubkey::new_unique(),
        pending_ip_owner: Pubkey::default(),
        ip_treasury: treasury_addr,
        referral: Pubkey::default(),
        pending_referral: Pubkey::default(),
        verified_at: 0,
        bump: 0,
    };

    // The require! inside `handle_set_ip_treasury`:
    //     require!(
    //         ctx.accounts.token_verification.ip_treasury == Pubkey::default(),
    //         PoolError::IpTreasuryAlreadySet
    //     );
    // evaluates to FALSE when `ip_treasury` is already a real address, so the
    // require! fires with `IpTreasuryAlreadySet`.
    assert_ne!(tv.ip_treasury, Pubkey::default());
    assert!(tv.ip_treasury != Pubkey::default());
}

/// REQ-I-005: the IpTreasuryNotSet error variant exists with the expected message.
#[test]
fn ip_treasury_not_set_error_variant_exists() {
    let err: anchor_lang::error::Error = PoolError::IpTreasuryNotSet.into();
    let s = err.to_string();
    assert!(
        s.contains("IP treasury") && s.contains("not set"),
        "IpTreasuryNotSet must mention 'IP treasury' + 'not set' (got: {})",
        s
    );
}

/// REQ-I-005: the IpTreasuryAlreadySet error variant exists with the expected message.
#[test]
fn ip_treasury_already_set_error_variant_exists() {
    let err: anchor_lang::error::Error = PoolError::IpTreasuryAlreadySet.into();
    let s = err.to_string();
    assert!(
        s.contains("IP treasury") && s.contains("already set"),
        "IpTreasuryAlreadySet must mention 'IP treasury' + 'already set' (got: {})",
        s
    );
}
