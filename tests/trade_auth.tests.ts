/**
 * Step 7 — Trade Auth enforcement tests (solana-test-validator)
 *
 * Proves swaps require a valid Ed25519 TradeAuth signature.
 * Built with --features local,skip-launch-auth (trade auth enforced).
 *
 * Prerequisites:
 *   1. cargo build-sbf -- --features local,skip-launch-auth
 *   2. solana-test-validator \
 *        --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN target/deploy/dynamic_bonding_curve.so \
 *        --bpf-program HooK1111111111111111111111111111111111111111 target/deploy/ipworld_hook.so \
 *        --reset
 *   3. npx ts-mocha -t 120000 tests/trade_auth.tests.ts
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
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
  const b1 = k1.toBuffer(); const b2 = k2.toBuffer();
  return Buffer.compare(b1, b2) === 1 ? b1 : b2;
}

function getSecondKey(k1: PublicKey, k2: PublicKey): Buffer {
  const b1 = k1.toBuffer(); const b2 = k2.toBuffer();
  return Buffer.compare(b1, b2) === 1 ? b2 : b1;
}

function derivePool(config: PublicKey, baseMint: PublicKey, quoteMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), config.toBuffer(), getFirstKey(baseMint, quoteMint), getSecondKey(baseMint, quoteMint)],
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

describe("Step 7 — Trade Auth enforcement", () => {
  let admin: Keypair;
  let authority: Keypair;
  let trader: Keypair;
  let wrongSigner: Keypair;
  let config: PublicKey;
  let pool: PublicKey;
  let baseMint: PublicKey;
  let ipworldState: PublicKey;
  let program: Program<VirtualCurve>;
  const quoteMint = NATIVE_MINT;

  before(async () => {
    admin = Keypair.generate();
    authority = Keypair.generate();
    trader = Keypair.generate();
    wrongSigner = Keypair.generate();

    await airdrop(admin.publicKey, 50);
    await airdrop(trader.publicKey, 50);

    const wallet = new Wallet(admin);
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    program = new Program<VirtualCurve>(VirtualCurveIDL as VirtualCurve, provider);

    // 1. Init IpworldState
    [ipworldState] = deriveIpworldState();
    const initIx = new TransactionInstruction({
      programId: DBC_PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: ipworldState, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([anchorDisc("global:init_ipworld_state"), authority.publicKey.toBuffer()]),
    });
    await sendAndConfirmTransaction(connection, new Transaction().add(initIx), [admin]);

    // 2. Operator
    const operatorPDA = PublicKey.findProgramAddressSync(
      [Buffer.from("operator"), admin.publicKey.toBuffer()], DBC_PROGRAM_ID
    )[0];
    const createOpTx = await program.methods
      .createOperatorAccount(new BN(1))
      .accountsPartial({
        operator: operatorPDA,
        whitelistedAddress: admin.publicKey,
        signer: admin.publicKey,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    await sendAndConfirmTransaction(connection, createOpTx, [admin]);

    // 3. Config
    const curves = [];
    for (let i = 1; i <= 16; i++) {
      curves.push({
        sqrtPrice: i === 16 ? MAX_SQRT_PRICE : MAX_SQRT_PRICE.muln(i * 5).divn(100),
        liquidity: U64_MAX.shln(30 + i),
      });
    }
    const configKP = Keypair.generate();
    config = configKP.publicKey;

    const createConfigTx = await program.methods
      .createConfig({
        poolFees: {
          baseFee: { cliffFeeNumerator: new BN(2_500_000), firstFactor: 0, secondFactor: new BN(0), thirdFactor: new BN(0), baseFeeMode: 0 },
          dynamicFee: null,
        },
        activationType: 0, collectFeeMode: 0, migrationOption: 1, tokenType: 1, tokenDecimal: 6,
        migrationQuoteThreshold: new BN(LAMPORTS_PER_SOL * 500),
        partnerLiquidityPercentage: 0, creatorLiquidityPercentage: 0,
        partnerPermanentLockedLiquidityPercentage: 95, creatorPermanentLockedLiquidityPercentage: 5,
        sqrtStartPrice: MIN_SQRT_PRICE.shln(32),
        lockedVesting: { amountPerPeriod: new BN(0), cliffDurationFromMigrationTime: new BN(0), frequency: new BN(0), numberOfPeriod: new BN(0), cliffUnlockAmount: new BN(0) },
        migrationFeeOption: 0, tokenSupply: null, creatorTradingFeePercentage: 0, tokenUpdateAuthority: 0,
        migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
        migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 0 },
        creatorLiquidityVestingInfo: { vestingPercentage: 0, cliffDurationFromMigrationTime: 0, bpsPerPeriod: 0, numberOfPeriods: 0, frequency: 0 },
        partnerLiquidityVestingInfo: { vestingPercentage: 0, cliffDurationFromMigrationTime: 0, bpsPerPeriod: 0, numberOfPeriods: 0, frequency: 0 },
        poolCreationFee: new BN(0), enableFirstSwapWithMinFee: false, compoundingFeeBps: 0, migratedPoolBaseFeeMode: 0,
        migratedPoolMarketCapFeeSchedulerParams: { numberOfPeriod: 0, sqrtPriceStepBps: 0, schedulerExpirationDuration: 0, reductionFactor: new BN(0) },
        padding: new Array(2).fill(0),
        curve: curves,
      } as any)
      .accountsPartial({
        config: configKP.publicKey, feeClaimer: admin.publicKey, leftoverReceiver: admin.publicKey,
        quoteMint, payer: admin.publicKey, systemProgram: SystemProgram.programId,
      })
      .transaction();
    await sendAndConfirmTransaction(connection, createConfigTx, [admin, configKP]);

    // 4. Create pool (skip-launch-auth is on, so no Ed25519 needed for creation)
    const baseMintKP = Keypair.generate();
    baseMint = baseMintKP.publicKey;
    pool = derivePool(config, baseMint, quoteMint);
    const baseVault = deriveTokenVault(baseMint, pool);
    const quoteVault = deriveTokenVault(quoteMint, pool);

    const createPoolTx = await program.methods
      .initializeVirtualPoolWithToken2022({ name: "Trade Test", symbol: "TRADE", uri: "https://example.com" })
      .accountsPartial({
        config, baseMint, quoteMint, pool,
        payer: admin.publicKey, creator: admin.publicKey, poolAuthority: derivePoolAuthority(),
        baseVault, quoteVault,
        tokenQuoteProgram: TOKEN_PROGRAM_ID, tokenProgram: TOKEN_2022_PROGRAM_ID,
        ipworldHookProgram: HOOK_PROGRAM_ID,
        hookConfig: deriveHookConfig(baseMint),
        extraAccountMetaList: deriveExtraAccountMetaList(baseMint),
        ipworldState, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .transaction();
    createPoolTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    await sendAndConfirmTransaction(connection, createPoolTx, [admin, baseMintKP]);
  });

  // Helper: build swap instruction
  async function buildSwapIx(payer: Keypair): Promise<TransactionInstruction> {
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");

    return await program.methods
      .swap2({ amount0: new BN(LAMPORTS_PER_SOL * 0.01), amount1: new BN(0), swapMode: 1 }) // PartialFill = 1
      .accountsPartial({
        poolAuthority: derivePoolAuthority(),
        config, pool,
        inputTokenAccount: getAssociatedTokenAddressSync(quoteMint, payer.publicKey),
        outputTokenAccount: getAssociatedTokenAddressSync(baseMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID),
        baseVault: deriveTokenVault(baseMint, pool),
        quoteVault: deriveTokenVault(quoteMint, pool),
        baseMint, quoteMint,
        payer: payer.publicKey,
        tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: null,
        ipworldState,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts([
        { isSigner: false, isWritable: false, pubkey: SYSVAR_INSTRUCTIONS_PUBKEY },
        { isSigner: false, isWritable: false, pubkey: HOOK_PROGRAM_ID },
        { isSigner: false, isWritable: false, pubkey: deriveExtraAccountMetaList(baseMint) },
        { isSigner: false, isWritable: false, pubkey: deriveHookConfig(baseMint) },
      ])
      .instruction();
  }

  it("❌ Swap WITHOUT Ed25519 ix fails (MissingEd25519Ix)", async () => {
    // Create token accounts for trader first
    const { createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    
    const quoteAta = getAssociatedTokenAddressSync(quoteMint, trader.publicKey);
    const baseAta = getAssociatedTokenAddressSync(baseMint, trader.publicKey, false, TOKEN_2022_PROGRAM_ID);
    
    const setupTx = new Transaction();
    setupTx.add(
      createAssociatedTokenAccountInstruction(trader.publicKey, quoteAta, trader.publicKey, quoteMint),
      createAssociatedTokenAccountInstruction(trader.publicKey, baseAta, trader.publicKey, baseMint, TOKEN_2022_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: trader.publicKey, toPubkey: quoteAta, lamports: LAMPORTS_PER_SOL * 0.1 }),
    );

    // SyncNative to wrap SOL
    const { createSyncNativeInstruction } = await import("@solana/spl-token");
    setupTx.add(createSyncNativeInstruction(quoteAta));

    await sendAndConfirmTransaction(connection, setupTx, [trader]);

    const swapIx = await buildSwapIx(trader);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      swapIx
    );

    try {
      await sendAndConfirmTransaction(connection, tx, [trader]);
      expect.fail("Should have thrown — no Ed25519 ix");
    } catch (e: any) {
      const logs = e.logs?.join("\n") || e.message || "";
      expect(logs).to.match(/MissingEd25519Ix|custom program error/);
    }
  });

  it("❌ Swap with EXPIRED TradeAuth fails (TradeAuthExpired)", async () => {
    // Sign with correct authority but expired timestamp
    const expiredAt = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const tradeAuthMsg = serializeTradeAuth(trader.publicKey, expiredAt);
    const sig = nacl.sign.detached(tradeAuthMsg, authority.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: authority.publicKey.toBytes(),
      message: tradeAuthMsg,
      signature: Buffer.from(sig),
    });

    const swapIx = await buildSwapIx(trader);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ed25519Ix,
      swapIx
    );

    try {
      await sendAndConfirmTransaction(connection, tx, [trader]);
      expect.fail("Should have thrown — expired auth");
    } catch (e: any) {
      const logs = e.logs?.join("\n") || e.message || "";
      expect(logs).to.match(/TradeAuthExpired|custom program error/);
    }
  });

  it("✅ Swap with valid TradeAuth succeeds", async () => {
    // Sign with correct authority, expires 1 hour from now
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const tradeAuthMsg = serializeTradeAuth(trader.publicKey, expiresAt);
    const sig = nacl.sign.detached(tradeAuthMsg, authority.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: authority.publicKey.toBytes(),
      message: tradeAuthMsg,
      signature: Buffer.from(sig),
    });

    const swapIx = await buildSwapIx(trader);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ed25519Ix,
      swapIx
    );

    await sendAndConfirmTransaction(connection, tx, [trader]);
    // If we got here without error, the swap succeeded through trade auth
  });
});
