import { NATIVE_MINT } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { BN } from "bn.js";
import { assert, expect } from "chai";
import { LiteSVM } from "litesvm";
import {
  BaseFee,
  claimProtocolFee,
  ClaimTradeFeeParams,
  claimTradingFee,
  ConfigParameters,
  createConfig,
  CreateConfigParams,
  createOperatorAccount,
  createPoolWithSplToken,
  OperatorPermission,
  partnerWithdrawSurplus,
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
  FLASH_RENT_FUND,
  generateAndFund,
  getMint,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  startSvm,
  U64_MAX,
} from "./utils";
import { getVirtualPool } from "./utils/fetcher";
import { Pool, VirtualCurveProgram } from "./utils/types";

describe("Full flow with spl-token", () => {
  let svm: LiteSVM;
  let admin: Keypair;
  let operator: Keypair;
  let partner: Keypair;
  let user: Keypair;
  let poolCreator: Keypair;
  let program: VirtualCurveProgram;
  let config: PublicKey;
  let virtualPool: PublicKey;
  let virtualPoolState: Pool;
  let dammConfig: PublicKey;
  let firstPosition: PublicKey;
  let secondPosition: PublicKey;

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

  it("Admin create operator with claim protocol fee permission", async () => {
    await createOperatorAccount(svm, program, {
      admin,
      whitelistedAddress: operator.publicKey,
      permissions: [OperatorPermission.ClaimProtocolFee],
    });
  });

  it("Partner create config", async () => {
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
      migrationFee: {
        feePercentage: 0,
        creatorFeePercentage: 0,
      },
      migratedPoolFee: {
        collectFeeMode: 1,
        dynamicFee: 0,
        poolFeeBps: 0,
      },
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
    };
    const params: CreateConfigParams<ConfigParameters> = {
      payer: partner,
      feeClaimer: partner.publicKey,
      quoteMint: NATIVE_MINT,
      instructionParams,
    };
    config = await createConfig(svm, program, params);
  });

  it("Create spl pool from config", async () => {
    virtualPool = await createPoolWithSplToken(svm, program, {
      poolCreator,
      payer: operator,
      quoteMint: NATIVE_MINT,
      config,
      instructionParams: {
        name: "test token spl",
        symbol: "TEST",
        uri: "abc.com",
      },
    });
    virtualPoolState = getVirtualPool(svm, program, virtualPool);

    // validate freeze authority
    const baseMintData = getMint(svm, virtualPoolState.baseMint);
    expect(baseMintData.freezeAuthority.toString()).eq(
      PublicKey.default.toString()
    );
    expect(baseMintData.mintAuthorityOption).eq(0);
  });

  it("Swap", async () => {
    const params: SwapParams = {
      config,
      payer: user,
      pool: virtualPool,
      inputTokenMint: NATIVE_MINT,
      outputTokenMint: virtualPoolState.baseMint,
      amountIn: new BN(LAMPORTS_PER_SOL * 5.5),
      minimumAmountOut: new BN(0),
      swapMode: SwapMode.PartialFill,
      referralTokenAccount: null,
    };
    await swap(svm, program, params);
  });

  it("Create meteora damm v2 metadata", async () => {
    await createMeteoraDammV2Metadata(svm, program, {
      payer: admin,
      virtualPool,
      config,
    });
  });

  it("Migrate to Meteora Damm V2 Pool", async () => {
    const poolAuthority = derivePoolAuthority();
    dammConfig = await createDammV2Config(svm, admin, poolAuthority, 1);
    const migrationParams: MigrateMeteoraDammV2Params = {
      payer: partner,
      virtualPool,
      dammConfig,
    };

    const beforePoolAuthorityLamport = svm.getBalance(poolAuthority);

    expect(beforePoolAuthorityLamport.toString()).eq(
      FLASH_RENT_FUND.toString()
    );

    const result = await migrateToDammV2(svm, program, migrationParams);
    firstPosition = result.firstPosition;
    secondPosition = result.secondPosition;

    const afterPoolAuthorityLamport = svm.getBalance(poolAuthority);

    expect(afterPoolAuthorityLamport.toString()).eq(FLASH_RENT_FUND.toString());

    // validate mint authority
    const baseMintData = getMint(svm, virtualPoolState.baseMint);
    expect(baseMintData.mintAuthorityOption).eq(0);
  });

  it("Positions exist after migration", async () => {
    // DAMM v2 creates NFT positions automatically (replaces LP lock/claim)
    const firstPositionAccount = svm.getAccount(firstPosition);
    const secondPositionAccount = svm.getAccount(secondPosition);

    expect(firstPositionAccount).to.not.be.null;
    expect(secondPositionAccount).to.not.be.null;
  });

  // partner_withdraw_surplus removed in A-04 (partner system removal)
  it.skip("Partner withdraw surplus", async () => {
    await partnerWithdrawSurplus(svm, program, {
      feeClaimer: partner,
      virtualPool,
    });
  });

  // partner_withdraw_surplus removed in A-04 (partner system removal)
  it.skip("Partner can not withdraw again", async () => {
    try {
      await partnerWithdrawSurplus(svm, program, {
        feeClaimer: partner,
        virtualPool,
      });
      assert.ok(false);
    } catch (e) {
      //
    }
  });

  it("Protocol withdraw surplus", async () => {
    await claimProtocolFee(svm, program, {
      operator: operator,
      pool: virtualPool,
    });
  });

  it("Protocol can withdraw surplus again", async () => {
    await claimProtocolFee(svm, program, {
      operator: operator,
      pool: virtualPool,
    });
  });

  // claim_trading_fee removed in A-04 (partner system removal); use claim_creator_trading_fee
  it.skip("Partner claim trading fee", async () => {
    const claimTradingFeeParams: ClaimTradeFeeParams = {
      feeClaimer: partner,
      pool: virtualPool,
      maxBaseAmount: new BN(U64_MAX),
      maxQuoteAmount: new BN(U64_MAX),
    };
    await claimTradingFee(svm, program, claimTradingFeeParams);
  });

  it("Operator claim protocol fee", async () => {
    await claimProtocolFee(svm, program, {
      pool: virtualPool,
      operator: operator,
    });
  });
});
