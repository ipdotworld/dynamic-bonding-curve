use std::ops::BitAnd;

use anchor_lang::prelude::*;
use num_enum::{IntoPrimitive, TryFromPrimitive};
use static_assertions::const_assert_eq;

use crate::PoolError;

/// On-chain operator role.
///
/// SPEC-DBC-AUDIT-001 Phase 4 (REQ-D-004): single role per operator account.
/// The dead `_Reserved1` (slot 1, formerly `ZapProtocolFee`) and the
/// reserved-but-unused `Backend` (slot 4) variants are REMOVED from the active
/// set. They are intentionally left as discriminant *gaps* — `#[repr(u8)]` with
/// explicit values 2 and 3 keeps `VerifyToken`/`ClaimAirdrop` at their original
/// bit positions so existing on-chain `Operator.permission` u128 bitmasks keep
/// their meaning. `TryFromPrimitive` rejects the gap values 1 and 4, so no live
/// code path can ever request the removed slots. [FROZEN] Do NOT renumber the
/// surviving discriminants — bit N of the stored bitmask maps to discriminant N.
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
pub enum OperatorPermission {
    /// 0 — gates `claim_protocol_fee`.
    ClaimProtocolFee = 0,
    // slot 1 — RESERVED gap (formerly `_Reserved1` / `ZapProtocolFee`, deleted in
    // Phase 1 Tier 2). No variant: `TryFrom(1)` fails. Do NOT reuse this slot.
    /// 2 — single role SHARED by the five backend admin ops: `verify_token`,
    /// `set_ip_treasury`, `set_referral`, `transfer_ip_owner`, `link_token_to_ip`
    /// (REQ-D-002). A backend operator holds exactly this role.
    VerifyToken = 2,
    /// 3 — gates `claim_airdrop_fee` + `claim_token_airdrop_fee`.
    ClaimAirdrop = 3,
    // slot 4 — RESERVED gap (formerly `Backend`, removed in REQ-D-004; supersedes
    // SPEC-DBC-004 REQ-I-004's `Backend=4`). No variant: `TryFrom(4)` fails.
}

/// REQ-D-004: enforce exactly one *valid* role per operator account.
///
/// Rejects:
/// - a zero permission (no role),
/// - a permission with more than one bit set (multiple simultaneous roles),
/// - a single bit at a reserved/dead slot (1 or 4) that maps to no live
///   `OperatorPermission`.
///
/// A backend entity that legitimately needs two roles (e.g. `VerifyToken` and
/// `ClaimAirdrop`) holds two separate single-role `Operator` accounts.
pub fn validate_single_role_permission(permission: u128) -> Result<()> {
    // Exactly one bit set => exactly one role.
    require!(permission.count_ones() == 1, PoolError::InvalidPermission);

    // The single set bit must map to a valid (live) OperatorPermission. This
    // rejects bits at the reserved gaps (slot 1, slot 4) which have no variant.
    let bit_index = permission.trailing_zeros();
    require!(bit_index <= u8::MAX as u32, PoolError::InvalidPermission);
    require!(
        OperatorPermission::try_from(bit_index as u8).is_ok(),
        PoolError::InvalidPermission
    );

    Ok(())
}

#[account(zero_copy)]
#[derive(InitSpace, Debug, Default)]
pub struct Operator {
    pub whitelisted_address: Pubkey,
    pub permission: u128,
    pub padding: [u64; 2], // padding for future use
}

const_assert_eq!(Operator::INIT_SPACE, 64);

impl Operator {
    pub fn initialize(&mut self, whitelisted_address: Pubkey, permission: u128) {
        self.whitelisted_address = whitelisted_address;
        self.permission = permission;
    }

    pub fn is_permission_allow(&self, permission: OperatorPermission) -> bool {
        let result: u128 = self
            .permission
            .bitand(1u128 << Into::<u8>::into(permission));
        result != 0
    }
}
