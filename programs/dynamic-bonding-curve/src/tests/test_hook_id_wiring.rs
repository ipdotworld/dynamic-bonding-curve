//! SPEC-DBC-AUDIT-001 Phase 3 (REQ-E-002, OQ-4): hook-id single-source-of-truth guard.
//!
//! The core program references the ipworld-hook program id via `crate::ipworld_hook::ID`,
//! which (Phase 3) re-exports the hook crate's own `declare_id!` constant
//! (`::ipworld_hook::ID`). Because there is exactly ONE definition of the id (the hook's
//! `declare_id!`), the core's view can never structurally diverge from the hook's actual
//! id — that is the primary consistency guarantee, established by construction.
//!
//! These tests add a second, explicit layer: they pin the wired id to the exact base58
//! that the operator deploys (the key in `target/deploy/ipworld_hook-keypair.json`). If a
//! future change ever reintroduces a divergent raw-byte copy, rewrites `declare_id!`, or
//! regenerates the keypair without rewiring, this test fails loudly instead of silently
//! shipping a core that CPIs / address-checks against the wrong hook program (which would
//! brick Token-2022 pool creation again — the very defect Phase 3 fixed).

use crate::ipworld_hook;
use anchor_lang::prelude::Pubkey;

/// The deployed ipworld-hook program id (must match Anchor.toml `[programs.*] ipworld_hook`
/// and `target/deploy/ipworld_hook-keypair.json`).
const EXPECTED_HOOK_ID: &str = "7WDGrFPSEQjh42aLrzDkqWu6RTCeDYJeTRErKDQDLiC1";

/// The re-exported `ipworld_hook::ID` (single source of truth: the hook crate's
/// `declare_id!`) must equal the canonical deployed id. Guards against the core and the
/// hook program drifting apart — the Phase 3 deploy-blocker (REQ-E-002).
#[test]
fn core_hook_id_matches_deployed_keypair() {
    let expected = Pubkey::from_str_const(EXPECTED_HOOK_ID);
    assert_eq!(
        ipworld_hook::ID, expected,
        "core's ipworld_hook::ID re-export diverged from the deployed hook keypair id; \
         re-sync declare_id!/Anchor.toml/keypair (REQ-E-002 single source of truth)"
    );
}

/// The wired id must NOT be the dead placeholder that had no private key (the original
/// deploy blocker). Catches an accidental revert to the un-deployable `HooK1111...` id.
#[test]
fn core_hook_id_is_not_placeholder() {
    let placeholder = Pubkey::from_str_const("HooK1111111111111111111111111111111111111111");
    assert_ne!(
        ipworld_hook::ID, placeholder,
        "ipworld_hook::ID is still the placeholder with no private key — Token-2022 pool \
         creation would be undeployable (REQ-E-002 regression)"
    );
}
