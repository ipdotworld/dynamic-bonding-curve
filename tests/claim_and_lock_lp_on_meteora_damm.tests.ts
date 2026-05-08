import {
  NATIVE_MINT,
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
  createPoolWithSplToken,
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
  encodePermissions,
  generateAndFund,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  startSvm,
  U64_MAX,
} from "./utils";
import {
  getVirtualPool,
} from "./utils/fetcher";
import { VirtualCurveProgram } from "./utils/types";

async function createPartnerConfig(
  payer: Keypair,
  owner: PublicKey,
  feeClaimer: PublicKey,
  svm: LiteSVM,
  program: VirtualCurveProgram
): Promise<PublicKey> {
  const baseFee: BaseFee = {
    cliffFeeNumerator: new BN(2_500_000),
    firstFactor: 0,
    secondFactor: new BN(0),
    thirdFactor: new BN(0),
    baseFeeMode: 0,
  };

  const curves = [];

  for (let i = 1; i <= 16; i++) {
    if (i == 16) {
      curves.push({
        sqrtPrice: MAX_SQRT_PRICE,
        liquidity: U64_MAX.shln(30 + i),
      });
    } else {
      curves.push({
        sqrtPrice: MAX_SQRT_PRICE.muln(i * 5).divn(100),
        liquidity: U64_MAX.shln(30 + i),
      });
    }
  }

  const instructionParams: ConfigParameters = {
    poolFees: {
      baseFee,
      dynamicFee: null,
    },
    activationType: 0,
    collectFeeMode: 1,
    migrationOption: 1,
    tokenType: 0, // spl_token
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
    migrationFee: {
      feePercentage: 0,
      creatorFeePercentage: 0,
    },
    migratedPoolFee: {
      collectFeeMode: 1,
      dynamicFee: 0,
      poolFeeBps: 0,
    },
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
    migratedPoolBaseFeeMode: 0,
    migratedPoolMarketCapFeeSchedulerParams: null,
    poolCreationFee: new BN(0),
    curve: curves,
    enableFirstSwapWithMinFee: false,
    compoundingFeeBps: 0,
  };
  const params: CreateConfigParams<ConfigParameters> = {
    payer,
    feeClaimer,
    quoteMint: NATIVE_MINT,
    instructionParams,
  };
  return createConfig(svm, program, params);
}

async function setupPrerequisite(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  payer: Keypair,
  poolCreator: Keypair,
  swapInitiator: Keypair,
  admin: Keypair,
  partner: Keypair,
  config: PublicKey
): Promise<{
  virtualPool: PublicKey;
  dammConfig: PublicKey;
  firstPosition: PublicKey;
  secondPosition: PublicKey;
}> {
  const virtualPool = await createPoolWithSplToken(svm, program, {
    payer,
    poolCreator,
    quoteMint: NATIVE_MINT,
    config,
    instructionParams: {
      name: "test token spl",
      symbol: "TEST",
      uri: "abc.com",
    },
  });

  const virtualPoolState = getVirtualPool(svm, program, virtualPool);

  const params: SwapParams = {
    config,
    payer: swapInitiator,
    pool: virtualPool,
    inputTokenMint: NATIVE_MINT,
    outputTokenMint: virtualPoolState.baseMint,
    amountIn: new BN(LAMPORTS_PER_SOL * 5.5),
    minimumAmountOut: new BN(0),
    swapMode: SwapMode.PartialFill,
    referralTokenAccount: null,
  };

  await swap(svm, program, params);

  await createMeteoraDammV2Metadata(svm, program, {
    payer: admin,
    virtualPool,
    config,
  });

  const poolAuthority = derivePoolAuthority();
  const dammConfig = await createDammV2Config(svm, admin, poolAuthority, 1);
  const migrationParams: MigrateMeteoraDammV2Params = {
    payer: partner,
    virtualPool,
    dammConfig,
  };

  const result = await migrateToDammV2(svm, program, migrationParams);

  return {
    virtualPool,
    dammConfig,
    firstPosition: result.firstPosition,
    secondPosition: result.secondPosition,
  };
}

