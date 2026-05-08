/**
 * T-01: Ed25519 Security Tests (LiteSVM)
 *
 * Verifies that Ed25519 signature verification is correctly enforced
 * for LaunchAuth on initialize_virtual_pool_with_token2022.
 *
 * Prerequisites:
 *   cargo build-sbf -- --features local
 *   npx ts-mocha -t 120000 tests/ed25519_security.tests.ts
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import nacl from "tweetnacl";
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
import { buildEd25519Ix, serializeLaunchAuth } from "./utils/ed25519";
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

describe("T-01: Ed25519 Security", () => {
  let svm: LiteSVM;
  let admin: Keypair;
  let wrongSigner: Keypair;
  let poolCreator: Keypair;
  let config: PublicKey;
  let ipworldState: PublicKey;
  let program: VirtualCurveProgram;

  const quoteMint = NATIVE_MINT;

  before(async () => {
    svm = startSvm();
    admin = generateAndFund(svm);
    poolCreator = generateAndFund(svm);
    wrongSigner = generateAndFund(svm);
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

    const configParams = {
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
        collectFeeMode: 0,
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
      migratedPoolMarketCapFeeSchedulerParams: {
        numberOfPeriod: 0,
        sqrtPriceStepBps: 0,
        schedulerExpirationDuration: 0,
        reductionFactor: new BN(0),
      },
      padding: new Array(2).fill(0),
      curve: curves,
    };

    const createConfigTx = await program.methods
      .createConfig(configParams as any)
      .accountsPartial({
        config: configKP.publicKey,
        feeClaimer: admin.publicKey,
        quoteMint,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, createConfigTx, [admin, configKP]);
  });

  async function buildPoolCreateIx(baseMintKP: Keypair): Promise<{
    ix: import("@solana/web3.js").TransactionInstruction;
    pool: PublicKey;
  }> {
    const pool = derivePoolAddress(config, baseMintKP.publicKey, quoteMint);
    const baseVault = deriveTokenVaultAddress(baseMintKP.publicKey, pool);
    const quoteVault = deriveTokenVaultAddress(quoteMint, pool);

    const ix = await program.methods
      .initializeVirtualPoolWithToken2022({
        name: "Test Token",
        symbol: "TEST",
        uri: "https://example.com/meta.json",
      })
      .accountsPartial({
        config,
        baseMint: baseMintKP.publicKey,
        quoteMint,
        pool,
        payer: poolCreator.publicKey,
        creator: poolCreator.publicKey,
        poolAuthority: derivePoolAuthority(),
        baseVault,
        quoteVault,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        ipworldHookProgram: IPWORLD_HOOK_PROGRAM_ID,
        hookConfig: deriveHookConfigAddress(baseMintKP.publicKey),
        extraAccountMetaList: deriveExtraAccountMetaListAddress(baseMintKP.publicKey),
        ipworldState,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    return { ix, pool };
  }

  it("M-SEC-001: Valid Ed25519 signature passes verification", async () => {
    const baseMintKP = Keypair.generate();
    const { ix, pool } = await buildPoolCreateIx(baseMintKP);

    const authority = getSvmAuthority();
    const launchAuthMsg = serializeLaunchAuth(poolCreator.publicKey, config, pool);
    const ed25519Ix = buildEd25519Ix(authority, launchAuthMsg);

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ed25519Ix,
      ix
    );

    sendTransactionMaybeThrow(svm, tx, [poolCreator, baseMintKP]);

    const poolAccount = svm.getAccount(pool);
    expect(poolAccount).to.not.be.null;
    expect(new PublicKey(poolAccount!.owner).equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)).to.be.true;
  });

  it("M-SEC-002: Invalid signature rejected", async () => {
    const baseMintKP = Keypair.generate();
    const { ix, pool } = await buildPoolCreateIx(baseMintKP);

    const authority = getSvmAuthority();
    const launchAuthMsg = serializeLaunchAuth(poolCreator.publicKey, config, pool);
    const validSig = nacl.sign.detached(launchAuthMsg, authority.secretKey);
    const tamperedSig = Buffer.from(validSig);
    tamperedSig[0] = tamperedSig[0] ^ 0xff;

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: authority.publicKey.toBytes(),
      message: launchAuthMsg,
      signature: tamperedSig,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ed25519Ix,
      ix
    );

    let failed = false;
    try {
      sendTransactionMaybeThrow(svm, tx, [poolCreator, baseMintKP]);
    } catch {
      failed = true;
    }
    expect(failed, "Should have thrown — tampered signature").to.be.true;
  });

  it("M-SEC-003: Wrong authority key rejected", async () => {
    const baseMintKP = Keypair.generate();
    const { ix, pool } = await buildPoolCreateIx(baseMintKP);

    const launchAuthMsg = serializeLaunchAuth(poolCreator.publicKey, config, pool);
    const ed25519Ix = buildEd25519Ix(wrongSigner, launchAuthMsg);

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ed25519Ix,
      ix
    );

    let failed = false;
    try {
      sendTransactionMaybeThrow(svm, tx, [poolCreator, baseMintKP]);
    } catch (e: any) {
      failed = true;
      expect(e.message).to.match(/UnauthorizedSigner|custom program error/);
    }
    expect(failed, "Should have thrown — wrong signer").to.be.true;
  });

  it("M-SEC-004: Tampered message data rejected", async () => {
    const baseMintKP = Keypair.generate();
    const { ix, pool } = await buildPoolCreateIx(baseMintKP);

    const authority = getSvmAuthority();
    const originalMsg = serializeLaunchAuth(poolCreator.publicKey, config, pool);
    const validSig = nacl.sign.detached(originalMsg, authority.secretKey);

    // Tamper the message: replace creator pubkey with wrongSigner pubkey
    const tamperedMsg = Buffer.from(originalMsg);
    wrongSigner.publicKey.toBuffer().copy(tamperedMsg, 0);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: authority.publicKey.toBytes(),
      message: tamperedMsg,
      signature: Buffer.from(validSig),
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ed25519Ix,
      ix
    );

    let failed = false;
    try {
      sendTransactionMaybeThrow(svm, tx, [poolCreator, baseMintKP]);
    } catch {
      failed = true;
    }
    expect(failed, "Should have thrown — tampered message").to.be.true;
  });

  it("M-SEC-005: instruction_index attack blocked", async () => {
    // Send pool creation ix WITHOUT any Ed25519 instruction
    const baseMintKP = Keypair.generate();
    const { ix } = await buildPoolCreateIx(baseMintKP);

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix
    );

    let failed = false;
    try {
      sendTransactionMaybeThrow(svm, tx, [poolCreator, baseMintKP]);
    } catch (e: any) {
      failed = true;
      expect(e.message).to.match(/MissingEd25519Ix|InvalidEd25519Data|custom program error/);
    }
    expect(failed, "Should have thrown — no Ed25519 ix").to.be.true;
  });
});
