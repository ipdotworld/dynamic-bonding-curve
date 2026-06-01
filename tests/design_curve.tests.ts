import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ConfigParameters,
  createConfig,
  CreateConfigParams,
  createLocker,
  createPoolWithSplToken,
  progressCurveToGraduation,
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
  generateAndFund,
  getMint,
  startSvm,
} from "./utils";
import { getConfig, getVirtualPool } from "./utils/fetcher";
import { VirtualCurveProgram } from "./utils/types";

import { BN } from "bn.js";
import { expect } from "chai";
import { LiteSVM } from "litesvm";
import { createToken, mintSplTokenTo } from "./utils/token";

describe("Design default curve", () => {
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

  // Locker program does not support Token2022 Transfer Hook remaining accounts yet
  // audit: F-017 — Lock vesting requires locker program
  it.skip("Design curve with lock vesting", async () => {
    let totalTokenSupply = 1_000_000_000; // 1 billion
    let percentageSupplyOnMigration = 10; // 10%;
    let migrationQuoteThreshold = 300; // 300 sol
    let tokenBaseDecimal = 6;
    let tokenQuoteDecimal = 9;
    let lockedVesting = {
      amountPerPeriod: new BN(123456),
      cliffDurationFromMigrationTime: new BN(0),
      frequency: new BN(1),
      numberOfPeriod: new BN(120),
      cliffUnlockAmount: new BN(123456),
    };
    let migrationOption = 1;
    let quoteMint = createToken(svm, admin, admin.publicKey, tokenQuoteDecimal);
    let instructionParams = designCurve(
      totalTokenSupply,
      percentageSupplyOnMigration,
      migrationQuoteThreshold,
      migrationOption,
      tokenBaseDecimal,
      tokenQuoteDecimal,
      0,
      1,
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
    mintSplTokenTo(
      svm,
      user,
      quoteMint,
      admin,
      user.publicKey,
      instructionParams.migrationQuoteThreshold.toNumber()
    );
    await fullFlow(
      svm,
      program,
      config,
      operator,
      poolCreator,
      user,
      admin,
      quoteMint,
      partner
    );
  });

  it("Design curve without lock vesting", async () => {
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
    let quoteMint = createToken(svm, admin, admin.publicKey, tokenQuoteDecimal);
    let instructionParams = designCurve(
      totalTokenSupply,
      percentageSupplyOnMigration,
      migrationQuoteThreshold,
      migrationOption,
      tokenBaseDecimal,
      tokenQuoteDecimal,
      0,
      1,
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
    mintSplTokenTo(
      svm,
      user,
      quoteMint,
      admin,
      user.publicKey,
      instructionParams.migrationQuoteThreshold.toNumber()
    );
    await fullFlow(
      svm,
      program,
      config,
      operator,
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
  operator: Keypair,
  poolCreator: Keypair,
  user: Keypair,
  admin: Keypair,
  quoteMint: PublicKey,
  partner: Keypair
) {
  // create pool
  let virtualPool = await createPoolWithSplToken(svm, program, {
    poolCreator,
    payer: operator,
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
  const baseMintData = getMint(svm, virtualPoolState.baseMint);

  expect(baseMintData.supply.toString()).eq(
    configState.postMigrationTokenSupply.toString()
  );
}
