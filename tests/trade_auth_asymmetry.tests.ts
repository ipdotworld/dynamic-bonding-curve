/**
 * T-05: TradeAuth Buy/Sell Asymmetry Tests (LiteSVM)
 *
 * Verifies that TradeAuth is required for buys (QuoteToBase) but NOT for
 * sells (BaseToQuote), and that expired TradeAuth is rejected.
 *
 * Buy direction: SOL (quote) → token (base) = QuoteToBase
 * Sell direction: token (base) → SOL (quote) = BaseToQuote
 *
 * Prerequisites:
 *   cargo build-sbf -- --features local,skip-launch-auth
 *   npx ts-mocha -t 120000 tests/trade_auth_asymmetry.tests.ts
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
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

describe("T-05: TradeAuth Buy/Sell Asymmetry", () => {
  let svm: LiteSVM;
  let admin: Keypair;
  let trader: Keypair;
  let config: PublicKey;
  let pool: PublicKey;
  let baseMint: Keypair;
  let ipworldState: PublicKey;
  let program: VirtualCurveProgram;

  const quoteMint = NATIVE_MINT;

  before(async () => {
    svm = startSvm();
    admin = generateAndFund(svm);
    trader = generateAndFund(svm);
    program = createVirtualCurveProgram();

    ipworldState = deriveIpworldStateAddress();

    // Create operator (--features local bypasses admin check)
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
        leftoverReceiver: admin.publicKey,
        quoteMint,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, createConfigTx, [admin, configKP]);

    // Create pool with Ed25519 LaunchAuth
    baseMint = Keypair.generate();
    pool = derivePoolAddress(config, baseMint.publicKey, quoteMint);
    const baseVault = deriveTokenVaultAddress(baseMint.publicKey, pool);
    const quoteVault = deriveTokenVaultAddress(quoteMint, pool);

    const authority = getSvmAuthority();
    const launchAuthMsg = serializeLaunchAuth(admin.publicKey, config, pool);
    const ed25519LaunchIx = buildEd25519Ix(authority, launchAuthMsg);

    const createPoolIx = await program.methods
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
        ipworldHookProgram: IPWORLD_HOOK_PROGRAM_ID,
        hookConfig: deriveHookConfigAddress(baseMint.publicKey),
        extraAccountMetaList: deriveExtraAccountMetaListAddress(baseMint.publicKey),
        ipworldState,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    const createPoolTx = new Transaction().add(
      ed25519LaunchIx,
      createPoolIx,
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    );
    sendTransactionMaybeThrow(svm, createPoolTx, [admin, baseMint]);

    // Setup trader's token accounts and wrap SOL
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
    sendTransactionMaybeThrow(svm, setupTx, [trader]);
  });

  async function buildBuyIx(buyer: Keypair): Promise<import("@solana/web3.js").TransactionInstruction> {
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
        baseVault: deriveTokenVaultAddress(baseMint.publicKey, pool),
        quoteVault: deriveTokenVaultAddress(quoteMint, pool),
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
        { isSigner: false, isWritable: false, pubkey: IPWORLD_HOOK_PROGRAM_ID },
        { isSigner: false, isWritable: false, pubkey: deriveExtraAccountMetaListAddress(baseMint.publicKey) },
        { isSigner: false, isWritable: false, pubkey: deriveHookConfigAddress(baseMint.publicKey) },
      ])
      .instruction();
  }

  async function buildSellIx(seller: Keypair, tokenAmount: BN): Promise<import("@solana/web3.js").TransactionInstruction> {
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
        baseVault: deriveTokenVaultAddress(baseMint.publicKey, pool),
        quoteVault: deriveTokenVaultAddress(quoteMint, pool),
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
        { isSigner: false, isWritable: false, pubkey: IPWORLD_HOOK_PROGRAM_ID },
        { isSigner: false, isWritable: false, pubkey: deriveExtraAccountMetaListAddress(baseMint.publicKey) },
        { isSigner: false, isWritable: false, pubkey: deriveHookConfigAddress(baseMint.publicKey) },
      ])
      .instruction();
  }

  it("M-AUTH-001: Buy (QuoteToBase) requires TradeAuth", async () => {
    const buyIx = await buildBuyIx(trader);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      buyIx
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

  it("M-AUTH-002: Sell (BaseToQuote) succeeds without TradeAuth", async () => {
    const authority = getSvmAuthority();

    // First, perform a valid buy to give trader some tokens
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const tradeAuthMsg = serializeTradeAuth(trader.publicKey, expiresAt);
    const ed25519Ix = buildEd25519Ix(authority, tradeAuthMsg);

    const buyIx = await buildBuyIx(trader);
    const buyTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ed25519Ix,
      buyIx
    );
    sendTransactionMaybeThrow(svm, buyTx, [trader]);

    // Now sell without TradeAuth — sells (BaseToQuote) are always allowed
    const baseAta = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      trader.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const baseAtaAccount = svm.getAccount(baseAta);
    expect(baseAtaAccount).to.not.be.null;

    // Use a small fixed amount for sell
    const sellAmount = new BN(1000);
    const sellIx = await buildSellIx(trader, sellAmount);
    const sellTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      sellIx
    );

    // Expect no error — sells do not require TradeAuth
    sendTransactionMaybeThrow(svm, sellTx, [trader]);
  });

  it("M-AUTH-003: Expired TradeAuth rejected", async () => {
    const authority = getSvmAuthority();

    // Sign with correct authority but expired timestamp (epoch 0 — always expired)
    const expiredAt = 0;
    const tradeAuthMsg = serializeTradeAuth(trader.publicKey, expiredAt);
    const ed25519Ix = buildEd25519Ix(authority, tradeAuthMsg);

    const buyIx = await buildBuyIx(trader);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ed25519Ix,
      buyIx
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
});
