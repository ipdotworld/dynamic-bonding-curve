/**
 * Step 6 — Graduation: hook removal + DAMM v2 migration (LiteSVM)
 *
 * Tests that when a Token2022 pool graduates (migrates to DAMM v2):
 * 1. TransferHookProgramId authority is set to None on the mint
 * 2. DAMM v2 pool is created successfully
 * 3. Transfer hook extension shows no program after graduation
 *
 * Build: cargo build-sbf -- --features local,skip-launch-auth
 * Run:   npx ts-mocha -t 120000 tests/graduation_hook_removal.tests.ts
 */

import {
  NATIVE_MINT,
  ACCOUNT_SIZE,
  ACCOUNT_TYPE_SIZE,
  getExtensionData,
  getExtensionTypes,
  ExtensionType,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
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
  swap,
  SwapMode,
  SwapParams,
  OperatorPermission,
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
  encodePermissions,
  generateAndFund,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  startSvm,
  U64_MAX,
} from "./utils";
import { DAMM_V2_PROGRAM_ID } from "./utils/constants";
import { getVirtualPool } from "./utils/fetcher";
import { Pool, VirtualCurveProgram } from "./utils/types";
import {
  deriveHookConfigAddress,
  deriveExtraAccountMetaListAddress,
  deriveIpworldStateAddress,
  derivePoolAuthority,
} from "./utils/accounts";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID, IPWORLD_HOOK_PROGRAM_ID } from "./utils/constants";
import { createHash } from "crypto";

