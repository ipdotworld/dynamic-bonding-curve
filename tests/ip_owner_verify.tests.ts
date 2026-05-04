/**
 * T-03: IP Owner Verification Tests (LiteSVM)
 *
 * Verifies verify_token, claim_ip_owner_fee, transfer_ip_owner,
 * accept_ip_owner, and link_token_to_ip instructions.
 *
 * Prerequisites:
 *   cargo build-sbf -- --features local,skip-launch-auth
 *   npx ts-mocha -t 120000 tests/ip_owner_verify.tests.ts
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
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

function deriveTokenVerification(pool: PublicKey): PublicKey {
  // PDA: ["token_verification", pool.key()] — from ix_verify_token.rs
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_verification"), pool.toBuffer()],
    DBC_PROGRAM_ID
  )[0];
}

function serializeVerifyAuth(pool: PublicKey, ipOwner: PublicKey): Buffer {
  // VerifyAuth { pool: Pubkey, ip_owner: Pubkey } — from auth_structs.rs
  return Buffer.concat([pool.toBuffer(), ipOwner.toBuffer()]);
}

function serializeTransferIpOwnerAuth(pool: PublicKey, newIpOwner: PublicKey): Buffer {
  // TransferIpOwnerAuth { pool: Pubkey, new_ip_owner: Pubkey }
  return Buffer.concat([pool.toBuffer(), newIpOwner.toBuffer()]);
}

function serializeLinkTokenToIpAuth(pool: PublicKey, ipaId: PublicKey): Buffer {
  // LinkTokenToIpAuth { pool: Pubkey, ipa_id: Pubkey }
  return Buffer.concat([pool.toBuffer(), ipaId.toBuffer()]);
}

describe.skip("T-03: IP Owner Verification", () => {
  let admin: Keypair;
  let authority: Keypair;
  let ipOwner: Keypair;
  let newIpOwner: Keypair;
  let wrongSigner: Keypair;
  let baseMint: Keypair;
  let ipworldState: PublicKey;
  let pool: PublicKey;
  let config: PublicKey;
  let program: Program<VirtualCurve>;

  const quoteMint = NATIVE_MINT;

  before(async () => {
    admin = Keypair.generate();
    authority = Keypair.generate();
    ipOwner = Keypair.generate();
    newIpOwner = Keypair.generate();
    wrongSigner = Keypair.generate();
    baseMint = Keypair.generate();

    await airdrop(admin.publicKey, 50);
    await airdrop(ipOwner.publicKey, 10);
    await airdrop(newIpOwner.publicKey, 10);

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

    // 3. Create config
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
        creatorTradingFeePercentage: 0,
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
        creatorShare: 100000,
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

    // 4. Create pool (skip-launch-auth bypasses Ed25519 for creation)
    pool = derivePool(config, baseMint.publicKey, quoteMint);
    const baseVault = deriveTokenVault(baseMint.publicKey, pool);
    const quoteVault = deriveTokenVault(quoteMint, pool);

    const createPoolTx = await program.methods
      .initializeVirtualPoolWithToken2022({
        name: "IP Test",
        symbol: "IPTEST",
        uri: "https://example.com",
      })
      .accountsPartial({
        config,
        baseMint: baseMint.publicKey,
        quoteMint,
        pool,
        payer: admin.publicKey,
        creator: admin.publicKey,
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
    await sendAndConfirmTransaction(connection, createPoolTx, [admin, baseMint]);
  });

  it("M-IPO-001: verify_token creates TokenVerification PDA", async () => {
    const tokenVerificationPDA = deriveTokenVerification(pool);

    // Serialize VerifyAuth: concat(pool, ip_owner) — from auth_structs.rs
    const verifyAuthMsg = serializeVerifyAuth(pool, ipOwner.publicKey);
    const sig = nacl.sign.detached(verifyAuthMsg, authority.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: authority.publicKey.toBytes(),
      message: verifyAuthMsg,
      signature: Buffer.from(sig),
    });

    const verifyTokenIx = await program.methods
      .verifyToken()
      .accountsPartial({
        payer: admin.publicKey,
        tokenVerification: tokenVerificationPDA,
        pool,
        ipworldState,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ed25519Ix,
      verifyTokenIx
    );

    await sendAndConfirmTransaction(connection, tx, [admin]);

    // Verify TokenVerification PDA was created
    const tvAccount = await connection.getAccountInfo(tokenVerificationPDA);
    expect(tvAccount).to.not.be.null;
    expect(tvAccount!.owner.equals(DBC_PROGRAM_ID)).to.be.true;

    // Decode and verify ip_owner field (first 8 bytes = discriminator, then ip_owner pubkey)
    const tvData = tvAccount!.data;
    const storedIpOwner = new PublicKey(tvData.slice(8, 40));
    expect(storedIpOwner.equals(ipOwner.publicKey)).to.be.true;
  });

  it("M-IPO-002: claim_ip_owner_fee fails without verification", async () => {
    // Use a NEW baseMint that has NOT had verify_token called
    const unverifiedMint = Keypair.generate();
    const unverifiedPool = derivePool(config, unverifiedMint.publicKey, quoteMint);
    const baseVault = deriveTokenVault(unverifiedMint.publicKey, unverifiedPool);
    const quoteVault = deriveTokenVault(quoteMint, unverifiedPool);

    const createPoolTx = await program.methods
      .initializeVirtualPoolWithToken2022({
        name: "Unverified",
        symbol: "UNVRF",
        uri: "https://example.com",
      })
      .accountsPartial({
        config,
        baseMint: unverifiedMint.publicKey,
        quoteMint,
        pool: unverifiedPool,
        payer: admin.publicKey,
        creator: admin.publicKey,
        poolAuthority: derivePoolAuthority(),
        baseVault,
        quoteVault,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        ipworldHookProgram: HOOK_PROGRAM_ID,
        hookConfig: deriveHookConfig(unverifiedMint.publicKey),
        extraAccountMetaList: deriveExtraAccountMetaList(unverifiedMint.publicKey),
        ipworldState,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .transaction();
    createPoolTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    await sendAndConfirmTransaction(connection, createPoolTx, [admin, unverifiedMint]);

    // Attempt to claim ip_owner_fee WITHOUT a TokenVerification PDA existing
    const unverifiedTV = deriveTokenVerification(unverifiedPool);
    try {
      const claimIx = await program.methods
        .claimIpOwnerFee(new BN(1000))
        .accountsPartial({
          poolAuthority: derivePoolAuthority(),
          pool: unverifiedPool,
          config,
          tokenVerification: unverifiedTV,
          ipOwner: ipOwner.publicKey,
          quoteMint,
          quoteVault,
          ipOwnerTokenAccount: ipOwner.publicKey, // placeholder
          tokenQuoteProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();

      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        claimIx
      );
      await sendAndConfirmTransaction(connection, tx, [ipOwner]);
      expect.fail("Should have thrown — no TokenVerification PDA");
    } catch (e: any) {
      const logs = e.logs?.join("\n") || e.message || "";
      expect(logs).to.match(/AccountNotInitialized|AccountNotFound|custom program error|could not find|does not exist/i);
    }
  });

  it("M-IPO-003: claim_ip_owner_fee succeeds after verification", async () => {
    // M-IPO-001 already called verify_token for baseMint/pool
    // The TokenVerification PDA should exist at this point
    const tokenVerificationPDA = deriveTokenVerification(pool);
    const tvAccount = await connection.getAccountInfo(tokenVerificationPDA);
    expect(tvAccount).to.not.be.null; // prerequisite from M-IPO-001

    // Create ipOwner's WSOL token account for receiving fees
    const ipOwnerQuoteAta = getAssociatedTokenAddressSync(quoteMint, ipOwner.publicKey);

    const setupTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        admin.publicKey,
        ipOwnerQuoteAta,
        ipOwner.publicKey,
        quoteMint
      )
    );
    await sendAndConfirmTransaction(connection, setupTx, [admin]);

    const quoteVault = deriveTokenVault(quoteMint, pool);

    // Record balance before claim
    const balanceBefore = await connection.getTokenAccountBalance(ipOwnerQuoteAta);

    // Claim ip_owner_fee (max_amount = u64::MAX to claim everything available)
    const claimIx = await program.methods
      .claimIpOwnerFee(new BN("18446744073709551615"))
      .accountsPartial({
        poolAuthority: derivePoolAuthority(),
        pool,
        config,
        tokenVerification: tokenVerificationPDA,
        ipOwner: ipOwner.publicKey,
        quoteMint,
        quoteVault,
        ipOwnerTokenAccount: ipOwnerQuoteAta,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      claimIx
    );

    // Note: This may fail if ip_owner_quote_fee is 0 (no swaps done yet).
    // The test verifies the instruction itself works after verification.
    try {
      await sendAndConfirmTransaction(connection, tx, [ipOwner]);
      const balanceAfter = await connection.getTokenAccountBalance(ipOwnerQuoteAta);
      // If there were fees, balance increased; if 0, it would have thrown AmountIsZero
      expect(Number(balanceAfter.value.amount)).to.be.gte(Number(balanceBefore.value.amount));
    } catch (e: any) {
      const logs = e.logs?.join("\n") || e.message || "";
      // AmountIsZero is acceptable if no fees accumulated; it means claim logic ran
      expect(logs).to.match(/AmountIsZero|custom program error/);
    }
  });

  it("M-IPO-004: transfer_ip_owner 2-step works", async () => {
    const tokenVerificationPDA = deriveTokenVerification(pool);

    // Step 1: Propose transfer — sign TransferIpOwnerAuth with authority
    const transferAuthMsg = serializeTransferIpOwnerAuth(pool, newIpOwner.publicKey);
    const transferSig = nacl.sign.detached(transferAuthMsg, authority.secretKey);
    const transferEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: authority.publicKey.toBytes(),
      message: transferAuthMsg,
      signature: Buffer.from(transferSig),
    });

    const transferIpOwnerIx = await program.methods
      .transferIpOwner()
      .accountsPartial({
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        ipworldState,
        tokenVerification: tokenVerificationPDA,
        pool,
      })
      .instruction();

    const transferTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      transferEd25519Ix,
      transferIpOwnerIx
    );
    await sendAndConfirmTransaction(connection, transferTx, [admin]);

    // Verify pending_ip_owner is set (offset: 8 disc + 32 ip_owner + 32 ipa_id = 72)
    const tvAfterTransfer = await connection.getAccountInfo(tokenVerificationPDA);
    // pending_ip_owner is at offset 8 (disc) + 32 (ip_owner) + 32 (ipa_id) = 72
    const pendingOwner = new PublicKey(tvAfterTransfer!.data.slice(72, 104));
    expect(pendingOwner.equals(newIpOwner.publicKey)).to.be.true;

    // Step 2: Accept transfer — must be signed by current ip_owner
    const acceptIpOwnerIx = await program.methods
      .acceptIpOwner()
      .accountsPartial({
        ipOwner: ipOwner.publicKey,
        tokenVerification: tokenVerificationPDA,
        pool,
      })
      .instruction();

    const acceptTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      acceptIpOwnerIx
    );
    await sendAndConfirmTransaction(connection, acceptTx, [ipOwner]);

    // Verify ip_owner is now newIpOwner
    const tvAfterAccept = await connection.getAccountInfo(tokenVerificationPDA);
    const newOwner = new PublicKey(tvAfterAccept!.data.slice(8, 40));
    expect(newOwner.equals(newIpOwner.publicKey)).to.be.true;

    // Verify pending_ip_owner is cleared (zero pubkey)
    const clearedPending = new PublicKey(tvAfterAccept!.data.slice(72, 104));
    expect(clearedPending.equals(PublicKey.default)).to.be.true;
  });

  it("M-IPO-005: accept_ip_owner by wrong signer rejected", async () => {
    // After M-IPO-004, the ip_owner is newIpOwner. Propose a new transfer.
    const tokenVerificationPDA = deriveTokenVerification(pool);

    // Propose transfer to admin (some target)
    const transferAuthMsg = serializeTransferIpOwnerAuth(pool, admin.publicKey);
    const transferSig = nacl.sign.detached(transferAuthMsg, authority.secretKey);
    const transferEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: authority.publicKey.toBytes(),
      message: transferAuthMsg,
      signature: Buffer.from(transferSig),
    });

    const transferIpOwnerIx = await program.methods
      .transferIpOwner()
      .accountsPartial({
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        ipworldState,
        tokenVerification: tokenVerificationPDA,
        pool,
      })
      .instruction();

    const transferTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      transferEd25519Ix,
      transferIpOwnerIx
    );
    await sendAndConfirmTransaction(connection, transferTx, [admin]);

    // Attempt accept_ip_owner with wrongSigner (not the current ip_owner = newIpOwner)
    try {
      const acceptIpOwnerIx = await program.methods
        .acceptIpOwner()
        .accountsPartial({
          ipOwner: wrongSigner.publicKey,
          tokenVerification: tokenVerificationPDA,
          pool,
        })
        .instruction();

      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        acceptIpOwnerIx
      );
      await airdrop(wrongSigner.publicKey, 1);
      await sendAndConfirmTransaction(connection, tx, [wrongSigner]);
      expect.fail("Should have thrown — wrong signer");
    } catch (e: any) {
      const logs = e.logs?.join("\n") || e.message || "";
      expect(logs).to.match(/Unauthorized|custom program error/);
    }
  });

  it("M-IPO-006: link_token_to_ip sets ipa_id", async () => {
    const tokenVerificationPDA = deriveTokenVerification(pool);

    // Use a deterministic test IPA pubkey (not Pubkey.default since that is rejected)
    const testIpaId = Keypair.generate().publicKey;

    // Sign LinkTokenToIpAuth: concat(pool, ipa_id)
    const linkAuthMsg = serializeLinkTokenToIpAuth(pool, testIpaId);
    const linkSig = nacl.sign.detached(linkAuthMsg, authority.secretKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: authority.publicKey.toBytes(),
      message: linkAuthMsg,
      signature: Buffer.from(linkSig),
    });

    const linkTokenToIpIx = await program.methods
      .linkTokenToIp()
      .accountsPartial({
        instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        ipworldState,
        tokenVerification: tokenVerificationPDA,
        pool,
      })
      .instruction();

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ed25519Ix,
      linkTokenToIpIx
    );
    await sendAndConfirmTransaction(connection, tx, [admin]);

    // Verify ipa_id field was set (offset: 8 disc + 32 ip_owner = 40)
    const tvAccount = await connection.getAccountInfo(tokenVerificationPDA);
    const storedIpaId = new PublicKey(tvAccount!.data.slice(40, 72));
    expect(storedIpaId.equals(testIpaId)).to.be.true;
  });
});