function startTestSvm(): {
  svm: LiteSVM;
  admin: Keypair;
  operator: Keypair;
  partner: Keypair;
  user: Keypair;
  poolCreator: Keypair;
  program: VirtualCurveProgram;
} {
  const svm = startSvm();
  const operator = generateAndFund(svm);
  const partner = generateAndFund(svm);
  const user = generateAndFund(svm);
  const poolCreator = generateAndFund(svm);
  const admin = generateAndFund(svm);

  const program = createVirtualCurveProgram();

  return {
    svm,
    admin,
    operator,
    partner,
    user,
    poolCreator,
    program,
  };
}

describe("Claim and lock lp on meteora dammm", () => {
  let svm: LiteSVM;
  let admin: Keypair;
  let operator: Keypair;
  let partner: Keypair;
  let user: Keypair;
  let poolCreator: Keypair;
  let program: VirtualCurveProgram;
  let config: PublicKey;
  let virtualPool: PublicKey;
  let dammConfig: PublicKey;
  let firstPosition: PublicKey;
  let secondPosition: PublicKey;

  describe("Self partnered creator", () => {
    before(async () => {
      const {
        admin: innerAdmin,
        operator: innerOperator,
        user: innerUser,
        poolCreator: innerPoolCreator,
        partner: innerPartner,
        program: innerProgram,
        svm: innerSvm,
      } = startTestSvm();

      svm = innerSvm;
      admin = innerAdmin;
      operator = innerOperator;
      partner = innerPartner;
      user = innerUser;
      poolCreator = innerPoolCreator;
      program = innerProgram;

      await createDammV2Operator(svm, {
        whitelistAddress: admin.publicKey,
        admin,
        permission: encodePermissions([DammV2OperatorPermission.CreateConfigKey]),
      });

      config = await createPartnerConfig(
        admin,
        poolCreator.publicKey,
        poolCreator.publicKey,
        svm,
        program
      );

      const result = await setupPrerequisite(
        svm,
        program,
        admin,
        poolCreator,
        user,
        admin,
        poolCreator, // self-partnered: poolCreator is feeClaimer
        config
      );

      dammConfig = result.dammConfig;
      virtualPool = result.virtualPool;
      firstPosition = result.firstPosition;
      secondPosition = result.secondPosition;
    });

    it("Self partnered creator: both positions created after migration", async () => {
      // DAMM v2 automatically creates positions (no separate LP lock/claim needed)
      // For self-partnered creator, both firstPosition and secondPosition are created
      const firstPositionAccount = svm.getAccount(firstPosition);
      const secondPositionAccount = svm.getAccount(secondPosition);

      expect(firstPositionAccount).to.not.be.null;
      expect(secondPositionAccount).to.not.be.null;
    });

    it("Self partnered creator: virtual pool migration completed", async () => {
      const poolState = getVirtualPool(svm, program, virtualPool);
      expect(poolState.migrationProgress).to.be.greaterThan(0);
    });
  });

  describe("Separated partner and creator", () => {
    before(async () => {
      const {
        svm: innerSvm,
        admin: innerAdmin,
        operator: innerOperator,
        user: innerUser,
        poolCreator: innerPoolCreator,
        partner: innerPartner,
        program: innerProgram,
      } = startTestSvm();

      operator = innerOperator;
      partner = innerPartner;
      user = innerUser;
      poolCreator = innerPoolCreator;
      program = innerProgram;
      svm = innerSvm;
      admin = innerAdmin;

      await createDammV2Operator(svm, {
        whitelistAddress: admin.publicKey,
        admin,
        permission: encodePermissions([DammV2OperatorPermission.CreateConfigKey]),
      });

      config = await createPartnerConfig(
        admin,
        poolCreator.publicKey,
        partner.publicKey,
        svm,
        program
      );

      const result = await setupPrerequisite(
        svm,
        program,
        operator,
        poolCreator,
        user,
        admin,
        partner,
        config
      );

      dammConfig = result.dammConfig;
      virtualPool = result.virtualPool;
      firstPosition = result.firstPosition;
      secondPosition = result.secondPosition;
    });

    it("Separated partner/creator: first position created after migration", async () => {
      const firstPositionAccount = svm.getAccount(firstPosition);
      expect(firstPositionAccount).to.not.be.null;
    });

    it("Separated partner/creator: second position created after migration", async () => {
      const secondPositionAccount = svm.getAccount(secondPosition);
      expect(secondPositionAccount).to.not.be.null;
    });

    it("Separated partner/creator: virtual pool migration completed", async () => {
      const poolState = getVirtualPool(svm, program, virtualPool);
      expect(poolState.migrationProgress).to.be.greaterThan(0);
    });
  });
});
