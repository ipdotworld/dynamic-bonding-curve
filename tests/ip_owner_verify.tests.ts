/**
 * T-03: IP Owner Verification Tests (LiteSVM)
 *
 * Verifies verify_token, claim_ip_owner_fee, transfer_ip_owner,
 * accept_ip_owner, and link_token_to_ip instructions.
 *
 * Prerequisites:
 *   cargo build-sbf -- --features local,skip-launch-auth
 *   npx ts-mocha -t 120000 tests/ip_owner_verify.tests.ts
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

function deriveTokenVerification(mint: PublicKey): PublicKey {
  // PDA: ["token_verification", mint]
  // TODO: confirm seed from program IDL/source
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_verification"), mint.toBuffer()],
    DBC_PROGRAM_ID
  )[0];
}

function serializeVerifyAuth(ipOwner: PublicKey, mint: PublicKey): Buffer {
  // VerifyAuth message: concat(ip_owner_pubkey, mint_pubkey)
  // TODO: confirm exact serialization from program source
  return Buffer.concat([ipOwner.toBuffer(), mint.toBuffer()]);
}

describe("T-03: IP Owner Verification", () => {
  let admin: Keypair;
  let authority: Keypair;
  let ipOwner: Keypair;
  let newIpOwner: Keypair;
  let wrongSigner: Keypair;
  let baseMint: Keypair;
  let ipworldState: PublicKey;
  let pool: PublicKey;
  let program: Program<VirtualCurve>;

  const quoteMint = NATIVE_MINT;

  before(async () => {
    // TODO: implement
    // Steps:
    //   1. Generate keypairs: admin, authority, ipOwner, newIpOwner, wrongSigner, baseMint
    //   2. Airdrop SOL to admin, ipOwner, newIpOwner
    //   3. Init IpworldState with authority pubkey
    //   4. Create operator account for admin
    //   5. Create config
    //   6. Create pool (skip-launch-auth feature bypasses Ed25519 for pool creation)
    //   7. Perform some swaps to generate ip_owner_fee accumulation
  });

  it("M-IPO-001: verify_token creates TokenVerification PDA", async () => {
    // TODO: implement
    // Steps:
    //   1. Serialize VerifyAuth message: concat(ipOwner.publicKey, baseMint.publicKey)
    //   2. Sign with authority.secretKey
    //   3. Build Ed25519Program instruction
    //   4. Call program.methods.verifyToken() (or equivalent instruction)
    //      with accounts: [ipOwner, tokenVerificationPDA, baseMint, ipworldState, sysvar]
    //   5. Send tx: [ComputeBudget, ed25519Ix, verifyTokenIx]
    //   6. Verify TokenVerification PDA was created:
    //      - Call connection.getAccountInfo(tokenVerificationPDA)
    //      - Expect: account != null
    //      - Expect: account.owner == DBC_PROGRAM_ID
    //      - Decode account data and verify ip_owner field == ipOwner.publicKey
  });

  it("M-IPO-002: claim_ip_owner_fee fails without verification", async () => {
    // TODO: implement
    // Steps:
    //   1. Use a NEW baseMint that has NOT had verify_token called
    //   2. Create that mint's pool (skip-launch-auth)
    //   3. Perform swaps to accumulate fees
    //   4. Attempt to call claim_ip_owner_fee with ipOwner as signer
    //      WITHOUT a TokenVerification PDA existing
    //   5. Expect: error matching /AccountNotInitialized|custom program error/
    //      (program requires TokenVerification PDA to exist before claiming)
  });

  it("M-IPO-003: claim_ip_owner_fee succeeds after verification", async () => {
    // TODO: implement
    // Steps:
    //   1. verify_token for baseMint (creates TokenVerification PDA)
    //   2. Perform multiple swaps to accumulate ip_owner_fee in the pool
    //   3. Record ipOwner's SOL balance before claim
    //   4. Call claim_ip_owner_fee with:
    //      accounts: [ipOwner, pool, quoteVault, tokenVerificationPDA, ipworldState, ...]
    //   5. Verify SOL was transferred to ipOwner:
    //      - Record ipOwner's SOL balance after claim
    //      - Expect: balance_after > balance_before
    //   6. Verify pool's ip_owner_fee counter reset to 0
  });

  it("M-IPO-004: transfer_ip_owner 2-step works", async () => {
    // TODO: implement
    // Steps:
    //   1. Ensure baseMint has TokenVerification PDA (from M-IPO-001 or re-do verify_token)
    //   2. Call transfer_ip_owner with:
    //      - signer: ipOwner
    //      - pending_ip_owner: newIpOwner.publicKey
    //      - accounts: [ipOwner, tokenVerificationPDA, ...]
    //   3. Verify TokenVerification PDA now has pending_ip_owner == newIpOwner.publicKey
    //   4. Call accept_ip_owner with:
    //      - signer: newIpOwner
    //      - accounts: [newIpOwner, tokenVerificationPDA, ...]
    //   5. Verify TokenVerification PDA now has ip_owner == newIpOwner.publicKey
    //   6. Verify pending_ip_owner is cleared
  });

  it("M-IPO-005: accept_ip_owner by wrong signer rejected", async () => {
    // TODO: implement
    // Steps:
    //   1. Ensure baseMint has TokenVerification PDA
    //   2. Call transfer_ip_owner to propose newIpOwner as pending
    //   3. Attempt accept_ip_owner with wrongSigner (not the pending_ip_owner)
    //   4. Expect: error matching /Unauthorized|custom program error/
  });

  it("M-IPO-006: link_token_to_ip sets ipa_id", async () => {
    // TODO: implement
    // Steps:
    //   1. Ensure baseMint has TokenVerification PDA with verified ip_owner
    //   2. Choose a test IPA ID (e.g., u64 value 12345)
    //   3. Call link_token_to_ip with:
    //      - signer: ipOwner (current ip_owner of the token)
    //      - ipa_id: 12345
    //      - accounts: [ipOwner, tokenVerificationPDA, ...]
    //   4. Fetch TokenVerification PDA data
    //   5. Decode and verify ipa_id field == 12345
    //   6. Verify ip_owner field is unchanged
  });
});
