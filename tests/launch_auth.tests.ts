/**
 * Step 5 — Launch Auth enforcement tests (solana-test-validator)
 *
 * Proves pool creation requires a valid Ed25519 LaunchAuth signature.
 * Built with --features local (admin bypass) but WITHOUT skip-launch-auth.
 *
 * Prerequisites:
 *   1. cargo build-sbf -- --features local
 *   2. solana-test-validator \
 *        --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN target/deploy/dynamic_bonding_curve.so \
 *        --bpf-program HooK1111111111111111111111111111111111111111 target/deploy/ipworld_hook.so \
 *        --reset
 *   3. npx ts-mocha -t 120000 tests/launch_auth.tests.ts
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { createHash } from "crypto";
import nacl from "tweetnacl";
import VirtualCurveIDL from "../target/idl/dynamic_bonding_curve.json";
import { DynamicBondingCurve as VirtualCurve } from "../target/types/dynamic_bonding_curve";

const DBC_PROGRAM_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
const HOOK_PROGRAM_ID = new PublicKey("HooK1111111111111111111111111111111111111111");
const MAX_SQRT_PRICE = new BN("79226673515401279992447579055");
const MIN_SQRT_PRICE = new BN("4295048017");
const U64_MAX = new BN("18446744073709551615");

const connection = new Connection("http://127.0.0.1:8899", "confirmed");

// --- helpers ---

function anchorDisc(name: string): Buffer {
  return createHash("sha256").update(name).digest().subarray(0, 8);
}

async function airdrop(pubkey: PublicKey, sol: number) {
  const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

function derivePoolAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], DBC_PROGRAM_ID)[0];
}

function deriveIpworldState(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("ipworld_state")], DBC_PROGRAM_ID);
}

function getFirstKey(k1: PublicKey, k2: PublicKey): Buffer {
  const b1 = k1.toBuffer();
  const b2 = k2.toBuffer();
  return Buffer.compare(b1, b2) === 1 ? b1 : b2;
}

function getSecondKey(k1: PublicKey, k2: PublicKey): Buffer {
  const b1 = k1.toBuffer();
  const b2 = k2.toBuffer();
  return Buffer.compare(b1, b2) === 1 ? b2 : b1;
}

function derivePool(config: PublicKey, baseMint: PublicKey, quoteMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), config.toBuffer(), getFirstKey(baseMint, quoteMint), getSecondKey(baseMint, quoteMint)],
    DBC_PROGRAM_ID
  )[0];
}

function deriveTokenVault(mint: PublicKey, pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_vault"), mint.toBuffer(), pool.toBuffer()],
    DBC_PROGRAM_ID
  )[0];
}

function deriveHookConfig(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("hook_config"), mint.toBuffer()],
    HOOK_PROGRAM_ID
  )[0];
}

function deriveExtraAccountMetaList(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    HOOK_PROGRAM_ID
  )[0];
}

function serializeLaunchAuth(creator: PublicKey, config: PublicKey, poolPda: PublicKey): Buffer {
  return Buffer.concat([creator.toBuffer(), config.toBuffer(), poolPda.toBuffer()]);
}

describe("Step 5 — Launch Auth enforcement", () => {
  let admin: Keypair;
  let authority: Keypair;
  let poolCreator: Keypair;
  let wrongSigner: Keypair;
  let config: PublicKey;
  let ipworldState: PublicKey;
  let program: Program<VirtualCurve>;

  const quoteMint = NATIVE_MINT;

  before(async () => {
    admin = Keypair.generate();
    authority = Keypair.generate();
    poolCreator = Keypair.generate();
    wrongSigner = Keypair.generate();

    await airdrop(admin.publicKey, 50);
    await airdrop(poolCreator.publicKey, 50);

    // Anchor program client
    const wallet = new Wallet(admin);
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    program = new Program<VirtualCurve>(VirtualCurveIDL as VirtualCurve, provider);

    // 1. Init IpworldState with our authority
    [ipworldState] = deriveIpworldState();
    const initIx = new TransactionInstruction({
      programId: DBC_PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: ipworldState, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([anchorDisc("global:init_ipworld_state"), authority.publicKey.toBuffer()]),
    });
    await sendAndConfirmTransaction(connection, new Transaction().add(initIx), [admin]);

    // 2. Create operator (--features local bypasses admin check)
    const operatorPDA = PublicKey.findProgramAddressSync(
      [Buffer.from("operator"), admin.publicKey.toBuffer()],
      DBC_PROGRAM_ID
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
    await sendAndConfirmTransaction(connection, createOpTx, [admin]);

    // 3. Create config (full params matching IDL schema)
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
      collectFeeMode: 0,
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
        leftoverReceiver: admin.publicKey,
        quoteMint,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    await sendAndConfirmTransaction(connection, createConfigTx, [admin, configKP]);
  });

  // Helper: build pool creation instruction
  async function buildPoolCreateIx(baseMintKP: Keypair): Promise<{
    ix: TransactionInstruction;
    pool: PublicKey;
  }> {
    const pool = derivePool(config, baseMintKP.publicKey, quoteMint);
    const baseVault = deriveTokenVault(baseMintKP.publicKey, pool);
    const quoteVault = deriveTokenVault(quoteMint, pool);

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
        ipworldHookProgram: HOOK_PROGRAM_ID,
        hookConfig: deriveHookConfig(baseMintKP.publicKey),
        extraAccountMetaList: deriveExtraAccountMetaList(baseMintKP.publicKey),
        ipworldState,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    return { ix, pool };
  }

  it("❌ Pool creation WITHOUT Ed25519 ix fails (MissingEd25519Ix)", async () => {
    const baseMintKP = Keypair.generate();
    const { ix } = await buildPoolCreateIx(baseMintKP);

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix
    );

    try {
      await sendAndConfirmTransaction(connection, tx, [poolCreator, baseMintKP]);
      expect.fail("Should have thrown — no Ed25519 ix");
    } catch (e: any) {
      const logs = e.logs?.join("\n") || e.message || "";
      // Should contain our custom error
      expect(logs).to.match(/MissingEd25519Ix|custom program error/);
    }
  });

  it("❌ Pool creation with WRONG signer fails (UnauthorizedSigner)", async () => {
    const baseMintKP = Keypair.generate();
    const { ix, pool } = await buildPoolCreateIx(baseMintKP);

    // Sign LaunchAuth with wrong key
    const launchAuthMsg = serializeLaunchAuth(poolCreator.publicKey, config, pool);
    const wrongSig = nacl.sign.detached(launchAuthMsg, wrongSigner.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: wrongSigner.publicKey.toBytes(),
      message: launchAuthMsg,
      signature: Buffer.from(wrongSig),
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ed25519Ix,
      ix
    );

    try {
      await sendAndConfirmTransaction(connection, tx, [poolCreator, baseMintKP]);
      expect.fail("Should have thrown — wrong signer");
    } catch (e: any) {
      const logs = e.logs?.join("\n") || e.message || "";
      expect(logs).to.match(/UnauthorizedSigner|custom program error/);
    }
  });

  it("✅ Pool creation with valid LaunchAuth succeeds", async () => {
    const baseMintKP = Keypair.generate();
    const { ix, pool } = await buildPoolCreateIx(baseMintKP);

    // Sign LaunchAuth with the correct authority
    const launchAuthMsg = serializeLaunchAuth(poolCreator.publicKey, config, pool);
    const validSig = nacl.sign.detached(launchAuthMsg, authority.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: authority.publicKey.toBytes(),
      message: launchAuthMsg,
      signature: Buffer.from(validSig),
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ed25519Ix,
      ix
    );

    await sendAndConfirmTransaction(connection, tx, [poolCreator, baseMintKP]);

    // Verify pool was created
    const poolAccount = await connection.getAccountInfo(pool);
    expect(poolAccount).to.not.be.null;
    expect(poolAccount!.owner.equals(DBC_PROGRAM_ID)).to.be.true;
  });
});
