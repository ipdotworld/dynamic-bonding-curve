/**
 * SPEC-DBC-AUDIT-001 — IP-owner vault cross-pool spoof rejection (LiteSVM)
 *
 * THE CRITICAL FUND-DRAIN FIX (REQ-E-004 / SEC-P2-01).
 *
 * The vault is keyed only by `token_mint` (the quote mint), which carries no link
 * to the pool whose `TokenVerification.ip_owner` may drain it. Before the fix, an
 * attacker who is the verified ip_owner of THEIR OWN pool_B could present a
 * self-consistent `(canonical(pool_B), pool_B, TokenVerification_B)` triple to
 * `claim_vested` against a vault funded by pool_A and drain it. The fix records the
 * authorizing pool on first deposit (`vault.pool`) and binds `pool == vault.pool`
 * on every claim → the cross-pool claim now reverts with `PoolMismatch`.
 *
 * This file supersedes the quarantined `ip_owner_vault_flow.tests.ts` (which used a
 * synthetic mint with `authority: payer` and no pool/TV wiring, so every call failed
 * account validation against the post-audit account set).
 *
 * IMPORTANT — the vault is DORMANT on-chain. As of REQ-C-001 the IP-owner QUOTE fee
 * is paid immediately at `claim_ip_owner_fee`; DBC no longer CPIs into
 * `distribute_to_vault` (grep confirms zero call sites). `distribute_to_vault` still
 * exists and is gated to `authority == DBC pool_authority` (a PDA only DBC can sign
 * for via invoke_signed), so the legit deposit path is NOT drivable from a TS test.
 * We therefore fund vault_A by writing its `Vault` account + a funded vault-ATA
 * DIRECTLY via svm.setAccount() with `vault.pool == poolA` — exactly the on-chain
 * state a legit pool_authority-gated deposit would have produced — then exercise the
 * claim-side guards, which is where the SEC-P2-01 drain check lives.
 *
 * Error codes (programs/ip-owner-vault/src/error.rs, Anchor 6000 + index):
 *   Unauthorized = 6002, TokenVerificationWrongOwner = 6006, PoolMismatch = 6010.
 *
 * Build: anchor build -p dynamic_bonding_curve -- --features local
 * Run:   yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/ip_owner_vault.tests.ts
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  MintLayout,
  AccountLayout as TokenAccountLayout,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { createHash } from "crypto";

import IpOwnerVaultIDL from "../target/idl/ip_owner_vault.json";
import { IpOwnerVault } from "../target/types/ip_owner_vault";
import { Program } from "@coral-xyz/anchor";
import {
  BaseFee,
  ConfigParameters,
  createConfig,
  createOperatorAccount,
  createPoolWithToken2022,
  OperatorPermission,
} from "./instructions";
import {
  createVirtualCurveProgram,
  generateAndFund,
  sendTransactionMaybeThrow,
  startSvm,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  U64_MAX,
} from "./utils";
import {
  deriveOperatorAddress,
  deriveTokenVerificationAddress,
} from "./utils/accounts";
import { getVirtualPool } from "./utils/fetcher";
import { VirtualCurveProgram } from "./utils/types";
import { IP_OWNER_VAULT_PROGRAM_ID } from "./utils/constants";

const VESTING_VAULT_SEED = Buffer.from("vesting");
const VESTING_DURATION_SECONDS = 180 * 86_400; // REQ-C-001
const VAULT_DISCRIMINATOR = createHash("sha256").update("account:Vault").digest().subarray(0, 8);

// VaultError discriminants (6000 + variant index, current ordering).
const ERR_UNAUTHORIZED = "Unauthorized";
const ERR_WRONG_OWNER = "TokenVerificationWrongOwner";
const ERR_POOL_MISMATCH = "PoolMismatch";

function deriveVaultPda(tokenMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VESTING_VAULT_SEED, tokenMint.toBuffer()],
    IP_OWNER_VAULT_PROGRAM_ID
  );
}

function makeVaultProgram(): Program<IpOwnerVault> {
  // LiteSVM short-circuits RPC; we only use the typed `.methods` builder.
  // Pass null provider — Program tolerates it for instruction building.
  return new Program<IpOwnerVault>(IpOwnerVaultIDL as IpOwnerVault, {
    connection: { rpcEndpoint: "http://localhost:8899" },
  } as any);
}

function token2022Config(): ConfigParameters {
  const baseFee: BaseFee = {
    cliffFeeNumerator: new BN(2_500_000),
    firstFactor: 0,
    secondFactor: new BN(0),
    thirdFactor: new BN(0),
    baseFeeMode: 0,
  };
  const curve = [];
  for (let i = 1; i <= 16; i++) {
    curve.push({
      sqrtPrice: i === 16 ? MAX_SQRT_PRICE : MAX_SQRT_PRICE.muln(i * 5).divn(100),
      liquidity: U64_MAX.shln(30 + i),
    });
  }
  return {
    poolFees: { baseFee, dynamicFee: null },
    activationType: 0,
    collectFeeMode: 1,
    migrationOption: 1,
    tokenType: 1,
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
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    migratedPoolFee: { collectFeeMode: 1, dynamicFee: 0, poolFeeBps: 0 },
    creatorLiquidityVestingInfo: { vestingPercentage: 0, cliffDurationFromMigrationTime: 0, bpsPerPeriod: 0, numberOfPeriods: 0, frequency: 0 },
    partnerLiquidityVestingInfo: { vestingPercentage: 0, cliffDurationFromMigrationTime: 0, bpsPerPeriod: 0, numberOfPeriods: 0, frequency: 0 },
    poolCreationFee: new BN(0),
    curve,
    enableFirstSwapWithMinFee: false,
    compoundingFeeBps: 0,
    migratedPoolBaseFeeMode: 0,
    migratedPoolMarketCapFeeSchedulerParams: null,
  };
}

describe("SPEC-DBC-AUDIT-001 — vault cross-pool spoof rejection (REQ-E-004 / SEC-P2-01)", () => {
  let svm: LiteSVM;
  let program: VirtualCurveProgram;
  let vaultProgram: Program<IpOwnerVault>;
  let admin: Keypair;
  let partner: Keypair;
  let creatorA: Keypair;
  let creatorB: Keypair;
  let verifyOperator: Keypair;

  // userA is the legit ip_owner of pool A; attacker is the ip_owner of THEIR pool B.
  let userA: Keypair;
  let attacker: Keypair;
  let payer: Keypair;

  let poolA: PublicKey;
  let poolB: PublicKey;
  let tvA: PublicKey;
  let tvB: PublicKey;

  // A real quote-side mint that vault_A accumulates (stand-in for the quote token).
  let vaultMint: PublicKey;
  let vaultPda: PublicKey;
  let vaultBump: number;
  let vaultAta: PublicKey;

  const DEPOSITED = 1_000_000_000n; // 1e9 base units seeded into the vault

  before(async () => {
    svm = startSvm();
    program = createVirtualCurveProgram();
    vaultProgram = makeVaultProgram();
    admin = generateAndFund(svm);
    partner = generateAndFund(svm);
    creatorA = generateAndFund(svm);
    creatorB = generateAndFund(svm);
    verifyOperator = generateAndFund(svm);
    userA = generateAndFund(svm);
    attacker = generateAndFund(svm);
    payer = generateAndFund(svm);

    // Operator that can verify_token (bit 2).
    await createOperatorAccount(svm, program, {
      admin,
      whitelistedAddress: verifyOperator.publicKey,
      permissions: [OperatorPermission.VerifyToken],
    });

    // ── Two REAL DBC pools (distinct configs so the pool addresses differ) ──────
    const configA = await createConfig(svm, program, {
      payer: partner,
      feeClaimer: partner.publicKey,
      quoteMint: NATIVE_MINT,
      instructionParams: token2022Config(),
    });
    const configB = await createConfig(svm, program, {
      payer: partner,
      feeClaimer: partner.publicKey,
      quoteMint: NATIVE_MINT,
      instructionParams: token2022Config(),
    });
    poolA = await createPoolWithToken2022(svm, program, {
      poolCreator: creatorA,
      payer: creatorA,
      quoteMint: NATIVE_MINT,
      config: configA,
      instructionParams: { name: "Pool A", symbol: "PLA", uri: "x" },
    });
    poolB = await createPoolWithToken2022(svm, program, {
      poolCreator: creatorB,
      payer: creatorB,
      quoteMint: NATIVE_MINT,
      config: configB,
      instructionParams: { name: "Pool B", symbol: "PLB", uri: "x" },
    });
    expect(poolA.toBase58()).to.not.equal(poolB.toBase58());

    // ── verify_token each: TV[poolA].ip_owner = userA, TV[poolB].ip_owner = attacker ──
    tvA = deriveTokenVerificationAddress(poolA);
    tvB = deriveTokenVerificationAddress(poolB);
    for (const [pool, tv, owner] of [
      [poolA, tvA, userA.publicKey],
      [poolB, tvB, attacker.publicKey],
    ] as [PublicKey, PublicKey, PublicKey][]) {
      const tx = await program.methods
        .verifyToken(owner)
        .accountsPartial({
          payer: verifyOperator.publicKey,
          tokenVerification: tv,
          pool,
          operator: deriveOperatorAddress(verifyOperator.publicKey),
          signer: verifyOperator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .transaction();
      sendTransactionMaybeThrow(svm, tx, [verifyOperator]);
    }

    // ── Build vault_A funded for poolA via direct setAccount (vault is dormant) ──
    vaultMint = createSplMint(svm, payer, 6);
    [vaultPda, vaultBump] = deriveVaultPda(vaultMint);
    vaultAta = getAssociatedTokenAddressSync(vaultMint, vaultPda, true, TOKEN_PROGRAM_ID);

    // 1) Create + fund the vault-owned ATA with the deposited tokens.
    createAtaFor(svm, payer, vaultMint, vaultPda);
    mintTo(svm, payer, vaultMint, vaultAta, DEPOSITED);

    // 2) Write the Vault PDA account bound to poolA, fully vested (clock far in the
    //    past) so a legit claim releases the full balance. Layout:
    //    8 disc + 32 token_mint + 8 total_deposited + 8 total_claimed +
    //    8 vesting_start(i64) + 1 bump + 32 pool + 31 padding = 128 bytes.
    writeVaultAccount(svm, vaultPda, {
      tokenMint: vaultMint,
      totalDeposited: DEPOSITED,
      totalClaimed: 0n,
      // vesting_start in the past so the full duration has elapsed at the current clock.
      vestingStart: BigInt(svm.getClock().unixTimestamp) - BigInt(VESTING_DURATION_SECONDS + 10),
      bump: vaultBump,
      pool: poolA,
    });
  });

  it("POSITIVE: the legit IP owner (userA) claims vested from vault_A with (poolA, TV[poolA]) — SUCCEEDS", async () => {
    const claimerAta = createAtaFor(svm, payer, vaultMint, userA.publicKey);
    const before = readAmount(svm, claimerAta);

    const tx = await vaultProgram.methods
      .claimVested()
      .accountsPartial({
        vault: vaultPda,
        tokenMint: vaultMint,
        vaultTokenAccount: vaultAta,
        claimerTokenAccount: claimerAta,
        claimer: userA.publicKey,
        pool: poolA,
        tokenVerification: tvA,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, tx, [userA]);

    // Fully vested → entire deposit released to userA.
    const after = readAmount(svm, claimerAta);
    expect(after - before).to.equal(DEPOSITED);
    expect(readAmount(svm, vaultAta)).to.equal(0n);
  });

  it("NEGATIVE (THE DRAIN): attacker claims vault_A with vault=vault_A but pool=poolB + TV[poolB] — MUST revert (PoolMismatch)", async () => {
    // Re-seed vault_A so this test is independent of the positive test's drain.
    mintTo(svm, payer, vaultMint, vaultAta, DEPOSITED);
    writeVaultAccount(svm, vaultPda, {
      tokenMint: vaultMint,
      totalDeposited: DEPOSITED,
      totalClaimed: 0n,
      vestingStart: BigInt(svm.getClock().unixTimestamp) - BigInt(VESTING_DURATION_SECONDS + 10),
      bump: vaultBump,
      pool: poolA, // vault is bound to poolA
    });

    const attackerAta = createAtaFor(svm, payer, vaultMint, attacker.publicKey);
    const vaultBeforeBal = readAmount(svm, vaultAta);

    // The attacker presents a SELF-CONSISTENT (poolB, TV[poolB]) triple where they
    // ARE the verified ip_owner — so TV authenticity (owner==DBC, canonical PDA,
    // claimer==TV.ip_owner) all PASS. The only thing that stops the drain is the
    // claim-side `pool == vault.pool` binding, which here fails (poolB != poolA).
    let threw = false;
    try {
      const tx = await vaultProgram.methods
        .claimVested()
        .accountsPartial({
          vault: vaultPda, // vault_A
          tokenMint: vaultMint,
          vaultTokenAccount: vaultAta,
          claimerTokenAccount: attackerAta,
          claimer: attacker.publicKey,
          pool: poolB, // attacker's OWN pool
          tokenVerification: tvB, // where attacker is ip_owner
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .transaction();
      sendTransactionMaybeThrow(svm, tx, [attacker]);
    } catch (e: any) {
      threw = true;
      expect(
        String(e.message).includes(ERR_POOL_MISMATCH),
        "expected PoolMismatch, got:\n" + String(e.message).slice(-500)
      ).to.equal(true);
    }
    expect(threw, "the cross-pool drain MUST revert").to.equal(true);

    // Fund conservation: vault_A balance is untouched by the failed drain, and the
    // attacker received nothing.
    expect(readAmount(svm, vaultAta)).to.equal(vaultBeforeBal);
    expect(readAmount(svm, attackerAta)).to.equal(0n);
  });

  it("NEGATIVE: a fabricated TokenVerification NOT owned by the DBC program is rejected (TokenVerificationWrongOwner)", async () => {
    // Attacker fabricates a TV account that carries the right discriminator and
    // their own pubkey at the ip_owner offset, BUT is owned by a non-DBC program.
    // The owner check fires first → TokenVerificationWrongOwner. Even placing it at
    // the canonical address for poolA cannot help: the bytes are not DBC-written.
    const fakeTvData = Buffer.alloc(8 + 32 * 6 + 8 + 1); // 209 (TokenVerification::LEN)
    // discriminator = sha256("account:TokenVerification")[..8]
    createHash("sha256").update("account:TokenVerification").digest().subarray(0, 8).copy(fakeTvData, 0);
    attacker.publicKey.toBuffer().copy(fakeTvData, 40); // ip_owner offset
    const fakeTv = deriveTokenVerificationAddress(poolA); // canonical addr for poolA, but wrong owner
    svm.setAccount(fakeTv, {
      lamports: 1_000_000_000,
      data: new Uint8Array(fakeTvData),
      owner: IP_OWNER_VAULT_PROGRAM_ID, // NOT the DBC program → must be rejected
      executable: false,
    });

    // Re-seed vault bound to poolA.
    mintTo(svm, payer, vaultMint, vaultAta, DEPOSITED);
    writeVaultAccount(svm, vaultPda, {
      tokenMint: vaultMint,
      totalDeposited: DEPOSITED,
      totalClaimed: 0n,
      vestingStart: BigInt(svm.getClock().unixTimestamp) - BigInt(VESTING_DURATION_SECONDS + 10),
      bump: vaultBump,
      pool: poolA,
    });
    const attackerAta = getAssociatedTokenAddressSync(vaultMint, attacker.publicKey, true, TOKEN_PROGRAM_ID);

    const vaultBeforeBal = readAmount(svm, vaultAta);
    let threw = false;
    try {
      const tx = await vaultProgram.methods
        .claimVested()
        .accountsPartial({
          vault: vaultPda,
          tokenMint: vaultMint,
          vaultTokenAccount: vaultAta,
          claimerTokenAccount: attackerAta,
          claimer: attacker.publicKey,
          pool: poolA,
          tokenVerification: fakeTv, // fabricated, non-DBC-owned
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .transaction();
      sendTransactionMaybeThrow(svm, tx, [attacker]);
    } catch (e: any) {
      threw = true;
      expect(
        String(e.message).includes(ERR_WRONG_OWNER),
        "expected TokenVerificationWrongOwner, got:\n" + String(e.message).slice(-500)
      ).to.equal(true);
    }
    expect(threw, "fabricated TV must be rejected").to.equal(true);
    // Fund conservation: the failed claim left the vault balance untouched.
    expect(readAmount(svm, vaultAta)).to.equal(vaultBeforeBal);
  });

  it("NEGATIVE: a non-ip_owner claimer (attacker) against the genuine (poolA, TV[poolA]) is rejected (Unauthorized)", async () => {
    // Restore genuine TV[poolA] (the previous test overwrote it with a fake).
    const tx0 = await program.methods
      .verifyToken(userA.publicKey)
      .accountsPartial({
        payer: verifyOperator.publicKey,
        tokenVerification: tvA,
        pool: poolA,
        operator: deriveOperatorAddress(verifyOperator.publicKey),
        signer: verifyOperator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    // tvA already exists (init-once); re-verify would fail. Instead just assert via
    // a fresh claim using the existing genuine TV. We need TV[poolA] present and
    // owned by DBC — it still is from `before()` UNLESS the prior test overwrote it.
    // The prior test wrote a fake at tvA, so restore by re-creating is impossible
    // (init-once). Use a DIFFERENT genuine pool/TV to assert the Unauthorized path.
    void tx0;

    // Build a third genuine pool C with ip_owner = userA, bind a vault to it.
    const configC = await createConfig(svm, program, {
      payer: partner,
      feeClaimer: partner.publicKey,
      quoteMint: NATIVE_MINT,
      instructionParams: token2022Config(),
    });
    const poolC = await createPoolWithToken2022(svm, program, {
      poolCreator: creatorA,
      payer: creatorA,
      quoteMint: NATIVE_MINT,
      config: configC,
      instructionParams: { name: "Pool C", symbol: "PLC", uri: "x" },
    });
    const tvC = deriveTokenVerificationAddress(poolC);
    const vtx = await program.methods
      .verifyToken(userA.publicKey)
      .accountsPartial({
        payer: verifyOperator.publicKey,
        tokenVerification: tvC,
        pool: poolC,
        operator: deriveOperatorAddress(verifyOperator.publicKey),
        signer: verifyOperator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, vtx, [verifyOperator]);

    // Vault for a fresh mint bound to poolC.
    const mintC = createSplMint(svm, payer, 6);
    const [vaultCPda, vaultCBump] = deriveVaultPda(mintC);
    const vaultCAta = getAssociatedTokenAddressSync(mintC, vaultCPda, true, TOKEN_PROGRAM_ID);
    createAtaFor(svm, payer, mintC, vaultCPda);
    mintTo(svm, payer, mintC, vaultCAta, DEPOSITED);
    writeVaultAccount(svm, vaultCPda, {
      tokenMint: mintC,
      totalDeposited: DEPOSITED,
      totalClaimed: 0n,
      vestingStart: BigInt(svm.getClock().unixTimestamp) - BigInt(VESTING_DURATION_SECONDS + 10),
      bump: vaultCBump,
      pool: poolC,
    });

    // attacker (NOT the ip_owner; userA is) tries to claim with the genuine triple.
    const attackerAtaC = createAtaFor(svm, payer, mintC, attacker.publicKey);
    let threw = false;
    try {
      const tx = await vaultProgram.methods
        .claimVested()
        .accountsPartial({
          vault: vaultCPda,
          tokenMint: mintC,
          vaultTokenAccount: vaultCAta,
          claimerTokenAccount: attackerAtaC,
          claimer: attacker.publicKey, // wrong claimer
          pool: poolC,
          tokenVerification: tvC, // genuine, owner==DBC, canonical
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .transaction();
      sendTransactionMaybeThrow(svm, tx, [attacker]);
    } catch (e: any) {
      threw = true;
      expect(
        String(e.message).includes(ERR_UNAUTHORIZED),
        "expected Unauthorized, got:\n" + String(e.message).slice(-500)
      ).to.equal(true);
    }
    expect(threw, "non-ip_owner claim must revert").to.equal(true);
    expect(readAmount(svm, vaultCAta)).to.equal(DEPOSITED);
  });
});

describe("SPEC-DBC-AUDIT-001 — distribute_to_vault authority gate (REQ-E-005)", () => {
  let svm: LiteSVM;
  let vaultProgram: Program<IpOwnerVault>;
  let payer: Keypair;
  let attacker: Keypair;
  let mint: PublicKey;
  let vaultPda: PublicKey;
  let vaultAta: PublicKey;
  let sourceAta: PublicKey;

  before(() => {
    svm = startSvm();
    vaultProgram = makeVaultProgram();
    payer = generateAndFund(svm);
    attacker = generateAndFund(svm);

    mint = createSplMint(svm, payer, 6);
    [vaultPda] = deriveVaultPda(mint);
    vaultAta = getAssociatedTokenAddressSync(mint, vaultPda, true, TOKEN_PROGRAM_ID);
    // The attacker owns a funded source account they want to push into the vault.
    sourceAta = createAtaFor(svm, payer, mint, attacker.publicKey);
    mintTo(svm, payer, mint, sourceAta, 500_000_000n);
  });

  it("a caller that is NOT the DBC pool_authority is REJECTED (InvalidDistributeAuthority)", async () => {
    // The attacker signs as `authority` over their own source account. The handler
    // requires `authority == derive_pool_authority()` (a PDA only DBC can sign for).
    // A permissionless caller therefore cannot poison `vault.pool` by front-running
    // the first deposit. Any non-pool_authority key reverts.
    let threw = false;
    try {
      const tx = await vaultProgram.methods
        .distributeToVault(new BN(100_000_000))
        .accountsPartial({
          vault: vaultPda,
          tokenMint: mint,
          sourceTokenAccount: sourceAta,
          vaultTokenAccount: vaultAta,
          authority: attacker.publicKey, // NOT pool_authority
          pool: Keypair.generate().publicKey, // any pool key
          payer: attacker.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
          systemProgram: SystemProgram.programId,
        })
        .transaction();
      sendTransactionMaybeThrow(svm, tx, [attacker]);
    } catch (e: any) {
      threw = true;
      expect(
        String(e.message).includes("InvalidDistributeAuthority"),
        "expected InvalidDistributeAuthority, got:\n" + String(e.message).slice(-500)
      ).to.equal(true);
    }
    expect(threw, "non-pool_authority distribute must revert").to.equal(true);
    // The vault was never created (no deposit recorded).
    expect(svm.getAccount(vaultPda)).to.equal(null);
  });

  it("the legit DBC CPI path is structurally gated: the IDL requires `authority` and the handler pins it to pool_authority", () => {
    // We cannot drive the POSITIVE path from TS (only DBC can invoke_signed as
    // pool_authority, and DBC no longer CPIs into distribute_to_vault — the vault is
    // dormant). We instead assert the GATE exists structurally: the instruction
    // carries an `authority` account, which the handler binds to the canonical
    // pool_authority PDA. This documents the immovable surface of the guard.
    // The typed IDL exposes names in camelCase; normalize so this is robust to either
    // convention (the on-chain JSON uses snake_case).
    const norm = (s: string) => s.toLowerCase().replace(/_/g, "");
    const ix = vaultProgram.idl.instructions.find((i) => norm(i.name) === "distributetovault");
    expect(ix, "distribute_to_vault must exist").to.not.equal(undefined);
    const acctNames = ix!.accounts.map((a) => a.name.toLowerCase());
    expect(acctNames).to.include("authority");
    expect(acctNames).to.include("pool"); // SEC-P2-01 binding account
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Low-level LiteSVM helpers (SPL Token classic) — kept local to this file.
// ─────────────────────────────────────────────────────────────────────────────

function createSplMint(svm: LiteSVM, payer: Keypair, decimals: number): PublicKey {
  const mintKp = Keypair.generate();
  const rent = svm.minimumBalanceForRentExemption(BigInt(MintLayout.span));
  const tx = new Transaction()
    .add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mintKp.publicKey,
        space: MintLayout.span,
        lamports: Number(rent),
        programId: TOKEN_PROGRAM_ID,
      })
    )
    .add(
      createInitializeMint2Instruction(
        mintKp.publicKey,
        decimals,
        payer.publicKey,
        null,
        TOKEN_PROGRAM_ID
      )
    );
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(payer, mintKp);
  const r = svm.sendTransaction(tx);
  if (r instanceof FailedTransactionMetadata) throw new Error("mint init failed: " + r.meta().logs().join("\n"));
  svm.expireBlockhash();
  return mintKp.publicKey;
}

function createAtaFor(svm: LiteSVM, payer: Keypair, mint: PublicKey, owner: PublicKey): PublicKey {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
  if (svm.getAccount(ata)) return ata;
  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint, TOKEN_PROGRAM_ID)
  );
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(payer);
  const r = svm.sendTransaction(tx);
  if (r instanceof FailedTransactionMetadata) throw new Error("ata create failed: " + r.meta().logs().join("\n"));
  svm.expireBlockhash();
  return ata;
}

function mintTo(svm: LiteSVM, payer: Keypair, mint: PublicKey, dest: PublicKey, amount: bigint) {
  const tx = new Transaction().add(
    createMintToInstruction(mint, dest, payer.publicKey, amount, [], TOKEN_PROGRAM_ID)
  );
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(payer);
  const r = svm.sendTransaction(tx);
  if (r instanceof FailedTransactionMetadata) throw new Error("mintTo failed: " + r.meta().logs().join("\n"));
  svm.expireBlockhash();
}

function readAmount(svm: LiteSVM, ata: PublicKey): bigint {
  const acct = svm.getAccount(ata);
  if (!acct) throw new Error("token account missing: " + ata.toBase58());
  return BigInt(TokenAccountLayout.decode(Buffer.from(acct.data)).amount.toString());
}

/**
 * Write a fully-formed `Vault` (ip-owner-vault) account directly. This mirrors the
 * on-chain state a legit pool_authority-gated `distribute_to_vault` would have left
 * (the deposit path is dormant; see file header). zero_copy layout:
 *   8 disc + 32 token_mint + 8 total_deposited + 8 total_claimed +
 *   8 vesting_start(i64) + 1 bump + 32 pool + 31 padding = 128 bytes.
 */
function writeVaultAccount(
  svm: LiteSVM,
  vaultPda: PublicKey,
  v: { tokenMint: PublicKey; totalDeposited: bigint; totalClaimed: bigint; vestingStart: bigint; bump: number; pool: PublicKey }
) {
  const data = Buffer.alloc(128);
  VAULT_DISCRIMINATOR.copy(data, 0);
  v.tokenMint.toBuffer().copy(data, 8);
  data.writeBigUInt64LE(v.totalDeposited, 8 + 32);
  data.writeBigUInt64LE(v.totalClaimed, 8 + 32 + 8);
  data.writeBigInt64LE(v.vestingStart, 8 + 32 + 8 + 8);
  data.writeUInt8(v.bump, 8 + 32 + 8 + 8 + 8);
  v.pool.toBuffer().copy(data, 8 + 32 + 8 + 8 + 8 + 1);
  // remaining 31 bytes padding = zero
  svm.setAccount(vaultPda, {
    lamports: 5_000_000_000,
    data: new Uint8Array(data),
    owner: IP_OWNER_VAULT_PROGRAM_ID,
    executable: false,
  });
}
