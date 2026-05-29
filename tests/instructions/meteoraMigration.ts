// SPEC-DBC-AUDIT-001 — Meteora DAMM v1 migration path REMOVED.
//
// IPWorld migrates exclusively to DAMM v2 via `migration_damm_v2`
// (see dammV2Migration.ts -> migrateToDammV2). The DAMM v1 instructions
// (migrate_meteora_damm, migrate_meteora_damm_lock_lp_token,
// migrate_meteora_damm_claim_lp_token) and the standalone
// migration_damm_v2_create_metadata instruction no longer exist on-chain.
//
// No top-level test imports these builders anymore (the legacy DAMM v1 flow
// lives only in tests/backwards_compatibility/, which has its own copy of these
// helpers). The exports below are retained as throwing stubs so the barrel
// `export * from "./meteoraMigration"` in index.ts keeps resolving; any
// accidental live call surfaces a clear error instead of a silent pass.

import { Keypair, PublicKey } from "@solana/web3.js";
import { LiteSVM } from "litesvm";
import { VirtualCurveProgram } from "../utils";

const REMOVED =
  "Meteora DAMM v1 migration was removed (A-01). IPWorld migrates only to " +
  "DAMM v2 via migrateToDammV2 (dammV2Migration.ts).";

export type CreateMeteoraMetadata = {
  payer: Keypair;
  virtualPool: PublicKey;
  config: PublicKey;
};

export async function createMeteoraMetadata(
  _svm: LiteSVM,
  _program: VirtualCurveProgram,
  _params: CreateMeteoraMetadata
): Promise<PublicKey> {
  throw new Error(REMOVED);
}

export type MigrateMeteoraParams = {
  payer: Keypair;
  virtualPool: PublicKey;
  dammConfig: PublicKey;
};

export async function migrateToMeteoraDamm(
  _svm: LiteSVM,
  _program: VirtualCurveProgram,
  _params: MigrateMeteoraParams
): Promise<any> {
  throw new Error(REMOVED);
}

export type LockLPDammForCreatorParams = {
  payer: Keypair;
  virtualPool: PublicKey;
  dammConfig: PublicKey;
};

export async function lockLpForCreatorDamm(
  _svm: LiteSVM,
  _program: VirtualCurveProgram,
  _params: LockLPDammForCreatorParams
): Promise<PublicKey> {
  throw new Error(REMOVED);
}

export type LockLPDammForPartnerParams = LockLPDammForCreatorParams;

export async function lockLpForPartnerDamm(
  _svm: LiteSVM,
  _program: VirtualCurveProgram,
  _params: LockLPDammForPartnerParams
): Promise<PublicKey> {
  throw new Error(REMOVED);
}

export async function partnerClaimLpDamm(
  _svm: LiteSVM,
  _program: VirtualCurveProgram,
  _params: LockLPDammForPartnerParams
): Promise<any> {
  throw new Error(REMOVED);
}

export async function creatorClaimLpDamm(
  _svm: LiteSVM,
  _program: VirtualCurveProgram,
  _params: LockLPDammForCreatorParams
): Promise<any> {
  throw new Error(REMOVED);
}
