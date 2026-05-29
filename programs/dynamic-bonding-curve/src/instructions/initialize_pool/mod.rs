// SPEC-DBC-AUDIT-001 Phase 6 (REQ-G-001): the plain-SPL pool-creation path was
// removed. The plain SPL Token program cannot carry a Token-2022 transfer hook,
// so the IPWorld holding cap / P2P block (enforced by `ipworld-hook` on every
// transfer) cannot apply to SPL mints. IPWorld is therefore Token-2022 ONLY:
// `ix_initialize_virtual_pool_with_token2022` is the sole pool-creation
// entrypoint. The deleted file previously hosted the shared pool-init helpers
// (`InitializePoolParameters`, `max_key`, `min_key`); they are relocated here so
// the surviving Token-2022 path keeps importing them via `super::`.
use anchor_lang::prelude::*;
use std::cmp::{max, min};

pub mod ix_initialize_virtual_pool_with_token2022;
pub use ix_initialize_virtual_pool_with_token2022::*;
// `process_create_token_metadata` (Metaplex MPL metadata creation) was removed
// with the SPL path (REQ-G-001) — it was reachable ONLY from the SPL pool-init.
// The Token-2022 path writes metadata via the native Token-2022 metadata
// extension (`token_metadata_initialize`), so no Metaplex helper is needed.

/// Parameters for the (Token-2022) pool-creation instruction: the SPL-mint
/// metadata fields written to the new base mint.
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitializePoolParameters {
    pub name: String,
    pub symbol: String,
    pub uri: String,
}

// The pool PDA is seeded by the lexicographically ordered (max, min) of the
// base/quote mints so the seed is independent of argument order. Helpers kept as
// free functions to work around an Anchor IDL-generation quirk:
// https://github.com/coral-xyz/anchor/issues/3209
pub fn max_key(left: &Pubkey, right: &Pubkey) -> [u8; 32] {
    max(left, right).to_bytes()
}

pub fn min_key(left: &Pubkey, right: &Pubkey) -> [u8; 32] {
    min(left, right).to_bytes()
}
