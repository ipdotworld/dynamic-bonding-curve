use crate::{
    constants::MAX_OPERATION,
    state::operator::{Operator, OperatorPermission},
};

/// Slot 0 — `ClaimProtocolFee` is allowed when bit 0 of the permission bitmask is set.
#[test]
fn permission_slot_0_claim_protocol_fee_allowed() {
    let operator = Operator {
        permission: 0b0_0001, // bit 0 only
        ..Default::default()
    };
    assert_eq!(
        operator.is_permission_allow(OperatorPermission::ClaimProtocolFee),
        true,
        "bit 0 set → ClaimProtocolFee permitted"
    );
}

/// Slot 2 — `VerifyToken` is allowed when bit 2 of the permission bitmask is set.
/// REQ-I-004 enum extension.
#[test]
fn permission_slot_2_verify_token_allowed() {
    let operator = Operator {
        permission: 0b0_0100, // bit 2 only
        ..Default::default()
    };
    assert_eq!(
        operator.is_permission_allow(OperatorPermission::VerifyToken),
        true,
        "bit 2 set → VerifyToken permitted"
    );
}

/// Slot 3 — `ClaimAirdrop` is allowed when bit 3 of the permission bitmask is set.
/// REQ-I-004 enum extension; gates `claim_airdrop_fee` and `claim_token_airdrop_fee`.
#[test]
fn permission_slot_3_claim_airdrop_allowed() {
    let operator = Operator {
        permission: 0b0_1000, // bit 3 only
        ..Default::default()
    };
    assert_eq!(
        operator.is_permission_allow(OperatorPermission::ClaimAirdrop),
        true,
        "bit 3 set → ClaimAirdrop permitted"
    );
}

/// Slot 4 — `Backend` is allowed when bit 4 of the permission bitmask is set.
/// REQ-I-004 enum extension; reserved for future backend-driven ix paths.
#[test]
fn permission_slot_4_backend_allowed() {
    let operator = Operator {
        permission: 0b1_0000, // bit 4 only
        ..Default::default()
    };
    assert_eq!(
        operator.is_permission_allow(OperatorPermission::Backend),
        true,
        "bit 4 set → Backend permitted"
    );
}

/// Slot 1 (`_Reserved1`) is dead. Even if a legacy on-chain Operator account
/// has bit 1 set, no live ix maps to it. The variant exists only to preserve
/// discriminant numbering for slots 2..N. This test asserts the slot is dead
/// at the public API: `is_permission_allow(_Reserved1)` returns true if the
/// bit is set, but no ix references this variant — the constraint is enforced
/// at ix-call sites by `PoolError::UnsupportedOperatorPermission`.
#[test]
fn permission_slot_1_reserved_returns_bitmask_value() {
    // Bit 1 set: legacy permission — bitmask read returns true (as designed —
    // the bitmask itself is value-neutral; rejection happens at the ix layer).
    let operator_with_bit_1 = Operator {
        permission: 0b0_0010,
        ..Default::default()
    };
    assert_eq!(
        operator_with_bit_1.is_permission_allow(OperatorPermission::_Reserved1),
        true,
        "bit 1 set: bitmask read returns true (rejection happens at ix layer)"
    );

    // Bit 1 NOT set: bitmask read returns false.
    let operator_without_bit_1 = Operator {
        permission: 0b1_1101, // all bits except 1
        ..Default::default()
    };
    assert_eq!(
        operator_without_bit_1.is_permission_allow(OperatorPermission::_Reserved1),
        false,
        "bit 1 unset: bitmask read returns false"
    );
}

/// Disjoint slots: a permission bitmask with only bit 0 (ClaimProtocolFee) set
/// MUST return false for any other permission query (VerifyToken, ClaimAirdrop, Backend).
#[test]
fn permission_disjoint_slots_negative_test() {
    let operator = Operator {
        permission: 0b0_0001, // bit 0 only — ClaimProtocolFee
        ..Default::default()
    };

    assert_eq!(
        operator.is_permission_allow(OperatorPermission::ClaimProtocolFee),
        true,
        "bit 0 set → ClaimProtocolFee permitted"
    );
    assert_eq!(
        operator.is_permission_allow(OperatorPermission::VerifyToken),
        false,
        "bit 0 only → VerifyToken denied"
    );
    assert_eq!(
        operator.is_permission_allow(OperatorPermission::ClaimAirdrop),
        false,
        "bit 0 only → ClaimAirdrop denied"
    );
    assert_eq!(
        operator.is_permission_allow(OperatorPermission::Backend),
        false,
        "bit 0 only → Backend denied"
    );
}

/// Sanity: full-permission bitmask (all 5 active slots set) permits every variant.
#[test]
fn permission_full_bitmask_permits_all_active_slots() {
    let permission: u128 = 0b1_1111; // all 5 bits set
    assert!(
        permission >= 1 << (MAX_OPERATION - 1) && permission <= (1u128 << MAX_OPERATION) - 1,
        "0b11111 fits within MAX_OPERATION ({}) bits",
        MAX_OPERATION
    );

    let operator = Operator {
        permission,
        ..Default::default()
    };

    for variant in [
        OperatorPermission::ClaimProtocolFee,
        OperatorPermission::_Reserved1, // bit 1 — bitmask reads true; ix-layer rejection separate
        OperatorPermission::VerifyToken,
        OperatorPermission::ClaimAirdrop,
        OperatorPermission::Backend,
    ] {
        assert_eq!(
            operator.is_permission_allow(variant),
            true,
            "full bitmask permits {:?}",
            variant
        );
    }
}
