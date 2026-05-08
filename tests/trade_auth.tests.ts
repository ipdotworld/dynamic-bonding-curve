/**
 * Step 7 — Trade Auth enforcement tests (LiteSVM)
 *
 * Proves swaps require a valid Ed25519 TradeAuth signature.
 * Built with --features local,skip-launch-auth (trade auth enforced).
 *
 * Prerequisites:
 *   cargo build-sbf -- --features local,skip-launch-auth
 *   npx ts-mocha -t 120000 tests/trade_auth.tests.ts
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { LiteSVM } from "litesvm";
import {
  createVirtualCurveProgram,
  generateAndFund,
  startSvm,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  U64_MAX,
} from "./utils";
import { getSvmAuthority } from "./utils/svm";
import { sendTransactionMaybeThrow } from "./utils/common";
import { buildEd25519Ix, serializeLaunchAuth, serializeTradeAuth } from "./utils/ed25519";
import {
  deriveIpworldStateAddress,
  derivePoolAddress,
  deriveTokenVaultAddress,
  derivePoolAuthority,
  deriveHookConfigAddress,
  deriveExtraAccountMetaListAddress,
} from "./utils/accounts";
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  IPWORLD_HOOK_PROGRAM_ID,
} from "./utils/constants";
import { VirtualCurveProgram } from "./utils/types";

describe("Step 7 — Trade Auth enforcement", () => {
  let svm: LiteSVM;
  let admin: Keypair;
  let trader: Keypair;
  let wrongSigner: Keypair;
  let config: PublicKey;
  let pool: PublicKey;
  let baseMint: PublicKey;
  let ipworldState: PublicKey;
  let program: VirtualCurveProgram;
  const quoteMint = NATIVE_MINT;

  before(async () => {
    svm = startSvm();
    admin = generateAndFund(svm);
    trader = generateAndFund(svm);
    wrongSigner = generateAndFund(svm);
    program = createVirtualCurveProgram();

    ipworldState = deriveIpworldStateAddress();

    // Create operator
    const operatorPDA = PublicKey.findProgramAddressSync(
      [Buffer.from("operator"), admin.publicKey.toBuffer()],
      DYNAMIC_BONDING_CURVE_PROGRAM_ID
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
    sendTransactionMaybeThrow(svm, createOpTx, [admin]);

    // Create config
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
        curve: curves,
      } as any)
      .accountsPartial({
        config: configKP.publicKey,
        feeClaimer: admin.publicKey,
        quoteMint,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, createConfigTx, [admin, configKP]);

    // Create pool (skip-launch-auth is on, so no Ed25519 needed for creation)
    const baseMintKP = Keypair.generate();
    baseMint = baseMintKP.publicKey;
    pool = derivePoolAddress(config, baseMint, quoteMint);
    const baseVault = deriveTokenVaultAddress(baseMint, pool);
    const quoteVault = deriveTokenVaultAddress(quoteMint, pool);

    const authority = getSvmAuthority();
    const launchAuthMsg = serializeLaunchAuth(admin.publicKey, config, pool);
    const ed25519LaunchIx = buildEd25519Ix(authority, launchAuthMsg);

    const createPoolIx = await program.methods
      .initializeVirtualPoolWithToken2022({ name: "Trade Test", symbol: "TRADE", uri: "https://example.com" })
      .accountsPartial({
        config,
        baseMint,
        quoteMint,
        pool,
        payer: admin.publicKey,
        creator: admin.publicKey,
        poolAuthority: derivePoolAuthority(),
        baseVault,
        quoteVault,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        ipworldHookProgram: IPWORLD_HOOK_PROGRAM_ID,
        hookConfig: deriveHookConfigAddress(baseMint),
        extraAccountMetaList: deriveExtraAccountMetaListAddress(baseMint),
        ipworldState,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    const createPoolTx = new Transaction().add(
      ed25519LaunchIx,
      createPoolIx,
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    );
    sendTransactionMaybeThrow(svm, createPoolTx, [admin, baseMintKP]);

    // Setup trader's token accounts and wrap SOL
    const quoteAta = getAssociatedTokenAddressSync(quoteMint, trader.publicKey);
    const baseAta = getAssociatedTokenAddressSync(baseMint, trader.publicKey, false, TOKEN_2022_PROGRAM_ID);

    const setupTx = new Transaction();
    setupTx.add(
      createAssociatedTokenAccountInstruction(trader.publicKey, quoteAta, trader.publicKey, quoteMint),
      createAssociatedTokenAccountInstruction(trader.publicKey, baseAta, trader.publicKey, baseMint, TOKEN_2022_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: trader.publicKey, toPubkey: quoteAta, lamports: LAMPORTS_PER_SOL * 0.1 }),
      createSyncNativeInstruction(quoteAta)
    );
    sendTransactionMaybeThrow(svm, setupTx, [trader]);
  });

  async function buildSwapIx(payer: Keypair): Promise<import("@solana/web3.js").TransactionInstruction> {
    return await program.methods
      .swap2({ amount0: new BN(LAMPORTS_PER_SOL * 0.01), amount1: new BN(0), swapMode: 1 })
      .accountsPartial({
        poolAuthority: derivePoolAuthority(),
        config,
        pool,
        inputTokenAccount: getAssociatedTokenAddressSync(quoteMint, payer.publicKey),
        outputTokenAccount: getAssociatedTokenAddressSync(baseMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID),
        baseVault: deriveTokenVaultAddress(baseMint, pool),
        quoteVault: deriveTokenVaultAddress(quoteMint, pool),
        baseMint,
        quoteMint,
        payer: payer.publicKey,
        tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: null,
        ipworldState,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts([
        { isSigner: false, isWritable: false, pubkey: SYSVAR_INSTRUCTIONS_PUBKEY },
        { isSigner: false, isWritable: false, pubkey: IPWORLD_HOOK_PROGRAM_ID },
        { isSigner: false, isWritable: false, pubkey: deriveExtraAccountMetaListAddress(baseMint) },
        { isSigner: false, isWritable: false, pubkey: deriveHookConfigAddress(baseMint) },
      ])
      .instruction();
  }

  it("Swap WITHOUT Ed25519 ix fails (MissingEd25519Ix)", async () => {
    const swapIx = await buildSwapIx(trader);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      swapIx
    );

    let failed = false;
    try {
      sendTransactionMaybeThrow(svm, tx, [trader]);
    } catch (e: any) {
      failed = true;
      expect(e.message).to.match(/MissingEd25519Ix|custom program error/);
    }
    expect(failed, "Should have thrown — no Ed25519 ix").to.be.true;
  });

  it("Swap with EXPIRED TradeAuth fails (TradeAuthExpired)", async () => {
    const authority = getSvmAuthority();
    const expiredAt = 0; // epoch 0 — always expired regardless of LiteSVM clock
    const tradeAuthMsg = serializeTradeAuth(trader.publicKey, expiredAt);
    const ed25519Ix = buildEd25519Ix(authority, tradeAuthMsg);

    const swapIx = await buildSwapIx(trader);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ed25519Ix,
      swapIx
    );

    let failed = false;
    try {
      sendTransactionMaybeThrow(svm, tx, [trader]);
    } catch (e: any) {
      failed = true;
      expect(e.message).to.match(/TradeAuthExpired|custom program error/);
    }
    expect(failed, "Should have thrown — expired auth").to.be.true;
  });

  it("Swap with valid TradeAuth succeeds", async () => {
    const authority = getSvmAuthority();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const tradeAuthMsg = serializeTradeAuth(trader.publicKey, expiresAt);
    const ed25519Ix = buildEd25519Ix(authority, tradeAuthMsg);

    const swapIx = await buildSwapIx(trader);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ed25519Ix,
      swapIx
    );

    sendTransactionMaybeThrow(svm, tx, [trader]);
  });
});