describe("Step 6 — Graduation: hook removal + DAMM v2 migration", () => {
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

    // DAMM v2 operator (needed for graduation/migration)
    await createDammV2Operator(svm, {
      whitelistAddress: admin.publicKey,
      admin,
      permission: encodePermissions([
        DammV2OperatorPermission.CreateConfigKey,
        DammV2OperatorPermission.CreateTokenBadge,
      ]),
    });

    // Write IpworldState PDA into LiteSVM (required by pool creation since Step 5)
    const ipworldState = deriveIpworldStateAddress();
    const [, ipworldBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("ipworld_state")],
      DYNAMIC_BONDING_CURVE_PROGRAM_ID
    );
    const discriminator = createHash("sha256")
      .update("account:IpworldState")
      .digest()
      .subarray(0, 8);
    const data = Buffer.alloc(73);
    discriminator.copy(data, 0);
    admin.publicKey.toBuffer().copy(data, 8);   // authority
    admin.publicKey.toBuffer().copy(data, 40);  // admin
    data.writeUInt8(ipworldBump, 72);
    svm.setAccount(ipworldState, {
      lamports: 1_000_000_000,
      data,
      owner: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      executable: false,
    });
  });

  it("Create config (Token2022, DAMM v2 migration)", async () => {
    const baseFee: BaseFee = {
      cliffFeeNumerator: new BN(2_500_000),
      firstFactor: 0,
      secondFactor: new BN(0),
      thirdFactor: new BN(0),
      baseFeeMode: 0,
    };

    const curves = [];
    for (let i = 1; i <= 16; i++) {
      curves.push({
        sqrtPrice: i === 16 ? MAX_SQRT_PRICE : MAX_SQRT_PRICE.muln(i * 5).divn(100),
        liquidity: U64_MAX.shln(30 + i),
      });
    }

    const instructionParams: ConfigParameters = {
      poolFees: {
        baseFee,
        dynamicFee: null,
      },
      activationType: 0,
      collectFeeMode: 1,
      migrationOption: 1, // DAMM v2
      tokenType: 1,       // Token2022
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
      poolCreationFee: new BN(0),
      curve: curves,
      enableFirstSwapWithMinFee: false,
      compoundingFeeBps: 0,
      migratedPoolBaseFeeMode: 0,
      migratedPoolMarketCapFeeSchedulerParams: null,
    };

    config = await createConfig(svm, program, {
      payer: partner,
      leftoverReceiver: partner.publicKey,
      feeClaimer: partner.publicKey,
      quoteMint: NATIVE_MINT,
      instructionParams,
    });
  });

  it("Create Token2022 pool with transfer hook", async () => {
    virtualPool = await createPoolWithToken2022(svm, program, {
      poolCreator,
      payer: operator,
      quoteMint: NATIVE_MINT,
      config,
      instructionParams: {
        name: "Graduation Test Token",
        symbol: "GRAD",
        uri: "https://example.com/grad.json",
      },
    });
    virtualPoolState = getVirtualPool(svm, program, virtualPool);
  });

  it("Verify hook is active on mint before graduation", () => {
    const account = svm.getAccount(virtualPoolState.baseMint)!;
    // Token2022 mint data: 82 bytes base + TLV extensions
    // Must wrap in Buffer — LiteSVM returns Uint8Array, spl-token needs Buffer.readUInt16LE
    const tlvData = Buffer.from(account.data.slice(ACCOUNT_SIZE + ACCOUNT_TYPE_SIZE));
    const extensions = getExtensionTypes(tlvData);
    expect(extensions).to.include(ExtensionType.TransferHook);

    const hookData = getExtensionData(ExtensionType.TransferHook, tlvData);
    expect(hookData).to.not.be.null;
    const hookProgramId = new PublicKey(hookData!.subarray(32, 64));
    expect(hookProgramId.equals(IPWORLD_HOOK_PROGRAM_ID)).to.be.true;
    console.log("    ✅ Hook program active:", hookProgramId.toBase58());
  });

  it("Swap to fill curve to migration threshold (multiple users)", async () => {
    // Need many small swaps to stay under 5% ownership cap per wallet
    // Each buyer does 0.1 SOL — need 60 buyers to cross 5 SOL threshold
    // (some goes to fees, so need extra)
    const buyers = [];
    for (let i = 0; i < 65; i++) {
      buyers.push(generateAndFund(svm));
    }

    for (const buyer of buyers) {
      try {
        const params: SwapParams = {
          config,
          payer: buyer,
          pool: virtualPool,
          inputTokenMint: NATIVE_MINT,
          outputTokenMint: virtualPoolState.baseMint,
          amountIn: new BN(LAMPORTS_PER_SOL * 0.1),
          minimumAmountOut: new BN(0),
          swapMode: SwapMode.PartialFill,
          referralTokenAccount: null,
        };
        await swap(svm, program, params);
      } catch (e: any) {
        // PoolIsCompleted means curve is full — graduation ready
        if (e.message?.includes("PoolIsCompleted")) break;
        throw e;
      }
    }
  });

  it("Create DAMM v2 migration metadata", async () => {
    await createMeteoraDammV2Metadata(svm, program, {
      payer: admin,
      virtualPool,
      config,
    });
  });

  it("Graduate to DAMM v2 — hook should be removed", async () => {
    const poolAuthority = derivePoolAuthority();
    dammConfig = await createDammV2Config(
      svm,
      admin,
      poolAuthority,
      1 // Timestamp activation
    );

    // Create token badge for base mint (Token2022 tokens need this in DAMM v2)
    const { createDammV2Program } = await import("./utils/common");
    const dammProgram = createDammV2Program();
    const [tokenBadge] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_badge"), virtualPoolState.baseMint.toBuffer()],
      DAMM_V2_PROGRAM_ID
    );
    const [dammOperator] = PublicKey.findProgramAddressSync(
      [Buffer.from("operator"), admin.publicKey.toBuffer()],
      DAMM_V2_PROGRAM_ID
    );
    const { deriveDammV2EventAuthority } = await import("./instructions/dammV2Migration");
    const badgeTx = await dammProgram.methods
      .createTokenBadge()
      .accountsPartial({
        tokenBadge,
        tokenMint: virtualPoolState.baseMint,
        operator: dammOperator,
        signer: admin.publicKey,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
        eventAuthority: deriveDammV2EventAuthority(),
        program: DAMM_V2_PROGRAM_ID,
      })
      .transaction();
    const { sendTransactionMaybeThrow } = await import("./utils/common");
    sendTransactionMaybeThrow(svm, badgeTx, [admin]);

    const migrationParams: MigrateMeteoraDammV2Params = {
      payer: admin,
      virtualPool,
      dammConfig,
      extraRemainingAccounts: [
        {
          isSigner: false,
          isWritable: false,
          pubkey: tokenBadge,
        },
      ],
    };

    await migrateToDammV2(svm, program, migrationParams);
  });

  it("✅ TransferHook program is nulled on mint after graduation", () => {
    const account = svm.getAccount(virtualPoolState.baseMint)!;
    const tlvData = Buffer.from(account.data.slice(ACCOUNT_SIZE + ACCOUNT_TYPE_SIZE));

    const hookData = getExtensionData(ExtensionType.TransferHook, tlvData);
    expect(hookData).to.not.be.null;

    const hookProgramId = new PublicKey(hookData!.subarray(32, 64));
    expect(hookProgramId.equals(PublicKey.default)).to.be.true;
    console.log("    ✅ TransferHook program is zeroed — hook disabled");
  });

  it("✅ TransferHook authority is nulled on mint after graduation", () => {
    const account = svm.getAccount(virtualPoolState.baseMint)!;
    const tlvData = Buffer.from(account.data.slice(ACCOUNT_SIZE + ACCOUNT_TYPE_SIZE));

    const hookData = getExtensionData(ExtensionType.TransferHook, tlvData);
    expect(hookData).to.not.be.null;

    const hookAuthority = new PublicKey(hookData!.subarray(0, 32));
    expect(hookAuthority.equals(PublicKey.default)).to.be.true;
    console.log("    ✅ TransferHook authority is zeroed — no one can re-enable");
  });
});
