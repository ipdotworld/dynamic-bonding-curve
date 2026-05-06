/**
 * SPEC-DBC-004 Phase 8 (REQ-V-003) — clone mainnet account dumps to local fixtures.
 *
 * Purpose:
 *   Given a configured mainnet RPC URL (`SOLANA_MAINNET_RPC_URL`) and a list of
 *   pubkeys, fetch each account's current state and persist it to
 *   `tests/fork/fixtures/<slug>.json` in the format the Solana CLI uses for
 *   `solana account --output json <pubkey>`.
 *
 *   The persisted shape is intentionally `solana-test-validator --clone-account`
 *   compatible so Path B (scenario 11) can consume the same fixture without
 *   conversion.
 *
 * Refresh policy:
 *   Mainnet PDAs evolve over time (config updates, treasury sets, etc.). The
 *   recommended refresh cadence is 30 days; older fixtures may diverge from
 *   the live state. Each fixture file records its capture timestamp so
 *   reviewers can detect staleness without running `solana account` again.
 *
 * Runtime behavior:
 *   - If `SOLANA_MAINNET_RPC_URL` is unset, the function logs an informative
 *     skip message and exits 0 (it does NOT throw). This matches the broader
 *     Phase 8 graceful-skip contract.
 *   - On RPC failure, the offending pubkey's fixture is skipped and a warning
 *     is logged; the function continues with the remaining pubkeys.
 *
 * Usage example:
 *   // From a one-shot script invoked by an operator who has SOLANA_MAINNET_RPC_URL set:
 *   await cloneMainnetAccounts([
 *     { slug: "dbc-config-mainnet-A", pubkey: new PublicKey("...") },
 *     { slug: "dbc-pool-mainnet-A", pubkey: new PublicKey("...") },
 *   ]);
 */

import { Connection, PublicKey, Commitment } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

export interface CloneTarget {
  slug: string;
  pubkey: PublicKey;
}

export interface CloneResult {
  slug: string;
  pubkey: string;
  ok: boolean;
  reason?: string;
  filePath?: string;
  capturedAt?: string;
}

/**
 * Resolve the mainnet RPC URL from env. Returns undefined when unset; the
 * caller decides whether to skip or throw.
 */
export function getMainnetRpcUrl(): string | undefined {
  const url = process.env.SOLANA_MAINNET_RPC_URL;
  return url && url.length > 0 ? url : undefined;
}

/**
 * Single-account clone. Returns a structured result; never throws.
 */
export async function cloneMainnetAccount(
  target: CloneTarget,
  rpcUrl: string,
  fixturesDir: string,
  commitment: Commitment = "confirmed"
): Promise<CloneResult> {
  const conn = new Connection(rpcUrl, commitment);
  try {
    const info = await conn.getAccountInfo(target.pubkey, commitment);
    if (!info) {
      return {
        slug: target.slug,
        pubkey: target.pubkey.toBase58(),
        ok: false,
        reason: "account does not exist on mainnet",
      };
    }
    const dataBase64 = Buffer.from(info.data).toString("base64");
    const capturedAt = new Date().toISOString();
    const json = {
      pubkey: target.pubkey.toBase58(),
      capturedAt,
      account: {
        lamports: info.lamports,
        owner: info.owner.toBase58(),
        executable: info.executable,
        rentEpoch: info.rentEpoch ?? 0,
        data: [dataBase64, "base64"],
      },
    };
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }
    const filePath = path.join(fixturesDir, `${target.slug}.json`);
    fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + "\n");
    return {
      slug: target.slug,
      pubkey: target.pubkey.toBase58(),
      ok: true,
      filePath,
      capturedAt,
    };
  } catch (err: any) {
    return {
      slug: target.slug,
      pubkey: target.pubkey.toBase58(),
      ok: false,
      reason: `RPC error: ${err?.message ?? String(err)}`,
    };
  }
}

/**
 * Bulk clone helper. Skips all targets and exits 0 (returning empty array)
 * when SOLANA_MAINNET_RPC_URL is unset.
 */
export async function cloneMainnetAccounts(
  targets: CloneTarget[]
): Promise<CloneResult[]> {
  const rpcUrl = getMainnetRpcUrl();
  if (!rpcUrl) {
    // eslint-disable-next-line no-console
    console.log(
      "[fork] cloneMainnetAccounts: SOLANA_MAINNET_RPC_URL is unset; skipping (exit 0)"
    );
    return [];
  }
  const fixturesDir = path.resolve(__dirname, "..", "fixtures");
  const results: CloneResult[] = [];
  for (const target of targets) {
    const r = await cloneMainnetAccount(target, rpcUrl, fixturesDir);
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[fork] clone failed for ${r.slug} (${r.pubkey}): ${r.reason}`
      );
    }
    results.push(r);
  }
  return results;
}
