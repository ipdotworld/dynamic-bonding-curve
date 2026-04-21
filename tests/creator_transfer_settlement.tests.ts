/**
 * T-07: Creator Transfer Settlement Tests (LiteSVM / solana-test-validator)
 *
 * Verifies that pool creator transfer enforces fee settlement:
 * - transfer_pool_creator is blocked when there are unclaimed creator fees
 * - transfer_pool_creator succeeds after all fees are claimed
 * - After transfer, the new creator starts with zero fee counters
 *
 * Prerequisites:
 *   cargo build-sbf -- --features local,skip-launch-auth
 *   solana-test-validator \
 *     --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN target/deploy/dynamic_bonding_curve.so \
 *     --bpf-program HooK1111111111111111111111111111111111111111 target/deploy/ipworld_hook.so \
 *     --reset
 *   npx ts-mocha -t 120000 tests/creator_transfer_settlement.tests.ts
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  Connection,
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
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

function serializeTradeAuth(user: PublicKey, expiresAt: number): Buffer {
  const buf = Buffer.alloc(40);
  user.toBuffer().copy(buf, 0);
  buf.writeBigInt64LE(BigInt(expiresAt), 32);
  return buf;
}

describe("T-07: Creator Transfer Settlement", () => {
  let admin: Keypair;
  let authority: Keypair;
  let creator: Keypair;
  let newCreator: Keypair;
  let trader: Keypair;
  let config: PublicKey;
  let pool: PublicKey;
  let baseMint: Keypair;
  let ipworldState: PublicKey;
  let program: Program<VirtualCurve>;

  const quoteMint = NATIVE_MINT;

  before(async () => {
    // TODO: implement
    // Steps:
    //   1. Generate keypairs: admin, authority, creator, newCreator, trader
    //   2. Airdrop SOL to admin, creator, newCreator, trader
    //   3. Init IpworldState with authority pubkey
    //   4. Create operator account for admin
    //   5. Create config with creatorTradingFeePercentage > 0
    //      (must be non-zero to accumulate creator fees during swaps)
    //   6. Create pool with creator as pool creator
    //      (skip-launch-auth bypasses Ed25519 for pool creation)
    //   7. Setup trader's token accounts and wrap SOL for trading
  });

  async function buildSwapBuyIx(buyer: Keypair, amount: BN): Promise<TransactionInstruction> {
    // TODO: implement
    // Build swap instruction for QuoteToBase (buy direction)
    // Include TradeAuth Ed25519 to avoid TradeAuth rejection
    throw new Error("TODO: implement buildSwapBuyIx");
  }

  async function performSwapsToAccumulateFees(): Promise<void> {
    // TODO: implement
    // Perform several buy swaps to accumulate creator_trading_fee in the pool state
    // The fee accumulates in pool.protocol_base_fee or pool.creator_trading_fee
    // depending on config settings
    throw new Error("TODO: implement performSwapsToAccumulateFees");
  }

  it("M-CRT-001: Transfer blocked with unclaimed fees", async () => {
    // TODO: implement
    // Steps:
    //   1. Perform multiple swaps to accumulate creator fees:
    //      - Call performSwapsToAccumulateFees()
    //      - Verify pool state has non-zero creator_trading_fee
    //   2. Attempt transfer_pool_creator WITHOUT claiming fees first:
    //      - Call program.methods.transferPoolCreator() or equivalent
    //      - Accounts: [creator, newCreator, pool, config, ...]
    //   3. Expect: error matching /UnclaimedFees|custom program error/
    //      (program should require creator_trading_fee == 0 before transfer)
  });

  it("M-CRT-002: Transfer succeeds after claiming fees", async () => {
    // TODO: implement
    // Prerequisite: fees have been accumulated (from M-CRT-001 or fresh setup)
    // Steps:
    //   1. Ensure fees are accumulated (re-run swaps if needed)
    //   2. Claim all creator fees:
    //      - Call claim_creator_trading_fee or equivalent
    //      - Verify pool state has zero creator_trading_fee after claim
    //   3. Call transfer_pool_creator:
    //      - Accounts: [creator, newCreator, pool, config, ...]
    //   4. Expect: tx confirms successfully
    //   5. Fetch pool state and verify:
    //      - pool.creator == newCreator.publicKey
    //      - old creator no longer has creator privileges
  });

  it("M-CRT-003: New creator starts with zero fees", async () => {
    // TODO: implement
    // Prerequisite: M-CRT-002 completed (pool.creator is now newCreator)
    // Steps:
    //   1. Fetch pool state after creator transfer
    //   2. Decode the pool account data
    //   3. Verify:
    //      - creator_trading_fee == 0 (fees start fresh for new creator)
    //      - pool.creator == newCreator.publicKey
    //   4. Perform additional swaps after the transfer
    //   5. Verify new fees accumulate to newCreator (not the old creator)
    //      by checking that old creator's claimable amount stays at 0
  });
});
