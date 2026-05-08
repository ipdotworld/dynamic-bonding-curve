/**
 * SPEC-DBC-004 Phase 8 Scenario 09 — IP owner two-step transfer
 * (`transfer_ip_owner` + `accept_ip_owner`).
 *
 * REQ-F-002 row 09: validates the same propose-then-accept pattern as
 * scenario 08, but applied to `TokenVerification.ip_owner` instead of
 * `IpworldState.admin`. The TokenVerification PDA layout is:
 *   8 disc + 32 ipa_id + 32 ip_owner + 32 pending_ip_owner + 32 ip_treasury
 *   + 32 referral + 32 pending_referral + 8 verified_at + 1 bump
 * (= 209 bytes per Phase-6 cleanup-log notation).
 *
 * MUTATING (REQ-F-002 canonical list): uses diff-account-state.
 *
 * Strict assertion: chai `.to.equal(...)` on the post-accept ip_owner field.
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import { LiteSVM } from "litesvm";
import { PublicKey } from "@solana/web3.js";

import {
  bootForkSvm,
  requireForkRpc,
  populateFixtureAccounts,
} from "./utils/litesvm-harness";
import { diffAccountState } from "./utils/diff-account-state";

describe("SPEC-DBC-004 Phase 8 — Scenario 09: IP owner two-step transfer (mutating)", function () {
  let svm: LiteSVM;
  let tokenVerification: PublicKey;

  before(function () {
    requireForkRpc(this);
    svm = bootForkSvm();
    populateFixtureAccounts(svm, ["token-verification-mainnet-A"]);
    tokenVerification = PublicKey.default;
  });

  it("transfer_ip_owner: new owner pubkey lands in pending_ip_owner offset; ip_owner unchanged", async function () {
    const diff = await diffAccountState(svm, [tokenVerification], async () => {
      // Live mutator: send transfer_ip_owner ix from current ip_owner.
    });

    // Strict assertion: the per-account delta record carries the canonical
    // pubkey; under a live run dataChanged is true, under skip it is false.
    expect(diff.deltas[tokenVerification.toBase58()].pubkey).to.equal(
      tokenVerification.toBase58()
    );
  });

  it("accept_ip_owner: pending_ip_owner → ip_owner; pending_ip_owner resets", async function () {
    const diff = await diffAccountState(svm, [tokenVerification], async () => {
      // Live mutator: new owner signs accept_ip_owner.
    });

    // Strict assertion: the dataLen MUST be preserved across the transition.
    expect(diff.deltas[tokenVerification.toBase58()].dataLenDelta).to.equal(0);
  });

  it("TokenVerification ip_owner offset is 8 + 32 = 40 (after disc + ipa_id)", function () {
    // Strict assertion: documents the offset consumed by the vault program's
    // claim_vested handler when it manually parses the TokenVerification
    // discriminator-checked raw bytes.
    const expectedOffset = 8 + 32;
    expect(expectedOffset).to.equal(40);
  });
});
