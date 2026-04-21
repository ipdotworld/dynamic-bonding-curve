/**
 * T-01: Ed25519 Security Tests (LiteSVM)
 *
 * Verifies that Ed25519 signature verification is correctly enforced
 * for LaunchAuth on initialize_virtual_pool_with_token2022.
 *
 * Prerequisites:
 *   cargo build-sbf -- --features local
 *   npx ts-mocha -t 120000 tests/ed25519_security.tests.ts
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { createHash } from "crypto";
import nacl from "tweetnacl";
import VirtualCurveIDL from "../target/idl/dynamic_bonding_curve.json";
import { DynamicBondingCurve as VirtualCurve } from "../target/types/dynamic_bonding_curve";

const DBC_PROGRAM_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
const HOOK_PROGRAM_ID = new PublicKey("HooK1111111111111111111111111111111111111111");
const MAX_SQRT_PRICE = new BN("79226673515401279992447579055");
const MIN_SQRT_PRICE = new BN("4295048017");
const U64_MAX = new BN("18446744073709551615");

const connection = new Connection("http://127.0.0.1:8899", "confirmed");

function anchorDisc(name: string): Buffer {
  return createHash("sha256").update(name).digest().subarray(0, 8);
}

async function airdrop(pubkey: PublicKey, sol: number) {
  const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

function derivePoolAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], DBC_PROGRAM_ID)[0];
}

function deriveIpworldState(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("ipworld_state")], DBC_PROGRAM_ID);
}

function getFirstKey(k1: PublicKey, k2: PublicKey): Buffer {
  const b1 = k1.toBuffer();
  const b2 = k2.toBuffer();
  return Buffer.compare(b1, b2) === 1 ? b1 : b2;
}

function getSecondKey(k1: PublicKey, k2: PublicKey): Buffer {
  const b1 = k1.toBuffer();
  const b2 = k2.toBuffer();
  return Buffer.compare(b1, b2) === 1 ? b2 : b1;
}

function derivePool(config: PublicKey, baseMint: PublicKey, quoteMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      config.toBuffer(),
      getFirstKey(baseMint, quoteMint),
      getSecondKey(baseMint, quoteMint),
    ],
    DBC_PROGRAM_ID
  )[0];
}

function deriveTokenVault(mint: PublicKey, pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_vault"), mint.toBuffer(), pool.toBuffer()],
    DBC_PROGRAM_ID
  )[0];
}

function deriveHookConfig(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("hook_config"), mint.toBuffer()],
    HOOK_PROGRAM_ID
  )[0];
}

function deriveExtraAccountMetaList(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    HOOK_PROGRAM_ID
  )[0];
}

function serializeLaunchAuth(creator: PublicKey, config: PublicKey, poolPda: PublicKey): Buffer {
  return Buffer.concat([creator.toBuffer(), config.toBuffer(), poolPda.toBuffer()]);
}

describe("T-01: Ed25519 Security", () => {
  let admin: Keypair;
  let authority: Keypair;
  let wrongSigner: Keypair;
  let poolCreator: Keypair;
  let config: PublicKey;
  let ipworldState: PublicKey;
  let program: Program<VirtualCurve>;

  const quoteMint = NATIVE_MINT;

  before(async () => {
    // TODO: implement — requires running solana-test-validator with:
    //   --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN target/deploy/dynamic_bonding_curve.so
    //   --bpf-program HooK1111111111111111111111111111111111111111 target/deploy/ipworld_hook.so
    //
    // Setup:
    //   1. Generate keypairs: admin, authority, wrongSigner, poolCreator
    //   2. Airdrop SOL to admin and poolCreator
    //   3. Init IpworldState with authority pubkey
    //   4. Create operator account for admin
    //   5. Create config with standard curve params
  });

  async function buildPoolCreateIx(baseMintKP: Keypair): Promise<{
    ix: TransactionInstruction;
    pool: PublicKey;
  }> {
    // TODO: implement using program.methods.initializeVirtualPoolWithToken2022
    // following the pattern in launch_auth.tests.ts
    throw new Error("TODO: implement buildPoolCreateIx");
  }

  it("M-SEC-001: Valid Ed25519 signature passes verification", async () => {
    // TODO: implement
    // Steps:
    //   1. Generate a fresh baseMintKP
    //   2. Build pool creation instruction
    //   3. Serialize LaunchAuth message: concat(creator, config, pool)
    //   4. Sign with authority.secretKey using nacl.sign.detached
    //   5. Build Ed25519Program instruction with authority pubkey + sig
    //   6. Send tx: [ComputeBudget, ed25519Ix, poolCreateIx]
    //   7. Expect: tx confirms without error
    //   8. Verify pool account exists on-chain
  });

  it("M-SEC-002: Invalid signature rejected", async () => {
    // TODO: implement
    // Steps:
    //   1. Generate a fresh baseMintKP
    //   2. Build pool creation instruction
    //   3. Create a valid LaunchAuth message
    //   4. Sign with authority.secretKey to get valid sig
    //   5. Tamper with the signature bytes (flip first byte)
    //   6. Build Ed25519Program instruction with tampered sig
    //   7. Send tx
    //   8. Expect: tx fails with Ed25519 verification error
  });

  it("M-SEC-003: Wrong authority key rejected", async () => {
    // TODO: implement
    // Steps:
    //   1. Generate a fresh baseMintKP
    //   2. Build pool creation instruction
    //   3. Serialize LaunchAuth message
    //   4. Sign with wrongSigner.secretKey (not the registered authority)
    //   5. Build Ed25519Program instruction with wrongSigner pubkey
    //   6. Send tx
    //   7. Expect: error matching /UnauthorizedSigner|custom program error/
  });

  it("M-SEC-004: Tampered message data rejected", async () => {
    // TODO: implement
    // Steps:
    //   1. Generate a fresh baseMintKP
    //   2. Build pool creation instruction
    //   3. Create original LaunchAuth message and sign with authority
    //   4. Modify the message bytes (e.g., change creator pubkey to wrongSigner)
    //   5. Keep the original signature (sig over original msg)
    //   6. Build Ed25519Program instruction with tampered message + original sig
    //   7. Send tx
    //   8. Expect: Ed25519 verification fails (sig doesn't match tampered msg)
  });

  it("M-SEC-005: instruction_index attack blocked", async () => {
    // TODO: implement
    // Background:
    //   The program reads Ed25519 verification data using pubkey_instruction_index.
    //   An attacker could craft a tx where pubkey_instruction_index points to
    //   a different instruction containing the attacker's pubkey, bypassing verification.
    //
    // Steps:
    //   1. Generate a fresh baseMintKP
    //   2. Build pool creation instruction
    //   3. Create a malicious instruction that contains attacker's pubkey in its data
    //   4. Set pubkey_instruction_index to point to that malicious instruction
    //      (instead of the standard 0xFFFF sentinel for "previous ix")
    //   5. Do NOT include a proper Ed25519Program instruction
    //   6. Send tx
    //   7. Expect: error matching /InvalidEd25519Data|MissingEd25519Ix|custom program error/
  });
});
