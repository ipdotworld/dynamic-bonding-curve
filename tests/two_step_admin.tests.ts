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
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { LiteSVM } from "litesvm";
import { createHash } from "crypto";
import {
  createVirtualCurveProgram,
  generateAndFund,
  startSvm,
} from "./utils";
import { deriveIpworldStateAddress } from "./utils/accounts";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from "./utils/constants";
import { VirtualCurveProgram } from "./utils/types";
import { sendTransactionMaybeThrow } from "./utils/common";

function decodeIpworldState(svm: LiteSVM, ipworldState: PublicKey) {
  const account = svm.getAccount(ipworldState);
  const data = Buffer.from(account.data);
  // Layout: 8 disc + 32 authority + 32 admin + 32 pending_authority + 32 pending_admin + 1 bump
  return {
    authority: new PublicKey(data.subarray(8, 40)),
    admin: new PublicKey(data.subarray(40, 72)),
    pendingAuthority: new PublicKey(data.subarray(72, 104)),
    pendingAdmin: new PublicKey(data.subarray(104, 136)),
    bump: data[136],
  };
}

describe("T-04: 2-Step Admin", () => {
  let svm: LiteSVM;
  let currentAdmin: Keypair;
  let pendingAdmin: Keypair;
  let secondPendingAdmin: Keypair;
  let wrongSigner: Keypair;
  let ipworldState: PublicKey;
  let program: VirtualCurveProgram;

  before(async () => {
    svm = startSvm();
    // startSvm() creates ipworldState with a random authority/admin.
    // We need to set a KNOWN admin. Overwrite the ipworldState PDA.
    currentAdmin = generateAndFund(svm);
    pendingAdmin = generateAndFund(svm);
    secondPendingAdmin = generateAndFund(svm);
    wrongSigner = generateAndFund(svm);
    program = createVirtualCurveProgram();

    ipworldState = deriveIpworldStateAddress();
    const [, ipworldBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("ipworld_state")],
      DYNAMIC_BONDING_CURVE_PROGRAM_ID
    );
    const discriminator = createHash("sha256")
      .update("account:IpworldState")
      .digest()
      .subarray(0, 8);
    const zeroKey = PublicKey.default;
    const ipworldData = Buffer.alloc(137);
    discriminator.copy(ipworldData, 0);
    currentAdmin.publicKey.toBuffer().copy(ipworldData, 8);   // authority
    currentAdmin.publicKey.toBuffer().copy(ipworldData, 40);  // admin = currentAdmin
    zeroKey.toBuffer().copy(ipworldData, 72);                 // pending_authority
    zeroKey.toBuffer().copy(ipworldData, 104);                // pending_admin
    ipworldData.writeUInt8(ipworldBump, 136);
    svm.setAccount(ipworldState, {
      lamports: 1_000_000_000,
      data: ipworldData,
      owner: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      executable: false,
    });

    // Verify setup
    const state = decodeIpworldState(svm, ipworldState);
    expect(state.admin.equals(currentAdmin.publicKey)).to.be.true;
    expect(state.pendingAdmin.equals(PublicKey.default)).to.be.true;
  });

  it("M-ADM-001: propose admin change stores pending_admin", async () => {
    const tx = await program.methods
      .updateIpworldAdmin(pendingAdmin.publicKey)
      .accountsPartial({
        admin: currentAdmin.publicKey,
        ipworldState,
      })
      .transaction();

    sendTransactionMaybeThrow(svm, tx, [currentAdmin]);

    const state = decodeIpworldState(svm, ipworldState);
    expect(state.pendingAdmin.equals(pendingAdmin.publicKey)).to.be.true;
    expect(state.admin.equals(currentAdmin.publicKey)).to.be.true;
  });

  it("M-ADM-002: accept admin by pending_admin succeeds", async () => {
    const tx = await program.methods
      .acceptIpworldAdmin()
      .accountsPartial({
        newAdmin: pendingAdmin.publicKey,
        ipworldState,
      })
      .transaction();

    sendTransactionMaybeThrow(svm, tx, [pendingAdmin]);

    const state = decodeIpworldState(svm, ipworldState);
    expect(state.admin.equals(pendingAdmin.publicKey)).to.be.true;
    expect(state.pendingAdmin.equals(PublicKey.default)).to.be.true;
  });

  it("M-ADM-003: accept admin by non-pending rejected", async () => {
    // pendingAdmin is now admin (from M-ADM-002). Propose secondPendingAdmin.
    const proposeTx = await program.methods
      .updateIpworldAdmin(secondPendingAdmin.publicKey)
      .accountsPartial({
        admin: pendingAdmin.publicKey,
        ipworldState,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, proposeTx, [pendingAdmin]);

    // wrongSigner tries to accept — should fail
    const acceptTx = await program.methods
      .acceptIpworldAdmin()
      .accountsPartial({
        newAdmin: wrongSigner.publicKey,
        ipworldState,
      })
      .transaction();

    let failed = false;
    try {
      sendTransactionMaybeThrow(svm, acceptTx, [wrongSigner]);
    } catch (e: any) {
      failed = true;
      expect(e.message).to.match(/Unauthorized|custom program error/);
    }
    expect(failed, "accept by non-pending should have failed").to.be.true;

    // Admin unchanged
    const state = decodeIpworldState(svm, ipworldState);
    expect(state.admin.equals(pendingAdmin.publicKey)).to.be.true;
  });

  it("M-ADM-004: null pubkey rejected for admin", async () => {
    // Proposing PublicKey.default should fail — would lock the protocol
    const tx = await program.methods
      .updateIpworldAdmin(PublicKey.default)
      .accountsPartial({
        admin: pendingAdmin.publicKey,
        ipworldState,
      })
      .transaction();

    let failed = false;
    try {
      sendTransactionMaybeThrow(svm, tx, [pendingAdmin]);
    } catch (e: any) {
      failed = true;
      expect(e.message).to.match(/InvalidAdmin|custom program error/);
    }
    expect(failed, "null pubkey proposal should have failed").to.be.true;
  });

  it("M-ADM-005: propose overwrites previous pending", async () => {
    // From M-ADM-003: secondPendingAdmin is pending. Now propose wrongSigner instead.
    const tx = await program.methods
      .updateIpworldAdmin(wrongSigner.publicKey)
      .accountsPartial({
        admin: pendingAdmin.publicKey,
        ipworldState,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, tx, [pendingAdmin]);

    const state = decodeIpworldState(svm, ipworldState);
    expect(state.pendingAdmin.equals(wrongSigner.publicKey)).to.be.true;

    // secondPendingAdmin can no longer accept
    const acceptTx = await program.methods
      .acceptIpworldAdmin()
      .accountsPartial({
        newAdmin: secondPendingAdmin.publicKey,
        ipworldState,
      })
      .transaction();

    let failed = false;
    try {
      sendTransactionMaybeThrow(svm, acceptTx, [secondPendingAdmin]);
    } catch (e: any) {
      failed = true;
      expect(e.message).to.match(/Unauthorized|custom program error/);
    }
    expect(failed, "old pending admin should not be able to accept").to.be.true;
  });
});
