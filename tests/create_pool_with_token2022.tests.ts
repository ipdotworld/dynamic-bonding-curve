import {
  ACCOUNT_SIZE,
  ACCOUNT_TYPE_SIZE,
  ExtensionType,
  getExtensionData,
  NATIVE_MINT,
  getExtensionTypes,
} from "@solana/spl-token";
import { unpack } from "@solana/spl-token-metadata";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { BN } from "bn.js";
import { expect } from "chai";
import { LiteSVM } from "litesvm";
import {
  BaseFee,
  claimProtocolFee,
  ClaimTradeFeeParams,
  claimTradingFee,
  ConfigParameters,
  createOperatorAccount,
  createConfig,
  CreateConfigParams,
  createPoolWithToken2022,
  swap,
  SwapMode,
  SwapParams,
  OperatorPermission,
} from "./instructions";
import {
  createVirtualCurveProgram,
  generateAndFund,
  getMint,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  startSvm,
  U64_MAX,
} from "./utils";
import { getVirtualPool } from "./utils/fetcher";
import { Pool, VirtualCurveProgram } from "./utils/types";
import {
  deriveHookConfigAddress,
  deriveExtraAccountMetaListAddress,
  deriveIpworldStateAddress,
  derivePoolAuthority,
} from "./utils/accounts";
import { IPWORLD_HOOK_PROGRAM_ID, DYNAMIC_BONDING_CURVE_PROGRAM_ID } from "./utils/constants";
import { createHash } from "crypto";

describe("Create pool with token2022", () => {
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

  before(async () => {
    svm = startSvm();
    admin = generateAndFund(svm);
    operator = generateAndFund(svm);
    partner = generateAndFund(svm);
    user = generateAndFund(svm);
    poolCreator = generateAndFund(svm);
    program = createVirtualCurveProgram();

    await createOperatorAccount(svm, program, {
      admin,
      whitelistedAddress: operator.publicKey,
      permissions: [OperatorPermission.ClaimProtocolFee],
    });

    // IpworldState PDA is already initialized by startSvm() with correct 137-byte layout.
    // Authority keypair is available via getSvmAuthority() for Ed25519 signing.
  });

  it("IpworldState PDA exists", () => {
    const ipworldState = deriveIpworldStateAddress();
    const acc = svm.getAccount(ipworldState);
    expect(acc).to.not.be.null;
    expect(acc!.data.length).to.equal(137);
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
      migrationOption: 1, // damm v2
      tokenType: 1, // token 2022
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

  it("Create token2022 pool from config", async () => {
    const name = "test token 2022";
    const symbol = "TOKEN2022";
    const uri = "token2022.com";

    virtualPool = await createPoolWithToken2022(svm, program, {
      payer: operator,
      poolCreator,
      quoteMint: NATIVE_MINT,
      config,
      instructionParams: {
        name,
        symbol,
        uri,
      },
    });
    virtualPoolState = getVirtualPool(svm, program, virtualPool);

    // validate metadata
    const tlvData = svm
      .getAccount(virtualPoolState.baseMint)
      .data.slice(ACCOUNT_SIZE + ACCOUNT_TYPE_SIZE);
    const metadata = unpack(
      getExtensionData(ExtensionType.TokenMetadata, Buffer.from(tlvData))
    );
    expect(metadata.name).eq(name);
    expect(metadata.symbol).eq(symbol);
    expect(metadata.uri).eq(uri);
    expect(metadata.updateAuthority.toString()).eq(
      poolCreator.publicKey.toString()
    );

    // validate freeze authority
    const baseMintData = getMint(svm, virtualPoolState.baseMint);
    expect(baseMintData.freezeAuthority.toString()).eq(
      PublicKey.default.toString()
    );
    expect(baseMintData.mintAuthorityOption).eq(0);
  });

  it("Mint has TransferHook extension with correct program ID", () => {
    const mintData = svm.getAccount(virtualPoolState.baseMint).data;
    const tlvData = mintData.slice(ACCOUNT_SIZE + ACCOUNT_TYPE_SIZE);

    // Check TransferHook extension exists
    const hookData = getExtensionData(
      ExtensionType.TransferHook,
      Buffer.from(tlvData)
    );
    expect(hookData).to.not.be.null;

    // TransferHook extension data: authority (32 bytes) + program_id (32 bytes)
    const hookAuthority = new PublicKey(hookData!.slice(0, 32));
    const hookProgramId = new PublicKey(hookData!.slice(32, 64));
    const poolAuthority = derivePoolAuthority();

    expect(hookProgramId.toBase58()).to.equal(
      IPWORLD_HOOK_PROGRAM_ID.toBase58(),
      "Hook program ID should be ipworld-hook"
    );
    expect(hookAuthority.toBase58()).to.equal(
      poolAuthority.toBase58(),
      "Hook authority should be pool_authority (for graduation removal)"
    );
    console.log("    ✅ TransferHook extension present with correct program ID and authority");
  });

  it("ExtraAccountMetaList PDA was created", () => {
    const metaListPDA = deriveExtraAccountMetaListAddress(virtualPoolState.baseMint);
    const account = svm.getAccount(metaListPDA);
    expect(account).to.not.be.null;
    expect(account.data.length).to.be.greaterThan(0);
    console.log("    ✅ ExtraAccountMetaList PDA exists with data");
  });

  it("HookConfig PDA was created with correct vault", () => {
    const hookConfigPDA = deriveHookConfigAddress(virtualPoolState.baseMint);
    const account = svm.getAccount(hookConfigPDA);
    expect(account).to.not.be.null;

    // HookConfig layout: 8 (discriminator) + 32 (pool_vault) + 1 (bump)
    const data = Buffer.from(account.data);
    expect(data.length).to.equal(41);
    const poolVault = new PublicKey(data.slice(8, 40));
    expect(poolVault.toBase58()).to.equal(
      virtualPoolState.baseVault.toBase58(),
      "HookConfig pool_vault should match the pool's base_vault"
    );
    console.log("    ✅ HookConfig PDA exists with correct pool_vault");
  });

  it("Swap", async () => {
    const params: SwapParams = {
      config,
      payer: user,
      pool: virtualPool,
      inputTokenMint: NATIVE_MINT,
      outputTokenMint: virtualPoolState.baseMint,
      amountIn: new BN(LAMPORTS_PER_SOL * 0.1), // small amount to stay under 5% ownership cap
      minimumAmountOut: new BN(0),
      swapMode: SwapMode.PartialFill,
      referralTokenAccount: null,
    };
    await swap(svm, program, params);
  });

  it.skip("Partner claim trading fee", async () => {
    const claimTradingFeeParams: ClaimTradeFeeParams = {
      feeClaimer: partner,
      pool: virtualPool,
      maxBaseAmount: new BN(U64_MAX),
      maxQuoteAmount: new BN(U64_MAX),
    };
    await claimTradingFee(svm, program, claimTradingFeeParams);
  });

  it.skip("Operator claim protocol fee", async () => {
    await claimProtocolFee(svm, program, {
      pool: virtualPool,
      operator: operator,
    });
  });
});
