use std::ops::BitAnd;

use anchor_lang::prelude::*;
use num_enum::{IntoPrimitive, TryFromPrimitive};
use static_assertions::const_assert_eq;

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
    ClaimProtocolFee, // 0 — retained
    /// Slot 1 RESERVED for layout compatibility — formerly `ZapProtocolFee`
    /// (deleted in Phase 1 Tier 2 with `ix_zap_protocol_fee.rs`). On-chain
    /// `Operator.permission` u128 bitmasks may have bit 1 set on legacy accounts;
    /// the variant exists so the discriminant numbering of slots 2..N stays
    /// stable. Any ix that previously checked this slot must reject with
    /// `PoolError::UnsupportedOperatorPermission`. Do NOT renumber.
    _Reserved1,       // 1 — DEAD slot
    VerifyToken,      // 2 — gates verify_token + set_ip_treasury (REQ-I-004)
    ClaimAirdrop,     // 3 — gates claim_airdrop_fee + claim_token_airdrop_fee (REQ-I-004 + REQ-S-007)
    Backend,          // 4 — reserved for future backend-driven ix paths (REQ-I-004)
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
