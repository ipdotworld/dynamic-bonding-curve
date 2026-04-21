/**
 * T-04: 2-Step Admin Transfer Tests (LiteSVM)
 *
 * Verifies that the IpworldState admin can only be transferred via a
 * 2-step propose/accept pattern, and that edge cases are rejected.
 *
 * Prerequisites:
 *   cargo build-sbf -- --features local
 *   npx ts-mocha -t 120000 tests/two_step_admin.tests.ts
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { createHash } from "crypto";
import VirtualCurveIDL from "../target/idl/dynamic_bonding_curve.json";
import { DynamicBondingCurve as VirtualCurve } from "../target/types/dynamic_bonding_curve";

const DBC_PROGRAM_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");

const connection = new Connection("http://127.0.0.1:8899", "confirmed");

function anchorDisc(name: string): Buffer {
  return createHash("sha256").update(name).digest().subarray(0, 8);
}

async function airdrop(pubkey: PublicKey, sol: number) {
  const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

function deriveIpworldState(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("ipworld_state")], DBC_PROGRAM_ID);
}

describe("T-04: 2-Step Admin", () => {
  let currentAdmin: Keypair;
  let pendingAdmin: Keypair;
  let secondPendingAdmin: Keypair;
  let wrongSigner: Keypair;
  let ipworldState: PublicKey;
  let program: Program<VirtualCurve>;

  before(async () => {
    // TODO: implement
    // Steps:
    //   1. Generate keypairs: currentAdmin, pendingAdmin, secondPendingAdmin, wrongSigner
    //   2. Airdrop SOL to all keypairs that will sign txs
    //   3. Init IpworldState with currentAdmin as initial admin
    //      using init_ipworld_state instruction
    //   4. Verify IpworldState.admin == currentAdmin.publicKey
  });

  it("M-ADM-001: propose admin change stores pending_admin", async () => {
    // TODO: implement
    // Steps:
    //   1. Call propose_new_admin (or transfer_admin) instruction with:
    //      - signer: currentAdmin
    //      - new_admin: pendingAdmin.publicKey
    //      - accounts: [currentAdmin, ipworldState]
    //   2. Fetch IpworldState account data
    //   3. Decode the account and verify:
    //      - ipworldState.pending_admin == pendingAdmin.publicKey
    //      - ipworldState.admin == currentAdmin.publicKey (unchanged yet)
  });

  it("M-ADM-002: accept admin by pending_admin succeeds", async () => {
    // TODO: implement
    // Prerequisite: M-ADM-001 must have run (pending_admin is set to pendingAdmin)
    // Steps:
    //   1. Call accept_admin instruction with:
    //      - signer: pendingAdmin (the current pending_admin)
    //      - accounts: [pendingAdmin, ipworldState]
    //   2. Fetch IpworldState account data
    //   3. Decode and verify:
    //      - ipworldState.admin == pendingAdmin.publicKey
    //      - ipworldState.pending_admin is cleared (PublicKey.default or None)
    //   4. Note: after this test, currentAdmin is no longer admin
  });

  it("M-ADM-003: accept admin by non-pending rejected", async () => {
    // TODO: implement
    // Prerequisite: pendingAdmin is now admin (from M-ADM-002)
    // Steps:
    //   1. Call propose_new_admin with pendingAdmin (new current admin) proposing secondPendingAdmin
    //   2. Attempt accept_admin with wrongSigner (not secondPendingAdmin)
    //   3. Expect: error matching /Unauthorized|custom program error/
    //   4. Verify IpworldState.admin is still pendingAdmin.publicKey (unchanged)
  });

  it("M-ADM-004: null pubkey rejected for admin", async () => {
    // TODO: implement
    // Background:
    //   Proposing PublicKey.default (all zeros) as new admin would lock the protocol
    //   by making it impossible to accept (no one holds the zero private key).
    //   The program should reject this.
    //
    // Steps:
    //   1. Call propose_new_admin with new_admin == PublicKey.default
    //   2. Expect: error (program should validate new_admin != default pubkey)
    //   3. Verify IpworldState.pending_admin is NOT set to default pubkey
  });

  it("M-ADM-005: propose overwrites previous pending", async () => {
    // TODO: implement
    // Background:
    //   If admin proposes A then proposes B before A accepts,
    //   only B should be the pending_admin (A's opportunity is gone).
    //
    // Steps:
    //   1. Call propose_new_admin with new_admin == pendingAdmin
    //   2. Before pendingAdmin accepts, call propose_new_admin again with secondPendingAdmin
    //   3. Fetch IpworldState account data
    //   4. Verify:
    //      - ipworldState.pending_admin == secondPendingAdmin.publicKey
    //      - (pendingAdmin's pending status is overwritten)
    //   5. Verify pendingAdmin can no longer accept (attempt should fail)
  });
});
