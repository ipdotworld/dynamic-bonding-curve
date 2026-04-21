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

describe.skip("T-05: TradeAuth Buy/Sell Asymmetry", () => {
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
    admin = Keypair.generate();
    authority = Keypair.generate();
    trader = Keypair.generate();

    await airdrop(admin.publicKey, 50);
    await airdrop(trader.publicKey, 50);

    // Anchor program client
    const wallet = new Wallet(admin);
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    program = new Program<VirtualCurve>(VirtualCurveIDL as VirtualCurve, provider);

    // 1. Init IpworldState with our authority
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

    // 2. Create operator (--features local bypasses admin check)
    const operatorPDA = PublicKey.findProgramAddressSync(
      [Buffer.from("operator"), admin.publicKey.toBuffer()],
      DBC_PROGRAM_ID
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

    // 3. Create config
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
          baseFee: {
            cliffFeeNumerator: new BN(2_500_000),
            firstFactor: 0,
            secondFactor: new BN(0),
            thirdFactor: new BN(0),
            baseFeeMode: 0,
          },
          dynamicFee: null,
        },
        activationType: 0,
        collectFeeMode: 1,
        migrationOption: 1,
        tokenType: 1,
        tokenDecimal: 6,
        migrationQuoteThreshold: new BN(LAMPORTS_PER_SOL * 500),
        partnerLiquidityPercentage: 0,
        creatorLiquidityPercentage: 0,
        partnerPermanentLockedLiquidityPercentage: 95,
        creatorPermanentLockedLiquidityPercentage: 5,
        sqrtStartPrice: MIN_SQRT_PRICE.shln(32),
        lockedVesting: {
          amountPerPeriod: new BN(0),
          cliffDurationFromMigrationTime: new BN(0),
          frequency: new BN(0),
          numberOfPeriod: new BN(0),
          cliffUnlockAmount: new BN(0),
        },
        migrationFeeOption: 0,
        tokenSupply: null,
        creatorTradingFeePercentage: 0,
        tokenUpdateAuthority: 0,
        migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
        migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 0 },
        creatorLiquidityVestingInfo: {
          vestingPercentage: 0,
          cliffDurationFromMigrationTime: 0,
          bpsPerPeriod: 0,
          numberOfPeriods: 0,
          frequency: 0,
        },
        partnerLiquidityVestingInfo: {
          vestingPercentage: 0,
          cliffDurationFromMigrationTime: 0,
          bpsPerPeriod: 0,
          numberOfPeriods: 0,
          frequency: 0,
        },
        poolCreationFee: new BN(0),
        enableFirstSwapWithMinFee: false,
        compoundingFeeBps: 0,
        migratedPoolBaseFeeMode: 0,
        migratedPoolMarketCapFeeSchedulerParams: {
          numberOfPeriod: 0,
          sqrtPriceStepBps: 0,
          schedulerExpirationDuration: 0,
          reductionFactor: new BN(0),
        },
        padding: new Array(2).fill(0),
        ipOwnerShare: 50000,
        airdropShare: 30000,
        referralShare: 20000,
        creatorShare: 100000,
        tokenAirdropShare: 50000,
        curve: curves,
      } as any)
      .accountsPartial({
        config: configKP.publicKey,
        feeClaimer: admin.publicKey,
        leftoverReceiver: admin.publicKey,
        quoteMint,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    await sendAndConfirmTransaction(connection, createConfigTx, [admin, configKP]);

    // 4. Create pool (skip-launch-auth is on, so no Ed25519 needed)
    baseMint = Keypair.generate();
    pool = derivePool(config, baseMint.publicKey, quoteMint);
    const baseVault = deriveTokenVault(baseMint.publicKey, pool);
    const quoteVault = deriveTokenVault(quoteMint, pool);

    const createPoolTx = await program.methods
      .initializeVirtualPoolWithToken2022({
        name: "Trade Test",
        symbol: "TRADE",
        uri: "https://example.com",
      })
      .accountsPartial({
        config,
        baseMint: baseMint.publicKey,
        quoteMint,
        pool,
        payer: admin.publicKey,
        creator: admin.publicKey,
        poolAuthority: derivePoolAuthority(),
        baseVault,
        quoteVault,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        ipworldHookProgram: HOOK_PROGRAM_ID,
        hookConfig: deriveHookConfig(baseMint.publicKey),
        extraAccountMetaList: deriveExtraAccountMetaList(baseMint.publicKey),
        ipworldState,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .transaction();
    createPoolTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    await sendAndConfirmTransaction(connection, createPoolTx, [admin, baseMint]);

    // 5. Setup trader's token accounts and wrap SOL
    const quoteAta = getAssociatedTokenAddressSync(quoteMint, trader.publicKey);
    const baseAta = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      trader.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    const setupTx = new Transaction();
    setupTx.add(
      createAssociatedTokenAccountInstruction(
        trader.publicKey,
        quoteAta,
        trader.publicKey,
        quoteMint
      ),
      createAssociatedTokenAccountInstruction(
        trader.publicKey,
        baseAta,
        trader.publicKey,
        baseMint.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      SystemProgram.transfer({
        fromPubkey: trader.publicKey,
        toPubkey: quoteAta,
        lamports: LAMPORTS_PER_SOL * 5,
      }),
      createSyncNativeInstruction(quoteAta)
    );
    await sendAndConfirmTransaction(connection, setupTx, [trader]);
  });

  async function buildBuyIx(buyer: Keypair): Promise<TransactionInstruction> {
    // Build swap instruction for QuoteToBase (SOL → token) — requires TradeAuth
    return await program.methods
      .swap2({ amount0: new BN(LAMPORTS_PER_SOL * 0.01), amount1: new BN(0), swapMode: 1 })
      .accountsPartial({
        poolAuthority: derivePoolAuthority(),
        config,
        pool,
        inputTokenAccount: getAssociatedTokenAddressSync(quoteMint, buyer.publicKey),
        outputTokenAccount: getAssociatedTokenAddressSync(
          baseMint.publicKey,
          buyer.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        ),
        baseVault: deriveTokenVault(baseMint.publicKey, pool),
        quoteVault: deriveTokenVault(quoteMint, pool),
        baseMint: baseMint.publicKey,
        quoteMint,
        payer: buyer.publicKey,
        tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: null,
        ipworldState,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts([
        { isSigner: false, isWritable: false, pubkey: SYSVAR_INSTRUCTIONS_PUBKEY },
        { isSigner: false, isWritable: false, pubkey: HOOK_PROGRAM_ID },
        { isSigner: false, isWritable: false, pubkey: deriveExtraAccountMetaList(baseMint.publicKey) },
        { isSigner: false, isWritable: false, pubkey: deriveHookConfig(baseMint.publicKey) },
      ])
      .instruction();
  }

  async function buildSellIx(seller: Keypair, tokenAmount: BN): Promise<TransactionInstruction> {
    // Build swap instruction for BaseToQuote (token → SOL) — no TradeAuth required
    return await program.methods
      .swap2({ amount0: tokenAmount, amount1: new BN(0), swapMode: 1 })
      .accountsPartial({
        poolAuthority: derivePoolAuthority(),
        config,
        pool,
        inputTokenAccount: getAssociatedTokenAddressSync(
          baseMint.publicKey,
          seller.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        ),
        outputTokenAccount: getAssociatedTokenAddressSync(quoteMint, seller.publicKey),
        baseVault: deriveTokenVault(baseMint.publicKey, pool),
        quoteVault: deriveTokenVault(quoteMint, pool),
        baseMint: baseMint.publicKey,
        quoteMint,
        payer: seller.publicKey,
        tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: null,
        ipworldState,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts([
        { isSigner: false, isWritable: false, pubkey: SYSVAR_INSTRUCTIONS_PUBKEY },
        { isSigner: false, isWritable: false, pubkey: HOOK_PROGRAM_ID },
        { isSigner: false, isWritable: false, pubkey: deriveExtraAccountMetaList(baseMint.publicKey) },
        { isSigner: false, isWritable: false, pubkey: deriveHookConfig(baseMint.publicKey) },
      ])
      .instruction();
  }

  it("M-AUTH-001: Buy (QuoteToBase) requires TradeAuth", async () => {
    const buyIx = await buildBuyIx(trader);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      buyIx
    );

    try {
      await sendAndConfirmTransaction(connection, tx, [trader]);
      expect.fail("Should have thrown — no Ed25519 ix");
    } catch (e: any) {
      const logs = e.logs?.join("\n") || e.message || "";
      expect(logs).to.match(/MissingEd25519Ix|custom program error/);
    }
  });

  it("M-AUTH-002: Sell (BaseToQuote) succeeds without TradeAuth", async () => {
    // First, perform a valid buy to give trader some tokens
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const tradeAuthMsg = serializeTradeAuth(trader.publicKey, expiresAt);
    const validSig = nacl.sign.detached(tradeAuthMsg, authority.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: authority.publicKey.toBytes(),
      message: tradeAuthMsg,
      signature: Buffer.from(validSig),
    });

    const buyIx = await buildBuyIx(trader);
    const buyTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ed25519Ix,
      buyIx
    );
    await sendAndConfirmTransaction(connection, buyTx, [trader]);

    // Now sell without TradeAuth — sells (BaseToQuote) are always allowed
    const baseAta = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      trader.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const baseAtaInfo = await connection.getTokenAccountBalance(baseAta);
    const tokenBalance = new BN(baseAtaInfo.value.amount);

    // Use a small amount to avoid selling more than we have
    const sellAmount = tokenBalance.divn(2);
    const sellIx = await buildSellIx(trader, sellAmount);
    const sellTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      sellIx
    );

    // Expect no error — sells do not require TradeAuth
    await sendAndConfirmTransaction(connection, sellTx, [trader]);
  });

  it("M-AUTH-003: Expired TradeAuth rejected", async () => {
    // Sign with correct authority but expired timestamp (1 hour ago)
    const expiredAt = Math.floor(Date.now() / 1000) - 3600;
    const tradeAuthMsg = serializeTradeAuth(trader.publicKey, expiredAt);
    const sig = nacl.sign.detached(tradeAuthMsg, authority.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: authority.publicKey.toBytes(),
      message: tradeAuthMsg,
      signature: Buffer.from(sig),
    });

    const buyIx = await buildBuyIx(trader);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ed25519Ix,
      buyIx
    );

    try {
      await sendAndConfirmTransaction(connection, tx, [trader]);
      expect.fail("Should have thrown — expired auth");
    } catch (e: any) {
      const logs = e.logs?.join("\n") || e.message || "";
      expect(logs).to.match(/TradeAuthExpired|custom program error/);
    }
  });
});
