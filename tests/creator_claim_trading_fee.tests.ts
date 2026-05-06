import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { LiteSVM } from "litesvm";
import {
  ClaimCreatorTradeFeeParams,
  claimCreatorTradingFee,
  ConfigParameters,
  createConfig,
  CreateConfigParams,
  createLocker,
  createPoolWithSplToken,
  creatorWithdrawSurplus,
  swap,
  SwapMode,
  SwapParams,
} from "./instructions";
import {
  createMeteoraDammV2Metadata,
  MigrateMeteoraDammV2Params,
  migrateToDammV2,
} from "./instructions/dammV2Migration";
import {
  createDammV2Config,
  createDammV2Operator,
  createVirtualCurveProgram,
  DammV2OperatorPermission,
  derivePoolAuthority,
  designCurve,
  encodePermissions,
  expectThrowsAsync,
  generateAndFund,
  startSvm,
  U64_MAX,
} from "./utils";
import { getConfig, getVirtualPool } from "./utils/fetcher";
import { createToken, mintSplTokenTo } from "./utils/token";
import { VirtualCurveProgram } from "./utils/types";

// SPEC-DBC-004 Phase 3 (REQ-I-001): `claim_creator_trading_fee` ix and the
// `_deprecated_creator_base_fee` field were removed. The fullFlow helper has
// been adjusted to exercise the surviving creator-side surface
// (`creator_withdraw_surplus`) only; the prior assertions that the deprecated
// creator base fee accumulator was zero are dropped because the field itself
// no longer exists in `VirtualPool`. The legacy "fee between partner and
// creator" framing remains for historical naming, but partner trading fee
// accumulators are zero-padded since Phase 1+2.
describe("Creator and Partner share trading fees and surplus", () => {
  let svm: LiteSVM;
  let admin: Keypair;
  let operator: Keypair;
  let partner: Keypair;
  let user: Keypair;
  let poolCreator: Keypair;
  let program: VirtualCurveProgram;

  before(async () => {
    svm = startSvm();
    admin = generateAndFund(svm);
    operator = generateAndFund(svm);
    partner = generateAndFund(svm);
    user = generateAndFund(svm);
    poolCreator = generateAndFund(svm);
    program = createVirtualCurveProgram();

    await createDammV2Operator(svm, {
      whitelistAddress: admin.publicKey,
      admin,
      permission: encodePermissions([DammV2OperatorPermission.CreateConfigKey]),
    });
  });

  it("50-50 fee between partner and creator", async () => {
    let totalTokenSupply = 1_000_000_000; // 1 billion
    let percentageSupplyOnMigration = 10; // 10%;
    let migrationQuoteThreshold = 300; // 300 sol
    let migrationOption = 1;
    let tokenBaseDecimal = 6;
    let tokenQuoteDecimal = 9;
    let lockedVesting = {
      amountPerPeriod: new BN(0),
      cliffDurationFromMigrationTime: new BN(0),
      frequency: new BN(0),
      numberOfPeriod: new BN(0),
      cliffUnlockAmount: new BN(0),
    };
    let creatorTradingFeePercentage = 50;
    let collectFeeMode = 1;
    let quoteMint = createToken(svm, admin, admin.publicKey, tokenQuoteDecimal);
    let instructionParams = designCurve(
      totalTokenSupply,
      percentageSupplyOnMigration,
      migrationQuoteThreshold,
      migrationOption,
      tokenBaseDecimal,
      tokenQuoteDecimal,
      creatorTradingFeePercentage,
      collectFeeMode,
      lockedVesting,
      {
        feePercentage: 0,
        creatorFeePercentage: 0,
      }
    );
    const params: CreateConfigParams<ConfigParameters> = {
      payer: partner,
      feeClaimer: partner.publicKey,
      quoteMint,
      instructionParams,
    };
    let config = await createConfig(svm, program, params);
    let configState = getConfig(svm, program, config);
    expect(configState.creatorTradingFeePercentage).eq(
      creatorTradingFeePercentage
    );
    mintSplTokenTo(
      svm,
      user,
      quoteMint,
      admin,
      user.publicKey,
      instructionParams.migrationQuoteThreshold.mul(new BN(2)).toNumber()
    );
    await fullFlow(
      svm,
      program,
      config,
      poolCreator,
      user,
      admin,
      quoteMint,
      partner
    );
  });

  it("0-100 fee between partner and creator", async () => {
    let totalTokenSupply = 1_000_000_000; // 1 billion
    let percentageSupplyOnMigration = 10; // 10%;
    let migrationQuoteThreshold = 300; // 300 sol
    let migrationOption = 1;
    let tokenBaseDecimal = 6;
    let tokenQuoteDecimal = 9;
    let lockedVesting = {
      amountPerPeriod: new BN(0),
      cliffDurationFromMigrationTime: new BN(0),
      frequency: new BN(0),
      numberOfPeriod: new BN(0),
      cliffUnlockAmount: new BN(0),
    };
    let creatorTradingFeePercentage = 100;
    let collectFeeMode = 0;
    let quoteMint = createToken(svm, admin, admin.publicKey, tokenQuoteDecimal);
    let instructionParams = designCurve(
      totalTokenSupply,
      percentageSupplyOnMigration,
      migrationQuoteThreshold,
      migrationOption,
      tokenBaseDecimal,
      tokenQuoteDecimal,
      creatorTradingFeePercentage,
      collectFeeMode,
      lockedVesting,
      {
        feePercentage: 0,
        creatorFeePercentage: 0,
      }
    );
    const params: CreateConfigParams<ConfigParameters> = {
      payer: partner,
      feeClaimer: partner.publicKey,
      quoteMint,
      instructionParams,
    };
    let config = await createConfig(svm, program, params);
    let configState = getConfig(svm, program, config);
    expect(configState.creatorTradingFeePercentage).eq(
      creatorTradingFeePercentage
    );
    mintSplTokenTo(
      svm,
      user,
      quoteMint,
      admin,
      user.publicKey,
      instructionParams.migrationQuoteThreshold.mul(new BN(2)).toNumber()
    );
    await fullFlow(
      svm,
      program,
      config,
      poolCreator,
      user,
      admin,
      quoteMint,
      partner
    );
  });

  it("100-0 fee between partner and creator", async () => {
    let totalTokenSupply = 1_000_000_000; // 1 billion
    let percentageSupplyOnMigration = 10; // 10%;
    let migrationQuoteThreshold = 300; // 300 sol
    let migrationOption = 1;
    let tokenBaseDecimal = 6;
    let tokenQuoteDecimal = 9;
    let lockedVesting = {
      amountPerPeriod: new BN(0),
      cliffDurationFromMigrationTime: new BN(0),
      frequency: new BN(0),
      numberOfPeriod: new BN(0),
      cliffUnlockAmount: new BN(0),
    };
    let creatorTradingFeePercentage = 0;
    let collectFeeMode = 1;
    let quoteMint = createToken(svm, admin, admin.publicKey, tokenQuoteDecimal);
    let instructionParams = designCurve(
      totalTokenSupply,
      percentageSupplyOnMigration,
      migrationQuoteThreshold,
      migrationOption,
      tokenBaseDecimal,
      tokenQuoteDecimal,
      creatorTradingFeePercentage,
      collectFeeMode,
      lockedVesting,
      {
        feePercentage: 0,
        creatorFeePercentage: 0,
      }
    );
    const params: CreateConfigParams<ConfigParameters> = {
      payer: partner,
      feeClaimer: partner.publicKey,
      quoteMint,
      instructionParams,
    };
    let config = await createConfig(svm, program, params);
    let configState = getConfig(svm, program, config);
    expect(configState.creatorTradingFeePercentage).eq(
      creatorTradingFeePercentage
    );
    mintSplTokenTo(
      svm,
      user,
      quoteMint,
      admin,
      user.publicKey,
      instructionParams.migrationQuoteThreshold.mul(new BN(2)).toNumber()
    );
    await fullFlow(
      svm,
      program,
      config,
      poolCreator,
      user,
      admin,
      quoteMint,
      partner
    );
  });

  it("20-80 fee between partner and creator", async () => {
    let totalTokenSupply = 1_000_000_000; // 1 billion
    let percentageSupplyOnMigration = 10; // 10%;
    let migrationQuoteThreshold = 300; // 300 sol
    let migrationOption = 1;
    let tokenBaseDecimal = 6;
    let tokenQuoteDecimal = 9;
    let lockedVesting = {
      amountPerPeriod: new BN(0),
      cliffDurationFromMigrationTime: new BN(0),
      frequency: new BN(0),
      numberOfPeriod: new BN(0),
      cliffUnlockAmount: new BN(0),
    };
    let creatorTradingFeePercentage = 80;
    let collectFeeMode = 0;
    let quoteMint = createToken(svm, admin, admin.publicKey, tokenQuoteDecimal);
    let instructionParams = designCurve(
      totalTokenSupply,
      percentageSupplyOnMigration,
      migrationQuoteThreshold,
      migrationOption,
      tokenBaseDecimal,
      tokenQuoteDecimal,
      creatorTradingFeePercentage,
      collectFeeMode,
      lockedVesting,
      {
        feePercentage: 0,
        creatorFeePercentage: 0,
      }
    );
    const params: CreateConfigParams<ConfigParameters> = {
      payer: partner,
      feeClaimer: partner.publicKey,
      quoteMint,
      instructionParams,
    };
    let config = await createConfig(svm, program, params);
    let configState = getConfig(svm, program, config);
    expect(configState.creatorTradingFeePercentage).eq(
      creatorTradingFeePercentage
    );
    mintSplTokenTo(
      svm,
      user,
      quoteMint,
      admin,
      user.publicKey,
      instructionParams.migrationQuoteThreshold.mul(new BN(2)).toNumber()
    );
    await fullFlow(
      svm,
      program,
      config,
      poolCreator,
      user,
      admin,
      quoteMint,
      partner
    );
  });
});

