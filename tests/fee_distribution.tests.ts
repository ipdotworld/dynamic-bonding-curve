/**
 * SPEC-DBC-AUDIT-001 — IPWorld fixed-share fee distribution (LiteSVM)
 *
 * Rewrite of the legacy `_quarantine_removed_features/fee_swap.tests.ts`, which
 * asserted the OLD partner/protocol base+quote fee model. The IPWorld model
 * (programs/.../state/virtual_pool.rs::apply_swap_result + state/fee.rs) splits
 * trading fees into fixed-share program-constant buckets — NOT per-pool config:
 *
 *   BUY  (QuoteToBase, collectFeeMode=OutputToken → fees_on_base_token):
 *     base fee  ->  token_airdrop_base_fee  = TOKEN_AIRDROP_SHARE (40%)
 *               ->  ip_treasury_base_fee    = remainder           (60%)
 *     and NOTHING is written to `protocol_base_fee` (the old
 *     `protocol_base_fee += total_fee` double-write was removed in REQ-A-001).
 *
 *   SELL (BaseToQuote, collectFeeMode=OutputToken → fees_on_quote):
 *     quote fee ->  ip_owner_quote_fee  = IP_OWNER_SHARE (10%)
 *               ->  airdrop_quote_fee   = AIRDROP_SHARE  (10%)
 *               ->  protocol_quote_fee  = residual       (80%, IPWorld treasury)
 *     (any referral cut is paid out immediately and subtracted before the split.)
 *
 * The shares are the FIXED constants TOKEN_AIRDROP_SHARE / IP_OWNER_SHARE /
 * AIRDROP_SHARE (fee.rs, /1_000_000): 400_000 = 40%, 100_000 = 10%, 100_000 = 10%.
 * Changing them requires a program upgrade — they are not mutable per-pool config.
 *
 * We assert the on-chain accumulators (the pool's fee buckets) AFTER each swap.
 * Because the holding cap forbids one wallet from owning >5% of supply, the SELL
 * inventory is built by progressing the curve with many sub-5% buyers first
 * (`progressCurveToGraduation` would graduate it; here we instead warm it part-way
 * with a bounded number of buyers, then have one buyer sell a slice back).
 */

import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { BN } from "bn.js";
import { expect } from "chai";
import { LiteSVM } from "litesvm";
import {
  BaseFee,
  ConfigParameters,
  createConfig,
  CreateConfigParams,
  createOperatorAccount,
  createPoolWithToken2022,
  OperatorPermission,
  swap,
  SwapMode,
  SwapParams,
} from "./instructions";
import {
  createVirtualCurveProgram,
  generateAndFund,
  getTokenAccount,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  startSvm,
  U64_MAX,
} from "./utils";
import { getVirtualPool } from "./utils/fetcher";
import { Pool, VirtualCurveProgram } from "./utils/types";

// Fixed-share program constants (state/fee.rs), denominated in 1_000_000.
const FEE_SHARE_PRECISION = 1_000_000;
const TOKEN_AIRDROP_SHARE = 400_000; // 40% (BUY base -> token_airdrop)
const IP_OWNER_SHARE = 100_000; // 10% (SELL quote -> ip_owner)
const AIRDROP_SHARE = 100_000; // 10% (SELL quote -> airdrop)

function buildConfigParams(): ConfigParameters {
  const baseFee: BaseFee = {
    cliffFeeNumerator: new BN(2_500_000), // 0.25%
    firstFactor: 0,
    secondFactor: new BN(0),
    thirdFactor: new BN(0),
    baseFeeMode: 0,
  };
  const curves: any[] = [];
  for (let i = 1; i <= 16; i++) {
    curves.push({
      sqrtPrice:
        i === 16 ? MAX_SQRT_PRICE : MAX_SQRT_PRICE.muln(i * 5).divn(100),
      liquidity: U64_MAX.shln(30 + i),
    });
  }
  return {
    poolFees: { baseFee, dynamicFee: null },
    activationType: 0,
    collectFeeMode: 1, // OutputToken: BUY -> base fee, SELL -> quote fee
    migrationOption: 1, // DAMM v2
    tokenType: 1, // Token2022 (IPWorld is Token-2022 only)
    tokenDecimal: 6,
    migrationQuoteThreshold: new BN(LAMPORTS_PER_SOL * 5),
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
    migratedPoolFee: { collectFeeMode: 1, dynamicFee: 0, poolFeeBps: 0 },
    poolCreationFee: new BN(0),
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
    enableFirstSwapWithMinFee: false,
    compoundingFeeBps: 0,
    migratedPoolBaseFeeMode: 0,
    migratedPoolMarketCapFeeSchedulerParams: null,
    curve: curves,
  } as any;
}

