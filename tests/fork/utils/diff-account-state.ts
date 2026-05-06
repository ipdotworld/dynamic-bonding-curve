/**
 * SPEC-DBC-004 Phase 8 (REQ-F-002, REQ-F-003) — account state diff helper for
 * mutating fork scenarios.
 *
 * Purpose:
 *   Mutating fork scenarios (canonical list: 02, 03, 04, 05, 06, 08, 09, 10
 *   per spec.md REQ-F-002 table) MUST capture the on-chain account state
 *   before AND after a swap or claim, and assert specific deltas. This helper
 *   provides a small, testable contract that all such scenarios rely on.
 *
 * Contract:
 *   `diffAccountState(svm, pubkeys, mutator)` returns:
 *     - `before`: snapshot of each account's lamports + data length + data hash
 *     - `after`:  same snapshot taken after `mutator()` resolves
 *     - `deltas`: per-pubkey lamport delta and a "changed" boolean per data buffer
 *
 *   The helper does NOT decode account data — it returns raw `Uint8Array`s so
 *   each scenario can apply its own decoder (Anchor zero_copy, AccountLayout,
 *   manual offset reads, etc.).
 *
 * REQ-F-003 alignment:
 *   When a scenario fails, the harness can format `before` vs `after` as a
 *   structured diff for the failure trace. This is exposed via the
 *   `formatDiff()` helper at the bottom of this module.
 */

import { LiteSVM } from "litesvm";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";

export interface AccountSnapshot {
  pubkey: string;
  exists: boolean;
  lamports: bigint;
  owner?: string;
  dataLen: number;
  dataHash?: string;
  data?: Uint8Array;
}

export interface AccountDelta {
  pubkey: string;
  existedBefore: boolean;
  existsAfter: boolean;
  lamportsDelta: bigint;
  dataChanged: boolean;
  dataLenDelta: number;
}

export interface DiffResult {
  before: Record<string, AccountSnapshot>;
  after: Record<string, AccountSnapshot>;
  deltas: Record<string, AccountDelta>;
}

/**
 * Capture a single account's state from LiteSVM. Returns a non-existent
 * snapshot when the account is absent (rather than throwing).
 */
export function snapshotAccount(svm: LiteSVM, pubkey: PublicKey): AccountSnapshot {
  const acct = svm.getAccount(pubkey);
  const pkStr = pubkey.toBase58();
  if (!acct) {
    return {
      pubkey: pkStr,
      exists: false,
      lamports: BigInt(0),
      dataLen: 0,
    };
  }
  const data = new Uint8Array(acct.data);
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
  return {
    pubkey: pkStr,
    exists: true,
    lamports: BigInt(acct.lamports),
    owner: acct.owner.toBase58(),
    dataLen: data.length,
    dataHash: hash,
    data,
  };
}

/**
 * Capture multiple accounts at once.
 */
export function snapshotAccounts(
  svm: LiteSVM,
  pubkeys: PublicKey[]
): Record<string, AccountSnapshot> {
  const result: Record<string, AccountSnapshot> = {};
  for (const pk of pubkeys) {
    result[pk.toBase58()] = snapshotAccount(svm, pk);
  }
  return result;
}

/**
 * Wrap an async mutating operation with before/after snapshots and compute
 * per-account deltas. The `mutator` function is responsible for performing
 * the actual swap, claim, or other state-changing instruction.
 */
export async function diffAccountState(
  svm: LiteSVM,
  pubkeys: PublicKey[],
  mutator: () => Promise<void> | void
): Promise<DiffResult> {
  const before = snapshotAccounts(svm, pubkeys);
  await mutator();
  const after = snapshotAccounts(svm, pubkeys);

  const deltas: Record<string, AccountDelta> = {};
  for (const pk of pubkeys) {
    const key = pk.toBase58();
    const b = before[key];
    const a = after[key];
    deltas[key] = {
      pubkey: key,
      existedBefore: b.exists,
      existsAfter: a.exists,
      lamportsDelta: a.lamports - b.lamports,
      dataChanged: b.dataHash !== a.dataHash,
      dataLenDelta: a.dataLen - b.dataLen,
    };
  }
  return { before, after, deltas };
}

/**
 * Pretty-print a DiffResult for failure traces. Used by REQ-F-003 reporting.
 */
export function formatDiff(diff: DiffResult): string {
  const lines: string[] = [];
  for (const key of Object.keys(diff.deltas)) {
    const d = diff.deltas[key];
    const b = diff.before[key];
    const a = diff.after[key];
    lines.push(
      `account=${key} existed=${d.existedBefore}->${d.existsAfter} lamports=${b.lamports.toString()}->${a.lamports.toString()} (Δ=${d.lamportsDelta.toString()}) dataLen=${b.dataLen}->${a.dataLen} (Δ=${d.dataLenDelta}) dataChanged=${d.dataChanged}`
    );
  }
  return lines.join("\n");
}
