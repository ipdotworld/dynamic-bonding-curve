/**
 * SPEC-DBC-AUDIT-001 — referral validation on swap (REQ-A-003 / REQ-A-009) (LiteSVM)
 *
 * The referral fee may only be paid to the on-chain-registered referral wallet
 * (TokenVerification.referral for the pool). The swap reads the stored referral and
 * requires the supplied `referral_token_account` to be OWNED by it, else reverts with
 * InvalidReferralAccount. The referral is paid ONLY on the quote side
 * (`!fee_mode.fees_on_base_token`): with collectFeeMode = OutputToken(1), that is a
 * SELL (BaseToQuote). A BUY (QuoteToBase) has fees_on_base_token = true → the referral
 * branch is skipped entirely (no referral transfer), which also closes the former
 * REQ-A-009 base-side double-spend.
 *
 * Coverage:
 *   - SELL with a referral_token_account NOT owned by the stored referral → reverts
 *     (InvalidReferralAccount).
 *   - SELL with the correct stored referral → the referral wallet's quote ATA is paid.
 *   - BUY → produces no referral transfer (the referral wallet balance is unchanged).
 *
 * Referral fee math (config.rs): referral_fee = trading_fee * PROTOCOL_FEE_PERCENT(20%)
 *   * HOST_FEE_PERCENT(20%) = trading_fee * 4%, only when has_referral. So a sizeable
 *   SELL yields a small but strictly positive referral payout.
 *
 * Build: anchor build -p dynamic_bonding_curve -- --features local
 * Run:   yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/swap_referral_validation.tests.ts
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  AccountLayout as TokenAccountLayout,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { FailedTransactionMetadata } from "litesvm";
import { BN } from "@coral-xyz/anchor";
import { LiteSVM } from "litesvm";

import {
  BaseFee,
  ConfigParameters,
  createConfig,
  createOperatorAccount,
  createPoolWithToken2022,
  swap,
  SwapMode,
  OperatorPermission,
} from "./instructions";
import {
  createVirtualCurveProgram,
  generateAndFund,
  sendTransactionMaybeThrow,
  startSvm,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  U64_MAX,
} from "./utils";
import {
  deriveOperatorAddress,
  deriveTokenVerificationAddress,
} from "./utils/accounts";
import { getVirtualPool, getTokenVerification } from "./utils/fetcher";
import { VirtualCurveProgram } from "./utils/types";

const INVALID_REFERRAL = "InvalidReferralAccount";

function referralConfig(): ConfigParameters {
  const baseFee: BaseFee = {
    // 1% cliff fee → larger trading_fee → a clearly-positive referral payout.
    cliffFeeNumerator: new BN(10_000_000),
    firstFactor: 0,
    secondFactor: new BN(0),
    thirdFactor: new BN(0),
    baseFeeMode: 0,
  };
  const curve = [];
  for (let i = 1; i <= 16; i++) {
    curve.push({
      sqrtPrice: i === 16 ? MAX_SQRT_PRICE : MAX_SQRT_PRICE.muln(i * 5).divn(100),
      liquidity: U64_MAX.shln(30 + i),
    });
  }
  return {
    poolFees: { baseFee, dynamicFee: null },
    activationType: 0,
    collectFeeMode: 1, // OutputToken → SELL(BaseToQuote) pays a quote-side referral; BUY does not.
    migrationOption: 1,
    tokenType: 1,
    tokenDecimal: 6,
    migrationQuoteThreshold: new BN(LAMPORTS_PER_SOL * 5),
    partnerLiquidityPercentage: 20,
    creatorLiquidityPercentage: 20,
    partnerPermanentLockedLiquidityPercentage: 55,
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
    migratedPoolFee: { collectFeeMode: 1, dynamicFee: 0, poolFeeBps: 0 },
    creatorLiquidityVestingInfo: { vestingPercentage: 0, cliffDurationFromMigrationTime: 0, bpsPerPeriod: 0, numberOfPeriods: 0, frequency: 0 },
    partnerLiquidityVestingInfo: { vestingPercentage: 0, cliffDurationFromMigrationTime: 0, bpsPerPeriod: 0, numberOfPeriods: 0, frequency: 0 },
    poolCreationFee: new BN(0),
    curve,
    enableFirstSwapWithMinFee: false,
    compoundingFeeBps: 0,
    migratedPoolBaseFeeMode: 0,
    migratedPoolMarketCapFeeSchedulerParams: null,
  };
}

describe("SPEC-DBC-AUDIT-001 — referral validation + BUY-no-referral (REQ-A-003 / REQ-A-009)", () => {
  let svm: LiteSVM;
  let program: VirtualCurveProgram;
  let admin: Keypair;
  let partner: Keypair;
  let poolCreator: Keypair;
  let verifyOperator: Keypair;
  let trader: Keypair;
  let referralWallet: Keypair; // the on-chain-registered referral
  let attackerReferral: Keypair; // an UNREGISTERED wallet
  let ipOwner: Keypair;

  let config: PublicKey;
  let pool: PublicKey;
  let baseMint: PublicKey;
  let tvAddr: PublicKey;

  before(async () => {
    svm = startSvm();
    program = createVirtualCurveProgram();
    admin = generateAndFund(svm);
    partner = generateAndFund(svm);
    poolCreator = generateAndFund(svm);
    verifyOperator = generateAndFund(svm);
    trader = generateAndFund(svm);
    referralWallet = generateAndFund(svm);
    attackerReferral = generateAndFund(svm);
    ipOwner = generateAndFund(svm);

    await createOperatorAccount(svm, program, {
      admin,
      whitelistedAddress: verifyOperator.publicKey,
      permissions: [OperatorPermission.VerifyToken],
    });

    config = await createConfig(svm, program, {
      payer: partner,
      feeClaimer: partner.publicKey,
      quoteMint: NATIVE_MINT,
      instructionParams: referralConfig(),
    });
    pool = await createPoolWithToken2022(svm, program, {
      poolCreator,
      payer: poolCreator,
      quoteMint: NATIVE_MINT,
      config,
      instructionParams: { name: "Ref Token", symbol: "REF", uri: "x" },
    });
    baseMint = getVirtualPool(svm, program, pool).baseMint;
    tvAddr = deriveTokenVerificationAddress(pool);

    // verify_token (ip_owner = ipOwner), then set_referral + accept_referral so the
    // pool's stored referral == referralWallet.
    const vtx = await program.methods
      .verifyToken(ipOwner.publicKey)
      .accountsPartial({
        payer: verifyOperator.publicKey,
        tokenVerification: tvAddr,
        pool,
        operator: deriveOperatorAddress(verifyOperator.publicKey),
        signer: verifyOperator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, vtx, [verifyOperator]);

    const stx = await program.methods
      .setReferral(referralWallet.publicKey)
      .accountsPartial({
        tokenVerification: tvAddr,
        pool,
        operator: deriveOperatorAddress(verifyOperator.publicKey),
        signer: verifyOperator.publicKey,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, stx, [verifyOperator]);

    const atx = await program.methods
      .acceptReferral()
      .accountsPartial({
        ipOwner: ipOwner.publicKey,
        tokenVerification: tvAddr,
        pool,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, atx, [ipOwner]);

    // Confirm the stored referral.
    expect(
      getTokenVerification(svm, program, tvAddr).referral.toBase58()
    ).to.equal(referralWallet.publicKey.toBase58());

    // The trader needs base tokens to SELL. At the START of the curve the price is
    // lowest, so even a modest SOL buy can exceed 5% of supply and trip the holding
    // cap. We first WARM UP the curve with several distinct buyers (each individually
    // under 5%, the cap-aware pattern), which raises the price; then a single small
    // trader buy at the higher price stays comfortably under 5% while still giving
    // the trader enough base inventory to produce a positive referral fee on sale.
    for (let i = 0; i < 12; i++) {
      const warmer = generateAndFund(svm);
      await swap(svm, program, {
        config,
        payer: warmer,
        pool,
        inputTokenMint: NATIVE_MINT,
        outputTokenMint: baseMint,
        amountIn: new BN(Math.floor(LAMPORTS_PER_SOL * 0.1)),
        minimumAmountOut: new BN(0),
        swapMode: SwapMode.PartialFill,
        referralTokenAccount: null,
      });
    }
    // Trader's own buy at the (now higher) price.
    await swap(svm, program, {
      config,
      payer: trader,
      pool,
      inputTokenMint: NATIVE_MINT,
      outputTokenMint: baseMint,
      amountIn: new BN(Math.floor(LAMPORTS_PER_SOL * 0.1)),
      minimumAmountOut: new BN(0),
      swapMode: SwapMode.PartialFill,
      referralTokenAccount: null,
    });
  });

  it("NEGATIVE: a SELL with a referral_token_account NOT owned by the stored referral reverts (InvalidReferralAccount)", async () => {
    // Quote ATA owned by the UNREGISTERED attacker wallet.
    const badReferralAta = createQuoteAta(svm, trader, attackerReferral.publicKey);

    const traderBaseAta = getAssociatedTokenAddressSync(baseMint, trader.publicKey, true, TOKEN_2022_PROGRAM_ID);
    const sellAmount = new BN(readAmount(svm, traderBaseAta).toString()).divn(4); // sell 1/4 of holdings

    let threw = false;
    try {
      await swap(svm, program, {
        config,
        payer: trader,
        pool,
        inputTokenMint: baseMint, // SELL: base -> quote
        outputTokenMint: NATIVE_MINT,
        amountIn: sellAmount,
        minimumAmountOut: new BN(0),
        swapMode: SwapMode.PartialFill,
        referralTokenAccount: badReferralAta, // wrong owner
      });
    } catch (e: any) {
      threw = true;
      expect(
        String(e.message).includes(INVALID_REFERRAL),
        "expected InvalidReferralAccount, got:\n" + String(e.message).slice(-500)
      ).to.equal(true);
    }
    expect(threw, "SELL with mismatched referral must revert").to.equal(true);
  });

  it("POSITIVE: a SELL with the correct stored referral pays the referral wallet's quote ATA", async () => {
    const goodReferralAta = createQuoteAta(svm, trader, referralWallet.publicKey); // the REGISTERED referral
    const before = readAmount(svm, goodReferralAta);

    const traderBaseAta = getAssociatedTokenAddressSync(baseMint, trader.publicKey, true, TOKEN_2022_PROGRAM_ID);
    const sellAmount = new BN(readAmount(svm, traderBaseAta).toString()).divn(2); // sell half

    await swap(svm, program, {
      config,
      payer: trader,
      pool,
      inputTokenMint: baseMint, // SELL
      outputTokenMint: NATIVE_MINT,
      amountIn: sellAmount,
      minimumAmountOut: new BN(0),
      swapMode: SwapMode.PartialFill,
      referralTokenAccount: goodReferralAta,
    });

    const after = readAmount(svm, goodReferralAta);
    // referral_fee = trading_fee * 20% * 20% > 0 for a sizeable sell at a 1% fee.
    // (chai .greaterThan rejects BigInt, so compare the delta explicitly.)
    const paid = after - before;
    expect(paid > 0n, `referral wallet must be paid (paid=${paid})`).to.equal(true);
  });

  it("BUY produces NO referral transfer (referral branch skipped: BUY has fees_on_base_token=true)", async () => {
    const buyer = generateAndFund(svm);
    // referral ATA balance before a referral-less BUY.
    const goodReferralAta = getAssociatedTokenAddressSync(NATIVE_MINT, referralWallet.publicKey, true, TOKEN_PROGRAM_ID);
    const before = readAmount(svm, goodReferralAta);

    // A BUY with NO referral_token_account (the correct client behavior on a BUY).
    await swap(svm, program, {
      config,
      payer: buyer,
      pool,
      inputTokenMint: NATIVE_MINT, // BUY: quote -> base
      outputTokenMint: baseMint,
      amountIn: new BN(LAMPORTS_PER_SOL * 0.1),
      minimumAmountOut: new BN(0),
      swapMode: SwapMode.PartialFill,
      referralTokenAccount: null,
    });

    // The referral wallet was not paid by the BUY.
    expect(readAmount(svm, goodReferralAta)).to.equal(before);
  });
});

/** Create (idempotently) a classic-SPL quote (NATIVE_MINT) ATA for `owner`. */
function createQuoteAta(svm: LiteSVM, payer: Keypair, owner: PublicKey): PublicKey {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true, TOKEN_PROGRAM_ID);
  if (svm.getAccount(ata)) return ata;
  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, NATIVE_MINT, TOKEN_PROGRAM_ID)
  );
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(payer);
  const r = svm.sendTransaction(tx);
  if (r instanceof FailedTransactionMetadata) throw new Error("quote ata create failed: " + r.meta().logs().join("\n"));
  svm.expireBlockhash();
  return ata;
}

/** Read a token account's amount; returns 0n if the account does not exist yet. */
function readAmount(svm: LiteSVM, tokenAccount: PublicKey): bigint {
  const acct = svm.getAccount(tokenAccount);
  if (!acct) return 0n;
  return BigInt(TokenAccountLayout.decode(Buffer.from(acct.data)).amount.toString());
}