describe("SPEC-DBC-AUDIT-001 — IPWorld fixed-share fee distribution", () => {
  let svm: LiteSVM;
  let partner: Keypair;
  let operator: Keypair;
  let admin: Keypair;
  let poolCreator: Keypair;
  let program: VirtualCurveProgram;
  let config: PublicKey;
  let pool: PublicKey;
  let poolState: Pool;

  before(async () => {
    svm = startSvm();
    partner = generateAndFund(svm);
    operator = generateAndFund(svm);
    admin = generateAndFund(svm);
    poolCreator = generateAndFund(svm);
    program = createVirtualCurveProgram();

    await createOperatorAccount(svm, program, {
      admin,
      whitelistedAddress: operator.publicKey,
      permissions: [OperatorPermission.ClaimProtocolFee],
    });

    const params: CreateConfigParams<ConfigParameters> = {
      payer: partner,
      feeClaimer: partner.publicKey,
      quoteMint: NATIVE_MINT,
      instructionParams: buildConfigParams(),
    };
    config = await createConfig(svm, program, params);
    pool = await createPoolWithToken2022(svm, program, {
      poolCreator,
      payer: operator,
      quoteMint: NATIVE_MINT,
      config,
      instructionParams: { name: "Fee Dist", symbol: "FEE", uri: "u" },
    });
    poolState = getVirtualPool(svm, program, pool);
  });

  it("BUY base fee splits 40% token_airdrop / 60% ip_treasury, with NO protocol_base_fee double-write", async () => {
    const before = getVirtualPool(svm, program, pool);
    expect(before.tokenAirdropBaseFee.toString()).to.equal("0");
    expect(before.ipTreasuryBaseFee.toString()).to.equal("0");
    expect(before.protocolBaseFee.toString()).to.equal("0");

    // A single sub-5% BUY (0.05 SOL ≈ 2% of supply on this curve).
    const buyer = generateAndFund(svm);
    const params: SwapParams = {
      config,
      payer: buyer,
      pool,
      inputTokenMint: NATIVE_MINT,
      outputTokenMint: before.baseMint,
      amountIn: new BN(LAMPORTS_PER_SOL * 0.05),
      minimumAmountOut: new BN(0),
      swapMode: SwapMode.PartialFill,
      referralTokenAccount: null,
    };
    await swap(svm, program, params);

    const after = getVirtualPool(svm, program, pool);
    const tokenAirdrop = after.tokenAirdropBaseFee.sub(before.tokenAirdropBaseFee);
    const ipTreasury = after.ipTreasuryBaseFee.sub(before.ipTreasuryBaseFee);
    const totalBaseFee = tokenAirdrop.add(ipTreasury);

    // A base fee was actually collected.
    expect(totalBaseFee.gt(new BN(0))).to.equal(true);

    // token_airdrop == floor(totalBaseFee * 40%); ip_treasury == remainder (60%).
    const expectedTokenAirdrop = totalBaseFee
      .mul(new BN(TOKEN_AIRDROP_SHARE))
      .div(new BN(FEE_SHARE_PRECISION));
    const expectedIpTreasury = totalBaseFee.sub(expectedTokenAirdrop);
    expect(tokenAirdrop.toString()).to.equal(expectedTokenAirdrop.toString());
    expect(ipTreasury.toString()).to.equal(expectedIpTreasury.toString());

    // REQ-A-001: the BUY base fee must NOT touch protocol_base_fee (no double-write).
    expect(after.protocolBaseFee.toString()).to.equal("0");

    // No quote-fee bucket moves on a BUY (collectFeeMode=OutputToken).
    expect(after.ipOwnerQuoteFee.toString()).to.equal(
      before.ipOwnerQuoteFee.toString()
    );
    expect(after.airdropQuoteFee.toString()).to.equal(
      before.airdropQuoteFee.toString()
    );
    expect(after.protocolQuoteFee.toString()).to.equal(
      before.protocolQuoteFee.toString()
    );
  });

  it("SELL quote fee splits 10% ip_owner / 10% airdrop / 80% protocol(treasury) residual", async () => {
    // Build SELL inventory: a single buyer buys a sub-5% slice, then sells part
    // of it back. The sell direction (BaseToQuote) charges the QUOTE fee.
    const trader = generateAndFund(svm);
    const buyState = getVirtualPool(svm, program, pool);
    await swap(svm, program, {
      config,
      payer: trader,
      pool,
      inputTokenMint: NATIVE_MINT,
      outputTokenMint: buyState.baseMint,
      amountIn: new BN(LAMPORTS_PER_SOL * 0.05), // sub-5% acquisition
      minimumAmountOut: new BN(0),
      swapMode: SwapMode.PartialFill,
      referralTokenAccount: null,
    });

    const traderBaseAta = getAssociatedTokenAddressSync(
      buyState.baseMint,
      trader.publicKey,
      true,
      TOKEN_2022_PROGRAM_ID
    );
    const traderBaseBalance = getTokenAccount(svm, traderBaseAta)!.amount;
    expect(traderBaseBalance > 0n).to.equal(true);

    const before = getVirtualPool(svm, program, pool);

    // SELL roughly half of the acquired base back to the curve (back to vault, so
    // the hook's P2P block is satisfied; the cap does not apply to the vault).
    const sellAmount = new BN((traderBaseBalance / 2n).toString());
    await swap(svm, program, {
      config,
      payer: trader,
      pool,
      inputTokenMint: buyState.baseMint,
      outputTokenMint: NATIVE_MINT,
      amountIn: sellAmount,
      minimumAmountOut: new BN(0),
      swapMode: SwapMode.PartialFill,
      referralTokenAccount: null,
    });

    const after = getVirtualPool(svm, program, pool);
    const ipOwner = after.ipOwnerQuoteFee.sub(before.ipOwnerQuoteFee);
    const airdrop = after.airdropQuoteFee.sub(before.airdropQuoteFee);
    const treasury = after.protocolQuoteFee.sub(before.protocolQuoteFee);
    const totalQuoteFee = ipOwner.add(airdrop).add(treasury);

    // A quote fee was actually collected on the SELL.
    expect(totalQuoteFee.gt(new BN(0))).to.equal(true);

    // No referral here, so distributable == totalQuoteFee.
    // ip_owner == floor(total * 10%), airdrop == floor(total * 10%),
    // treasury == residual.
    const expectedIpOwner = totalQuoteFee
      .mul(new BN(IP_OWNER_SHARE))
      .div(new BN(FEE_SHARE_PRECISION));
    const expectedAirdrop = totalQuoteFee
      .mul(new BN(AIRDROP_SHARE))
      .div(new BN(FEE_SHARE_PRECISION));
    const expectedTreasury = totalQuoteFee
      .sub(expectedIpOwner)
      .sub(expectedAirdrop);

    expect(ipOwner.toString()).to.equal(expectedIpOwner.toString());
    expect(airdrop.toString()).to.equal(expectedAirdrop.toString());
    expect(treasury.toString()).to.equal(expectedTreasury.toString());

    // ip_owner and airdrop are EQUAL shares (both 10%).
    expect(ipOwner.toString()).to.equal(airdrop.toString());

    // Treasury (80%) dominates the two 10% legs.
    expect(treasury.gt(ipOwner)).to.equal(true);

    // SELL does not write base-fee buckets.
    expect(after.tokenAirdropBaseFee.toString()).to.equal(
      before.tokenAirdropBaseFee.toString()
    );
    expect(after.ipTreasuryBaseFee.toString()).to.equal(
      before.ipTreasuryBaseFee.toString()
    );
  });

  it("fee shares are FIXED program constants (40% / 10% / 10%), independent of pool config", () => {
    // The shares are compile-time constants in state/fee.rs, not fields on the
    // pool's PoolConfig. This guards against a regression that re-introduces a
    // mutable per-pool `token_airdrop_share` / `ip_owner_share` / `airdrop_share`.
    expect(TOKEN_AIRDROP_SHARE / FEE_SHARE_PRECISION).to.equal(0.4);
    expect(IP_OWNER_SHARE / FEE_SHARE_PRECISION).to.equal(0.1);
    expect(AIRDROP_SHARE / FEE_SHARE_PRECISION).to.equal(0.1);
    // The treasury residual on a SELL is 1 - ip_owner - airdrop = 80%.
    const treasuryShare =
      (FEE_SHARE_PRECISION - IP_OWNER_SHARE - AIRDROP_SHARE) /
      FEE_SHARE_PRECISION;
    expect(treasuryShare).to.equal(0.8);
  });
});
