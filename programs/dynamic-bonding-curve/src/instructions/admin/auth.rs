use anchor_lang::prelude::*;

pub mod admin {
    use anchor_lang::{prelude::Pubkey, solana_program::pubkey};

    pub const ADMINS: [Pubkey; 2] = [
        pubkey!("5unTfT2kssBuNvHPY6LbJfJpLqEcdMxGYLWHwShaeTLi"),
        pubkey!("DHLXnJdACTY83yKwnUkeoDjqi4QBbsYGa1v8tJL76ViX"),
    ];
}

pub mod treasury {
    use anchor_lang::{prelude::Pubkey, solana_program::pubkey};

    // https://app.squads.so/squads/6aYhxiNGmG8AyU25rh2R7iFu4pBrqnQHpNUGhmsEXRcm/treasury
    pub const ID: Pubkey = pubkey!("6aYhxiNGmG8AyU25rh2R7iFu4pBrqnQHpNUGhmsEXRcm");
}

// SPEC-DBC-AUDIT-001 Phase 4 (REQ-D-006 / SEC-CORE-04): the `local` feature makes
// `assert_eq_admin` return `true` unconditionally — a full admin-auth bypass intended
// ONLY for the test pipeline (`anchor build -- --features local`). If it leaked into a
// deployed binary, ALL admin auth would be bypassed.
//
// We cannot gate on `not(test)` because `anchor build --features local` is a normal
// (non-`test`) cargo build, so the test pipeline itself would break. Instead we gate on
// a SEPARATE explicit deploy signal: the `production` feature, which is set ONLY for
// deploy builds and NEVER by the test pipeline. Enabling both `local` and `production`
// is a hard compile error, so a deploy build can never ship the bypass.
//
// Build matrix:
//   - (no features)            -> compiles; real admin check (the `local` bypass is off).
//   - --features local         -> compiles; bypass on. This is exactly what tests use.
//   - --features production     -> compiles; real admin check. The safe deploy build.
//   - --features "local production" -> COMPILE ERROR (the tripwire below).
#[cfg(all(feature = "local", feature = "production"))]
compile_error!("the 'local' admin bypass must not be enabled in a deploy build (feature \"production\"); build the deploy artifact with --features production and WITHOUT --features local");

#[cfg(feature = "local")]
pub fn assert_eq_admin(_admin: Pubkey) -> bool {
    true
}

#[cfg(not(feature = "local"))]
pub fn assert_eq_admin(admin: Pubkey) -> bool {
    crate::admin::admin::ADMINS
        .iter()
        .any(|predefined_admin| predefined_admin.eq(&admin))
}