async function fullFlow(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  config: PublicKey,
  poolCreator: Keypair,
  user: Keypair,
  admin: Keypair,
  quoteMint: PublicKey,
  partner: Keypair
) {
  // create pool
  let virtualPool = await createPoolWithSplToken(svm, program, {
    payer: poolCreator,
    poolCreator: poolCreator,
    quoteMint,
    config,
    instructionParams: {
      name: "test token spl",
      symbol: "TEST",
      uri: "abc.com",
    },
  });
  let virtualPoolState = getVirtualPool(svm, program, virtualPool);

  let configState = getConfig(svm, program, config);

  let amountIn;
  if (configState.collectFeeMode == 0) {
    // over 20%
    amountIn = configState.migrationQuoteThreshold
      .mul(new BN(6))
      .div(new BN(5));
  } else {
    amountIn = configState.migrationQuoteThreshold;
  }
  // swap
  const params: SwapParams = {
    config,
    payer: user,
    pool: virtualPool,
    inputTokenMint: quoteMint,
    outputTokenMint: virtualPoolState.baseMint,
    amountIn,
    minimumAmountOut: new BN(0),
    swapMode: SwapMode.PartialFill,
    referralTokenAccount: null,
  };
  await swap(svm, program, params);

  virtualPoolState = getVirtualPool(svm, program, virtualPool);

  // IPWorld A-04 + SPEC-DBC-004 Phase 2 + Phase 3:
  // - Partner trading fee fields renamed to `_padding_partner_*` (Phase 2 Step 2.6),
  //   exposed in IDL as `paddingPartnerBase` / `paddingPartnerQuote`. Still zero-padded.
  // - `_deprecated_creator_base_fee` and `creator_quote_fee` fields fully removed
  //   in Phase 3 alongside `creator_share` and the `claim_creator_trading_fee` ix.
  expect(virtualPoolState.paddingPartnerBase.toString()).eq("0");
  expect(virtualPoolState.paddingPartnerQuote.toString()).eq("0");

  // migrate
  const poolAuthority = derivePoolAuthority();
  const dammConfig = await createDammV2Config(svm, admin, poolAuthority, 1);
  await createMeteoraDammV2Metadata(svm, program, {
    payer: admin,
    virtualPool,
    config,
  });

  if (configState.lockedVestingConfig.frequency.toNumber() != 0) {
    await createLocker(svm, program, {
      payer: admin,
      virtualPool,
    });
  }
  const migrationParams: MigrateMeteoraDammV2Params = {
    payer: partner,
    virtualPool,
    dammConfig,
  };
  await migrateToDammV2(svm, program, migrationParams);

  // Anchor ConstraintHasOne error (2001 = 0x7d1) is thrown when creator mismatch
  const errorCodeUnauthorized = "0x7d1";

  // SPEC-DBC-004 Phase 3 (REQ-I-001): `claim_creator_trading_fee` ix removed.
  // The unauthorized-creator-claim and creator-claim assertions previously
  // exercised the now-deleted ix path. Creator earnings flow exclusively
  // through `creator_withdraw_surplus`; only that surface is exercised below.

  // unauthorized creator surplus withdraw (has_one = creator constraint)
  expectThrowsAsync(async () => {
    await creatorWithdrawSurplus(svm, program, {
      creator: partner,
      virtualPool,
    });
  }, errorCodeUnauthorized);
  // creator withdraw surplus
  await creatorWithdrawSurplus(svm, program, {
    creator: poolCreator,
    virtualPool,
  });
}
