/**
 * T-05: TradeAuth Buy/Sell Asymmetry Tests (solana-test-validator)
 *
 * Verifies that TradeAuth is required for buys (QuoteToBase) but NOT for
 * sells (BaseToQuote), and that expired TradeAuth is rejected.
 *
 * Buy direction: SOL (quote) → token (base) = QuoteToBase
 * Sell direction: token (base) → SOL (quote) = BaseToQuote
 *
 * Prerequisites:
 *   cargo build-sbf -- --features local,skip-launch-auth
 *   solana-test-validator \
 *     --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN target/deploy/dynamic_bonding_curve.so \
 *     --bpf-program HooK1111111111111111111111111111111111111111 target/deploy/ipworld_hook.so \
 *     --reset
 *   npx ts-mocha -t 120000 tests/trade_auth_asymmetry.tests.ts
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
  const buf = Buffer.alloc(40); // 32 bytes pubkey + 8 bytes i64
  user.toBuffer().copy(buf, 0);
  buf.writeBigInt64LE(BigInt(expiresAt), 32);
  return buf;
}

describe("T-05: TradeAuth Buy/Sell Asymmetry", () => {
  let admin: Keypair;
  let authority: Keypair;
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
    //   1. Generate keypairs: admin, authority, trader
    //   2. Airdrop SOL to admin and trader (50 SOL each)
    //   3. Init IpworldState with authority pubkey
    //   4. Create operator account for admin
    //   5. Create config
    //   6. Create pool (skip-launch-auth bypasses Ed25519 for creation)
    //   7. Setup trader's token accounts (WSOL ATA, base token ATA)
    //   8. Wrap some SOL for trader to use in buys
  });

  async function buildBuyIx(buyer: Keypair): Promise<TransactionInstruction> {
    // TODO: implement
    // Build swap instruction for QuoteToBase (SOL → token)
    // SwapMode: ExactIn with amount = 0.01 SOL
    // This is the direction that requires TradeAuth
    // Following the pattern from trade_auth.tests.ts buildSwapIx()
    throw new Error("TODO: implement buildBuyIx");
  }

  async function buildSellIx(seller: Keypair, tokenAmount: BN): Promise<TransactionInstruction> {
    // TODO: implement
    // Build swap instruction for BaseToQuote (token → SOL)
    // This direction does NOT require TradeAuth
    throw new Error("TODO: implement buildSellIx");
  }

  it("M-AUTH-001: Buy (QuoteToBase) requires TradeAuth", async () => {
    // TODO: implement
    // Steps:
    //   1. Build buy instruction (QuoteToBase, SOL → token)
    //   2. Send tx WITHOUT Ed25519 TradeAuth instruction
    //   3. Expect: error matching /MissingEd25519Ix|custom program error/
    //
    // Note: This mirrors the pattern in trade_auth.tests.ts "Swap WITHOUT Ed25519 ix fails"
  });

  it("M-AUTH-002: Sell (BaseToQuote) succeeds without TradeAuth", async () => {
    // TODO: implement
    // Steps:
    //   1. First, perform a valid buy to give trader some tokens:
    //      - Create valid TradeAuth for trader
    //      - Execute buy with Ed25519 ix
    //   2. Build sell instruction (BaseToQuote, token → SOL)
    //   3. Send tx WITHOUT Ed25519 instruction
    //   4. Expect: tx confirms successfully (no TradeAuth needed for sells)
    //
    // This is the core asymmetry: sells are free, buys are gated
  });

  it("M-AUTH-003: Expired TradeAuth rejected", async () => {
    // TODO: implement
    // Steps:
    //   1. Create TradeAuth message for trader with expiresAt = now - 3600 (1 hour ago)
    //   2. Sign with authority.secretKey
    //   3. Build Ed25519Program instruction
    //   4. Build buy instruction (QuoteToBase)
    //   5. Send tx: [ComputeBudget, ed25519Ix, buyIx]
    //   6. Expect: error matching /TradeAuthExpired|custom program error/
    //
    // Note: This mirrors the pattern in trade_auth.tests.ts "Swap with EXPIRED TradeAuth fails"
  });
});
