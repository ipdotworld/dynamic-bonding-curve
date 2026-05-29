//! SPEC-DBC-AUDIT-001 Phase 4 (REQ-D-004): single-role-per-operator enforcement
//! and removal of the dead `_Reserved1` (slot 1) and reserved-but-unused `Backend`
//! (slot 4) variants from the *active* `OperatorPermission` set.
//!
//! Discriminant numbering is FROZEN for on-chain layout compatibility: bit N of
//! the stored `permission` u128 corresponds to `OperatorPermission` discriminant
//! N. Slots 1 and 4 are now discriminant *gaps* (no constructible variant), so
//! `TryFromPrimitive` rejects them — proving they are gone from the active set
//! while `VerifyToken = 2` / `ClaimAirdrop = 3` keep their bit positions.

use core::convert::TryFrom;

use crate::state::operator::{validate_single_role_permission, Operator, OperatorPermission};

/// Slot 0 — `ClaimProtocolFee` is allowed when bit 0 of the permission bitmask is set.
#[test]
fn permission_slot_0_claim_protocol_fee_allowed() {
    let operator = Operator {
        permission: 0b0_0001, // bit 0 only
        ..Default::default()
    };
    assert!(
        operator.is_permission_allow(OperatorPermission::ClaimProtocolFee),
        "bit 0 set -> ClaimProtocolFee permitted"
    );
}

/// Slot 2 — `VerifyToken` is allowed when bit 2 of the permission bitmask is set.
/// Gates the five backend admin ops (verify_token, set_ip_treasury, set_referral,
/// transfer_ip_owner, link_token_to_ip) which all SHARE this single role.
#[test]
fn permission_slot_2_verify_token_allowed() {
    let operator = Operator {
        permission: 0b0_0100, // bit 2 only
        ..Default::default()
    };
    assert!(
        operator.is_permission_allow(OperatorPermission::VerifyToken),
        "bit 2 set -> VerifyToken permitted"
    );
    // Discriminant MUST remain 2 for on-chain layout compatibility.
    assert_eq!(Into::<u8>::into(OperatorPermission::VerifyToken), 2);
}

/// Slot 3 — `ClaimAirdrop` is allowed when bit 3 of the permission bitmask is set.
/// Gates `claim_airdrop_fee` and `claim_token_airdrop_fee`.
#[test]
fn permission_slot_3_claim_airdrop_allowed() {
    let operator = Operator {
        permission: 0b0_1000, // bit 3 only
        ..Default::default()
    };
    assert!(
        operator.is_permission_allow(OperatorPermission::ClaimAirdrop),
        "bit 3 set -> ClaimAirdrop permitted"
    );
    // Discriminant MUST remain 3 for on-chain layout compatibility.
    assert_eq!(Into::<u8>::into(OperatorPermission::ClaimAirdrop), 3);
}

/// REQ-D-004: `_Reserved1` (slot 1) and `Backend` (slot 4) are removed from the
/// active permission set. With the variants deleted, the discriminants 1 and 4
/// become gaps and `TryFromPrimitive` MUST reject them. This is the structural
/// proof that no live code path (ix or operator role) can request either slot.
#[test]
fn permission_reserved_slots_1_and_4_are_not_valid_discriminants() {
    assert!(
        OperatorPermission::try_from(1u8).is_err(),
        "slot 1 (_Reserved1) must be a discriminant gap -> TryFrom rejects"
    );
    assert!(
        OperatorPermission::try_from(4u8).is_err(),
        "slot 4 (Backend) must be a discriminant gap -> TryFrom rejects"
    );

    // The three live roles remain valid discriminants at their FROZEN positions.
    assert_eq!(
        OperatorPermission::try_from(0u8).unwrap(),
        OperatorPermission::ClaimProtocolFee
    );
    assert_eq!(
        OperatorPermission::try_from(2u8).unwrap(),
        OperatorPermission::VerifyToken
    );
    assert_eq!(
        OperatorPermission::try_from(3u8).unwrap(),
        OperatorPermission::ClaimAirdrop
    );
}

/// REQ-D-004: `create_operator_account` must REJECT a permission value with more
/// than one role bit set. A backend entity needing two roles holds two separate
/// single-role accounts.
#[test]
fn validate_single_role_rejects_multi_bit_permission() {
    // VerifyToken (bit 2) | ClaimAirdrop (bit 3) — two roles in one account.
    let multi = (1u128 << 2) | (1u128 << 3);
    assert!(
        validate_single_role_permission(multi).is_err(),
        "multi-role permission (VerifyToken|ClaimAirdrop) must be rejected"
    );

    // ClaimProtocolFee (bit 0) | VerifyToken (bit 2).
    let multi2 = (1u128 << 0) | (1u128 << 2);
    assert!(
        validate_single_role_permission(multi2).is_err(),
        "multi-role permission (ClaimProtocolFee|VerifyToken) must be rejected"
    );
}

/// REQ-D-004: each of the three live single roles is accepted.
#[test]
fn validate_single_role_accepts_each_live_role() {
    for variant in [
        OperatorPermission::ClaimProtocolFee,
        OperatorPermission::VerifyToken,
        OperatorPermission::ClaimAirdrop,
    ] {
        let single = 1u128 << Into::<u8>::into(variant);
        assert!(
            validate_single_role_permission(single).is_ok(),
            "single role {:?} must be accepted",
            variant
        );
    }
}

/// REQ-D-004: a zero permission (no role) is rejected.
#[test]
fn validate_single_role_rejects_zero() {
    assert!(
        validate_single_role_permission(0).is_err(),
        "zero permission (no role) must be rejected"
    );
}

/// REQ-D-004: a single bit set at a RESERVED/dead slot (1 or 4) is rejected even
/// though `count_ones() == 1`, because it maps to no valid `OperatorPermission`.
/// This prevents minting an operator account that holds a meaningless dead bit.
#[test]
fn validate_single_role_rejects_reserved_dead_bits() {
    assert!(
        validate_single_role_permission(1u128 << 1).is_err(),
        "single bit at dead slot 1 (_Reserved1) must be rejected"
    );
    assert!(
        validate_single_role_permission(1u128 << 4).is_err(),
        "single bit at reserved slot 4 (Backend) must be rejected"
    );
}

/// Disjoint slots: an operator holding only `ClaimAirdrop` MUST be denied for the
/// `VerifyToken` role gate (the role the 5 backend admin ops require). Mirrors the
/// `is_valid_operator_role` semantics applied by `#[access_control(...)]`.
#[test]
fn permission_wrong_role_is_denied_for_verify_token_gate() {
    let airdrop_only = Operator {
        permission: 1u128 << Into::<u8>::into(OperatorPermission::ClaimAirdrop),
        ..Default::default()
    };
    assert!(
        !airdrop_only.is_permission_allow(OperatorPermission::VerifyToken),
        "ClaimAirdrop-only operator must be denied the VerifyToken gate"
    );

    let verify_only = Operator {
        permission: 1u128 << Into::<u8>::into(OperatorPermission::VerifyToken),
        ..Default::default()
    };
    assert!(
        verify_only.is_permission_allow(OperatorPermission::VerifyToken),
        "VerifyToken operator must pass the VerifyToken gate"
    );
}
