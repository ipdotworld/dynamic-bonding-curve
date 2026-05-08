/**
 * Step 2 — IpworldState admin instructions (LiteSVM)
 *
 * Verifies IpworldState init, authority update, and admin update.
 * startSvm() already creates IpworldState PDA so we test update/accept operations.
 *
 * Prerequisites:
 *   cargo build-sbf -- --features local
 *   npx ts-mocha -t 120000 tests/ipworld_state.tests.ts
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { LiteSVM } from "litesvm";
import {
  createVirtualCurveProgram,
  generateAndFund,
  startSvm,
} from "./utils";
import { getSvmAuthority } from "./utils/svm";
import { sendTransactionMaybeThrow } from "./utils/common";
import { deriveIpworldStateAddress } from "./utils/accounts";
import { VirtualCurveProgram } from "./utils/types";

function decodeIpworldState(svm: LiteSVM, ipworldState: PublicKey): {
  authority: PublicKey;
  admin: PublicKey;
  pendingAuthority: PublicKey;
  pendingAdmin: PublicKey;
  bump: number;
} {
  const account = svm.getAccount(ipworldState);
  if (!account) throw new Error("IpworldState account not found");
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

describe("Step 2 — IpworldState admin instructions", () => {
  let svm: LiteSVM;
  let program: VirtualCurveProgram;
  let ipworldStatePDA: PublicKey;

  let admin: Keypair;

  before(async () => {
    svm = startSvm();
    program = createVirtualCurveProgram();
    ipworldStatePDA = deriveIpworldStateAddress();
    admin = generateAndFund(svm);

    // Overwrite ipworldState with known admin (same pattern as two_step_admin)
    const { DYNAMIC_BONDING_CURVE_PROGRAM_ID } = await import("./utils/constants");
    const [, ipworldBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("ipworld_state")],
      DYNAMIC_BONDING_CURVE_PROGRAM_ID
    );
    const { createHash } = await import("crypto");
    const discriminator = createHash("sha256")
      .update("account:IpworldState")
      .digest()
      .subarray(0, 8);
    const zeroKey = PublicKey.default;
    const ipworldData = Buffer.alloc(137);
    discriminator.copy(ipworldData, 0);
    admin.publicKey.toBuffer().copy(ipworldData, 8);    // authority
    admin.publicKey.toBuffer().copy(ipworldData, 40);   // admin
    zeroKey.toBuffer().copy(ipworldData, 72);
    zeroKey.toBuffer().copy(ipworldData, 104);
    ipworldData.writeUInt8(ipworldBump, 136);
    svm.setAccount(ipworldStatePDA, {
      lamports: 1_000_000_000,
      data: ipworldData,
      owner: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      executable: false,
    });
  });

  it("init_ipworld_state — PDA exists with correct fields", async () => {
    const state = decodeIpworldState(svm, ipworldStatePDA);
    expect(state.authority.equals(admin.publicKey)).to.be.true;
    expect(state.admin.equals(admin.publicKey)).to.be.true;
  });

  it("init_ipworld_state — double init should fail", async () => {
    // IpworldState is already initialized by startSvm(), re-init should fail.
    // We use a fresh admin with known keypair to attempt re-init.
    const freshAdmin = generateAndFund(svm);
    const freshAuthority = Keypair.generate();

    const disc = createHash("sha256")
      .update("global:init_ipworld_state")
      .digest()
      .slice(0, 8);
    const data = Buffer.concat([disc, freshAuthority.publicKey.toBuffer()]);

    const { TransactionInstruction, SystemProgram, Transaction } = await import("@solana/web3.js");
    const { DYNAMIC_BONDING_CURVE_PROGRAM_ID } = await import("./utils/constants");

    const initIx = new TransactionInstruction({
      programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      keys: [
        { pubkey: freshAdmin.publicKey, isSigner: true, isWritable: true },
        { pubkey: ipworldStatePDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(initIx);

    let failed = false;
    try {
      sendTransactionMaybeThrow(svm, tx, [freshAdmin]);
    } catch {
      failed = true;
    }
    expect(failed, "Double init should have failed").to.be.true;
  });

  it("update_ipworld_authority — admin can rotate authority (2-step)", async () => {
    const newAuthority = generateAndFund(svm);

    // Step 1: Propose new authority
    const proposeTx = await program.methods
      .updateIpworldAuthority(newAuthority.publicKey)
      .accountsPartial({
        admin: admin.publicKey,
        ipworldState: ipworldStatePDA,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, proposeTx, [admin]);

    let state = decodeIpworldState(svm, ipworldStatePDA);
    expect(state.pendingAuthority.equals(newAuthority.publicKey)).to.be.true;
    expect(state.authority.equals(admin.publicKey)).to.be.true; // unchanged yet

    // Step 2: Accept as new authority
    const acceptTx = await program.methods
      .acceptIpworldAuthority()
      .accountsPartial({
        newAuthority: newAuthority.publicKey,
        ipworldState: ipworldStatePDA,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, acceptTx, [newAuthority]);

    state = decodeIpworldState(svm, ipworldStatePDA);
    expect(state.authority.equals(newAuthority.publicKey)).to.be.true;
    expect(state.pendingAuthority.equals(PublicKey.default)).to.be.true;

    // Restore: propose admin back as authority, then accept
    const restoreProposeTx = await program.methods
      .updateIpworldAuthority(admin.publicKey)
      .accountsPartial({ admin: admin.publicKey, ipworldState: ipworldStatePDA })
      .transaction();
    sendTransactionMaybeThrow(svm, restoreProposeTx, [admin]);
    const restoreAcceptTx = await program.methods
      .acceptIpworldAuthority()
      .accountsPartial({ newAuthority: admin.publicKey, ipworldState: ipworldStatePDA })
      .transaction();
    sendTransactionMaybeThrow(svm, restoreAcceptTx, [admin]);
  });

  it("update_ipworld_authority — wrong signer rejected", async () => {
    const imposter = generateAndFund(svm);
    const newAuthority = Keypair.generate();

    const updateTx = await program.methods
      .updateIpworldAuthority(newAuthority.publicKey)
      .accountsPartial({
        admin: imposter.publicKey,
        ipworldState: ipworldStatePDA,
      })
      .transaction();

    let failed = false;
    try {
      sendTransactionMaybeThrow(svm, updateTx, [imposter]);
    } catch {
      failed = true;
    }
    expect(failed, "Wrong signer should be rejected").to.be.true;
  });

  it("update_ipworld_admin — admin can transfer admin rights (2-step)", async () => {
    const newAdmin = generateAndFund(svm);

    // Propose new admin
    const proposeTx = await program.methods
      .updateIpworldAdmin(newAdmin.publicKey)
      .accountsPartial({
        admin: admin.publicKey,
        ipworldState: ipworldStatePDA,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, proposeTx, [admin]);

    let state = decodeIpworldState(svm, ipworldStatePDA);
    expect(state.pendingAdmin.equals(newAdmin.publicKey)).to.be.true;

    // Accept as new admin
    const acceptTx = await program.methods
      .acceptIpworldAdmin()
      .accountsPartial({
        newAdmin: newAdmin.publicKey,
        ipworldState: ipworldStatePDA,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, acceptTx, [newAdmin]);

    state = decodeIpworldState(svm, ipworldStatePDA);
    expect(state.admin.equals(newAdmin.publicKey)).to.be.true;

    // Verify old admin is locked out (admin was the old admin, now newAdmin is admin)
    const anotherAuthority = Keypair.generate();
    const lockoutTx = await program.methods
      .updateIpworldAuthority(anotherAuthority.publicKey)
      .accountsPartial({
        admin: admin.publicKey,
        ipworldState: ipworldStatePDA,
      })
      .transaction();

    let failed = false;
    try {
      sendTransactionMaybeThrow(svm, lockoutTx, [admin]);
    } catch {
      failed = true;
    }
    expect(failed, "Old admin should be locked out after transfer").to.be.true;
  });
});
