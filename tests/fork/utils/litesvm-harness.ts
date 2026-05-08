/**
 * SPEC-DBC-004 Phase 8 (REQ-V-003 + REQ-F-001..003) — LiteSVM harness for fork tests.
 *
 * Purpose:
 *   Wraps the existing `tests/utils/svm.ts::startSvm()` factory with the
 *   fork-test-specific guarantees:
 *     1. RPC URL availability (gracefully skips when SOLANA_MAINNET_RPC_URL is unset)
 *     2. Optional fixture-driven account population
 *
 * Path A (LiteSVM): used by scenarios 01-10, 12. Programs are pre-loaded by
 * `startSvm()`; mainnet account dumps (if any) are layered on top via
 * `populateFixtureAccounts()`.
 *
 * Path B (solana-test-validator --clone-account): used by scenario 11 only.
 * That scenario opts out of this harness and relies on a separately-spawned
 * validator + Connection.
 *
 * Runtime behavior:
 *   - `requireForkRpc(this)` MUST be called inside Mocha `before(function () { ... })`
 *     so that `this.skip()` propagates to all child tests in the suite.
 *   - When `SOLANA_MAINNET_RPC_URL` is unset, the entire describe block is
 *     marked pending — no failures are produced.
 */

import { LiteSVM } from "litesvm";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { startSvm } from "../../utils/svm";

/** Lazily resolve the configured mainnet RPC URL (undefined when unset). */
export function getForkRpcUrl(): string | undefined {
  const url = process.env.SOLANA_MAINNET_RPC_URL;
  return url && url.length > 0 ? url : undefined;
}

/**
 * Mocha `before()` helper — call as `before(function () { requireForkRpc(this); })`.
 * If the RPC URL is unset, the entire suite is marked pending via `this.skip()`.
 *
 * The function accepts the mocha context (an object with `skip()` method) so
 * we don't tightly couple to mocha's type definitions in this layer.
 */
export function requireForkRpc(mochaContext: { skip: () => void }): string | undefined {
  const url = getForkRpcUrl();
  if (!url) {
    // Print a one-line hint so a user running `yarn test:fork` without
    // configuration sees what is happening (informational; exits 0).
    // Mocha will mark all subsequent tests in the same `describe` as pending.
    // eslint-disable-next-line no-console
    console.log(
      "[fork] Skipping fork tests: SOLANA_MAINNET_RPC_URL is unset"
    );
    mochaContext.skip();
    return undefined;
  }
  return url;
}

/**
 * Boot a LiteSVM instance with all DBC programs loaded, suitable for Path A
 * fork scenarios. Equivalent to `tests/utils/svm.ts::startSvm()`; surfaced
 * here so fork scenarios import a single harness module.
 */
export function bootForkSvm(): LiteSVM {
  return startSvm();
}

/**
 * Optional helper: populate LiteSVM with mainnet account dumps from
 * `tests/fork/fixtures/`. Each fixture is a JSON file produced by
 * `solana account --output json <pubkey> > <slug>.json` (or via
 * `clone-mainnet-account.ts::cloneMainnetAccount`).
 *
 * The fixture filename (without `.json` extension) is treated as a label for
 * diagnostic purposes; the on-chain pubkey is read from the `pubkey` field of
 * the JSON. Missing files are skipped (warning logged) rather than erroring,
 * so partial fixture sets do not break a scenario.
 */
export function populateFixtureAccounts(svm: LiteSVM, slugs: string[]): void {
  const fixtureDir = path.resolve(__dirname, "..", "fixtures");
  for (const slug of slugs) {
    const filePath = path.join(fixtureDir, `${slug}.json`);
    if (!fs.existsSync(filePath)) {
      // eslint-disable-next-line no-console
      console.warn(`[fork] fixture missing (skipped): ${slug}.json`);
      continue;
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    // Solana CLI shape: { account: { lamports, owner, data: [base64, "base64"], executable, rentEpoch }, pubkey }
    const pk = new PublicKey(raw.pubkey);
    const acct = raw.account;
    const dataBase64 = Array.isArray(acct.data) ? acct.data[0] : acct.data;
    svm.setAccount(pk, {
      lamports: BigInt(acct.lamports),
      data: new Uint8Array(Buffer.from(dataBase64, "base64")),
      owner: new PublicKey(acct.owner),
      executable: Boolean(acct.executable),
    });
  }
}
