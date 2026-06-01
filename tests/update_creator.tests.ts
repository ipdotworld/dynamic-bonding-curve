import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
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
  progressCurveToGraduation,
  creatorWithdrawSurplus,
  swap,
  SwapMode,
  SwapParams,
  transferCreator,
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
  generateAndFund,
  startSvm,
  U64_MAX,
} from "./utils";
import { getConfig, getVirtualPool } from "./utils/fetcher";
import { createToken, mintSplTokenTo } from "./utils/token";
import { VirtualCurveProgram } from "./utils/types";

// SPEC-DBC-004 Phase 3 (REQ-I-001): the inline `claim_creator_trading_fee`
// step inside each `fullFlowUpdateCreator*` helper has been removed because
// the on-chain ix it called was deleted. The remaining flow (transferCreator
// + swap + creatorWithdrawSurplus) still exercises the meaningful integration
// surface for the "Update creator" suite.
describe("Update creator", () => {
  let svm: LiteSVM;
  let admin: Keypair;
  let operator: Keypair;
  let partner: Keypair;
  let user: Keypair;
  let poolCreator: Keypair;
  let newPoolCreator: Keypair;
  let program: VirtualCurveProgram;

  before(async () => {
    svm = startSvm();
    admin = generateAndFund(svm);
    operator = generateAndFund(svm);
    partner = generateAndFund(svm);
    user = generateAndFund(svm);
    poolCreator = generateAndFund(svm);
    newPoolCreator = generateAndFund(svm);
    program = createVirtualCurveProgram();

    await createDammV2Operator(svm, {
      whitelistAddress: admin.publicKey,
      admin,
      permission: encodePermissions([DammV2OperatorPermission.CreateConfigKey]),
    });
  });

  it("transfer new creator pre-bonding curve claim fee and surplus", async () => {
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

    await fullFlowUpdateCreatorInPreBondingCurve(
      svm,
      program,
      config,
      poolCreator,
      newPoolCreator,
      user,
      quoteMint,
      admin
    );
  });

  it("transfer new creator when pool created claim fee and surplus", async () => {
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

    await fullFlowUpdateCreatorPoolCreated(
      svm,
      program,
      config,
      admin,
      poolCreator,
      newPoolCreator,
      user,
      quoteMint,
      partner
    );
  });
});

async function fullFlowUpdateCreatorInPreBondingCurve(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  config: PublicKey,
  poolCreator: Keypair,
  newCreator: Keypair,
  user: Keypair,
  quoteMint: PublicKey,
  admin: Keypair
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

  expect(virtualPoolState.migrationProgress).eq(0);

  await transferCreator(
    svm,
    program,
    virtualPool,
    poolCreator,
    newCreator.publicKey
  );

  let configState = getConfig(svm, program, config);

  // swap
  // SPEC-DBC-AUDIT-001: graduate via many sub-5% buyers instead of a single
  // `migrationQuoteThreshold` buy that would trip the holding cap. `admin` is
  // the custom quote-mint authority used to fund each buyer.
  await progressCurveToGraduation(svm, program, config, virtualPool, {
    quoteMintAuthority: admin,
  });

  // SPEC-DBC-004 Phase 3 (REQ-I-001): `claim_creator_trading_fee` removed.
  // Creator earnings now flow exclusively through `creator_withdraw_surplus`.

  // creator withdraw surplus
  await creatorWithdrawSurplus(svm, program, {
    creator: newCreator,
    virtualPool,
  });
}

async function fullFlowUpdateCreatorPoolCreated(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  config: PublicKey,
  admin: Keypair,
  poolCreator: Keypair,
  newCreator: Keypair,
  user: Keypair,
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

  // swap
  // SPEC-DBC-AUDIT-001: graduate via many sub-5% buyers instead of a single
  // `migrationQuoteThreshold` buy that would trip the holding cap. `admin` is
  // the custom quote-mint authority used to fund each buyer.
  await progressCurveToGraduation(svm, program, config, virtualPool, {
    quoteMintAuthority: admin,
  });

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

  virtualPoolState = getVirtualPool(svm, program, virtualPool);

  await transferCreator(
    svm,
    program,
    virtualPool,
    poolCreator,
    newCreator.publicKey
  );

  // SPEC-DBC-004 Phase 3 (REQ-I-001): `claim_creator_trading_fee` removed.
  // The new creator path now relies solely on `creator_withdraw_surplus`.

  //  new creator withdraw surplus
  await creatorWithdrawSurplus(svm, program, {
    creator: newCreator,
    virtualPool,
  });
}
