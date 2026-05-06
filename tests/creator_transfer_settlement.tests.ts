/**
 * T-07: Creator Transfer Settlement Tests (LiteSVM / solana-test-validator)
 *
 * Verifies that pool creator transfer enforces fee settlement:
 * - transfer_pool_creator is blocked when there are unclaimed creator fees
 * - transfer_pool_creator succeeds after all fees are claimed
 * - After transfer, the new creator starts with zero fee counters
 *
 * Prerequisites:
 *   cargo build-sbf -- --features local,skip-launch-auth
 *   solana-test-validator \
 *     --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN target/deploy/dynamic_bonding_curve.so \
 *     --bpf-program HooK1111111111111111111111111111111111111111 target/deploy/ipworld_hook.so \
 *     --reset
 *   npx ts-mocha -t 120000 tests/creator_transfer_settlement.tests.ts
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  Connection,
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
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
    [
      Buffer.from("pool"),
      config.toBuffer(),
      getFirstKey(baseMint, quoteMint),
      getSecondKey(baseMint, quoteMint),
    ],
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

function serializeTradeAuth(user: PublicKey, expiresAt: number): Buffer {
  const buf = Buffer.alloc(40);
  user.toBuffer().copy(buf, 0);
  buf.writeBigInt64LE(BigInt(expiresAt), 32);
  return buf;
}

// audit: F-016 — creator_share + claim_creator_trading_fee removed in Phase 3
describe.skip("T-07: Creator Transfer Settlement", () => {
  let admin: Keypair;
  let authority: Keypair;
  let creator: Keypair;
  let newCreator: Keypair;
  let trader: Keypair;
  let config: PublicKey;
  let pool: PublicKey;
  let baseMint: Keypair;
  let ipworldState: PublicKey;
  let program: Program<VirtualCurve>;

  const quoteMint = NATIVE_MINT;

  before(async () => {
    admin = Keypair.generate();
    authority = Keypair.generate();
    creator = Keypair.generate();
    newCreator = Keypair.generate();
    trader = Keypair.generate();

    await airdrop(admin.publicKey, 50);
    await airdrop(creator.publicKey, 10);
    await airdrop(newCreator.publicKey, 10);
    await airdrop(trader.publicKey, 50);

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

    // 3. Create config with creatorTradingFeePercentage > 0 to accumulate creator fees
    const curves = [];
    for (let i = 1; i <= 16; i++) {
      curves.push({
        sqrtPrice: i === 16 ? MAX_SQRT_PRICE : MAX_SQRT_PRICE.muln(i * 5).divn(100),
        liquidity: U64_MAX.shln(30 + i),
      });
    }
    const configKP = Keypair.generate();
    config = configKP.publicKey;

    const createConfigTx = await program.methods
      .createConfig({
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
        migrationQuoteThreshold: new BN(LAMPORTS_PER_SOL * 500),
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
        // Non-zero to accumulate creator fees on every swap
        creatorTradingFeePercentage: 5000, // 50% of base fee goes to creator
        tokenUpdateAuthority: 0,
        migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
        migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 0 },
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
        ipOwnerShare: 50000,
        airdropShare: 30000,
        referralShare: 20000,
        tokenAirdropShare: 50000,
        curve: curves,
      } as any)
      .accountsPartial({
        config: configKP.publicKey,
        feeClaimer: admin.publicKey,
        quoteMint,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    await sendAndConfirmTransaction(connection, createConfigTx, [admin, configKP]);

    // 4. Create pool with creator as the pool creator
    baseMint = Keypair.generate();
    pool = derivePool(config, baseMint.publicKey, quoteMint);
    const baseVault = deriveTokenVault(baseMint.publicKey, pool);
    const quoteVault = deriveTokenVault(quoteMint, pool);

    const createPoolTx = await program.methods
      .initializeVirtualPoolWithToken2022({
        name: "Creator Test",
        symbol: "CRTR",
        uri: "https://example.com",
      })
      .accountsPartial({
        config,
        baseMint: baseMint.publicKey,
        quoteMint,
        pool,
        payer: creator.publicKey,
        creator: creator.publicKey,
        poolAuthority: derivePoolAuthority(),
        baseVault,
        quoteVault,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        ipworldHookProgram: HOOK_PROGRAM_ID,
        hookConfig: deriveHookConfig(baseMint.publicKey),
        extraAccountMetaList: deriveExtraAccountMetaList(baseMint.publicKey),
        ipworldState,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .transaction();
    createPoolTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    await sendAndConfirmTransaction(connection, createPoolTx, [creator, baseMint]);

    // 5. Setup trader's token accounts and wrap SOL for trading
    const quoteAta = getAssociatedTokenAddressSync(quoteMint, trader.publicKey);
    const baseAta = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      trader.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    const setupTx = new Transaction();
    setupTx.add(
      createAssociatedTokenAccountInstruction(
        trader.publicKey,
        quoteAta,
        trader.publicKey,
        quoteMint
      ),
      createAssociatedTokenAccountInstruction(
        trader.publicKey,
        baseAta,
        trader.publicKey,
        baseMint.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      SystemProgram.transfer({
        fromPubkey: trader.publicKey,
        toPubkey: quoteAta,
        lamports: LAMPORTS_PER_SOL * 10,
      }),
      createSyncNativeInstruction(quoteAta)
    );
    await sendAndConfirmTransaction(connection, setupTx, [trader]);
  });

  async function buildSwapBuyIx(buyer: Keypair, amount: BN): Promise<TransactionInstruction> {
    // Build swap instruction for QuoteToBase (buy direction)
    // Use swap2 with PartialFill mode (swapMode=1) and a valid TradeAuth
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const tradeAuthMsg = serializeTradeAuth(buyer.publicKey, expiresAt);
    const sig = nacl.sign.detached(tradeAuthMsg, authority.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: authority.publicKey.toBytes(),
      message: tradeAuthMsg,
      signature: Buffer.from(sig),
    });

    const swapIx = await program.methods
      .swap2({ amount0: amount, amount1: new BN(0), swapMode: 1 })
      .accountsPartial({
        poolAuthority: derivePoolAuthority(),
        config,
        pool,
        inputTokenAccount: getAssociatedTokenAddressSync(quoteMint, buyer.publicKey),
        outputTokenAccount: getAssociatedTokenAddressSync(
          baseMint.publicKey,
          buyer.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        ),
        baseVault: deriveTokenVault(baseMint.publicKey, pool),
        quoteVault: deriveTokenVault(quoteMint, pool),
        baseMint: baseMint.publicKey,
        quoteMint,
        payer: buyer.publicKey,
        tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: null,
        ipworldState,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts([
        { isSigner: false, isWritable: false, pubkey: SYSVAR_INSTRUCTIONS_PUBKEY },
        { isSigner: false, isWritable: false, pubkey: HOOK_PROGRAM_ID },
        { isSigner: false, isWritable: false, pubkey: deriveExtraAccountMetaList(baseMint.publicKey) },
        { isSigner: false, isWritable: false, pubkey: deriveHookConfig(baseMint.publicKey) },
      ])
      .instruction();

    // Return a compound instruction structure — caller must send [ComputeBudget, ed25519Ix, swapIx]
    // We return a helper object; tests must include ed25519Ix themselves
    // For simplicity, embed ed25519Ix in the return via a wrapper transaction approach
    // Actually: just return the swap ix and let performSwapsToAccumulateFees handle the Ed25519
    void ed25519Ix; // ed25519 is built inline in performSwapsToAccumulateFees
    return swapIx;
  }

  async function performSwapsToAccumulateFees(): Promise<void> {
    // Perform several buy swaps to accumulate creator_quote_fee in the pool state
    for (let i = 0; i < 3; i++) {
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      const tradeAuthMsg = serializeTradeAuth(trader.publicKey, expiresAt);
      const sig = nacl.sign.detached(tradeAuthMsg, authority.secretKey);
      const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
        publicKey: authority.publicKey.toBytes(),
        message: tradeAuthMsg,
        signature: Buffer.from(sig),
      });

      const swapIx = await buildSwapBuyIx(trader, new BN(LAMPORTS_PER_SOL * 0.1));

      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ed25519Ix,
        swapIx
      );
      await sendAndConfirmTransaction(connection, tx, [trader]);
    }
  }

  it("M-CRT-001: Transfer blocked with unclaimed fees", async () => {
    // Accumulate creator fees via several swaps
    await performSwapsToAccumulateFees();

    // Attempt transfer_pool_creator WITHOUT claiming fees first
    try {
      const transferTx = await program.methods
        .transferPoolCreator()
        .accountsPartial({
          virtualPool: pool,
          config,
          creator: creator.publicKey,
          newCreator: newCreator.publicKey,
        })
        .transaction();

      await sendAndConfirmTransaction(connection, transferTx, [creator]);
      expect.fail("Should have thrown — unclaimed fees");
    } catch (e: any) {
      const logs = e.logs?.join("\n") || e.message || "";
      expect(logs).to.match(/UnclaimedFees|custom program error/);
    }
  });

  it("M-CRT-002: Transfer succeeds after claiming fees", async () => {
    // Setup creator's token accounts for receiving claimed fees
    const creatorBaseAta = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      creator.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const creatorQuoteAta = getAssociatedTokenAddressSync(quoteMint, creator.publicKey);

    const setupAtaTx = new Transaction();
    setupAtaTx.add(
      createAssociatedTokenAccountInstruction(
        admin.publicKey,
        creatorBaseAta,
        creator.publicKey,
        baseMint.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        admin.publicKey,
        creatorQuoteAta,
        creator.publicKey,
        quoteMint
      )
    );
    await sendAndConfirmTransaction(connection, setupAtaTx, [admin]);

    const baseVault = deriveTokenVault(baseMint.publicKey, pool);
    const quoteVault = deriveTokenVault(quoteMint, pool);

    // Claim all creator trading fees
    // SPEC-DBC-004 Phase 3: claimCreatorTradingFee removed from IDL.
    // describe.skip on this suite means this branch never executes; cast preserves
    // TS compilation against the new IDL.
    const claimTx = await (program.methods as any)
      .claimCreatorTradingFee(new BN("18446744073709551615"), new BN("18446744073709551615"))
      .accountsPartial({
        poolAuthority: derivePoolAuthority(),
        pool,
        tokenAAccount: creatorBaseAta,
        tokenBAccount: creatorQuoteAta,
        baseVault,
        quoteVault,
        baseMint: baseMint.publicKey,
        quoteMint,
        creator: creator.publicKey,
        tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
      })
      .transaction();
    await sendAndConfirmTransaction(connection, claimTx, [creator]);

    // Now transfer_pool_creator should succeed
    const transferTx = await program.methods
      .transferPoolCreator()
      .accountsPartial({
        virtualPool: pool,
        config,
        creator: creator.publicKey,
        newCreator: newCreator.publicKey,
      })
      .transaction();
    await sendAndConfirmTransaction(connection, transferTx, [creator]);

    // Verify pool.creator == newCreator.publicKey
    // The creator field is stored in VirtualPool account data
    const poolAccount = await connection.getAccountInfo(pool);
    expect(poolAccount).to.not.be.null;
    // Use Anchor to fetch and decode the pool
    const poolData = await program.account.virtualPool.fetch(pool);
    expect((poolData as any).creator.equals(newCreator.publicKey)).to.be.true;
  });

  it("M-CRT-003: New creator starts with zero fees", async () => {
    // Prerequisite: M-CRT-002 completed — pool.creator is now newCreator

    // Fetch pool state and verify creator_quote_fee is 0 after transfer
    const poolData = await program.account.virtualPool.fetch(pool);
    expect((poolData as any).creator.equals(newCreator.publicKey)).to.be.true;
    // creator_quote_fee should be 0 immediately after transfer
    expect((poolData as any).creatorQuoteFee.toNumber()).to.equal(0);

    // Perform additional swaps to accumulate new fees for newCreator
    await performSwapsToAccumulateFees();

    // Verify new fees accumulated (pool.creator_quote_fee > 0 for newCreator)
    const poolDataAfterSwaps = await program.account.virtualPool.fetch(pool);
    // The fees now belong to newCreator — old creator can no longer claim them
    expect((poolDataAfterSwaps as any).creator.equals(newCreator.publicKey)).to.be.true;

    // Old creator attempting to claim should fail (has_one = creator check)
    const oldCreatorBaseAta = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      creator.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const oldCreatorQuoteAta = getAssociatedTokenAddressSync(quoteMint, creator.publicKey);

    try {
      const claimAsOldCreatorTx = await (program.methods as any)
        .claimCreatorTradingFee(new BN("18446744073709551615"), new BN("18446744073709551615"))
        .accountsPartial({
          poolAuthority: derivePoolAuthority(),
          pool,
          tokenAAccount: oldCreatorBaseAta,
          tokenBAccount: oldCreatorQuoteAta,
          baseVault: deriveTokenVault(baseMint.publicKey, pool),
          quoteVault: deriveTokenVault(quoteMint, pool),
          baseMint: baseMint.publicKey,
          quoteMint,
          creator: creator.publicKey,
          tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
          tokenQuoteProgram: TOKEN_PROGRAM_ID,
        })
        .transaction();
      await sendAndConfirmTransaction(connection, claimAsOldCreatorTx, [creator]);
      expect.fail("Old creator should not be able to claim fees");
    } catch (e: any) {
      const logs = e.logs?.join("\n") || e.message || "";
      // has_one = creator constraint should reject this
      expect(logs).to.match(/has_one|custom program error|A has one constraint was violated/i);
    }
  });
});
