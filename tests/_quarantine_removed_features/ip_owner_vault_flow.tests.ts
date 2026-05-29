/**
 * SPEC-DBC-004 Phase 6 — TypeScript LiteSVM integration tests for ip-owner-vault.
 *
 * Coverage:
 *   REQ-I-003 (ip-owner-vault program: distribute_to_vault + claim_vested)
 *
 * Strategy:
 *   - Stand up the vault program in LiteSVM via startSvm() (svm.ts loads it).
 *   - Exercise the vault directly (no DBC bridge) so we isolate the linear
 *     vesting math and the TokenVerification discriminator gate.
 *   - The full cross-program flow `claim_ip_owner_fee → distribute_to_vault →
 *     claim_vested` requires the heavyweight `verify_token` + IpworldState
 *     bring-up that lives in `describe.skip`-ed `tests/ip_owner_verify.tests.ts`.
 *     We exercise that integration in Phase 8 fork-test scenario-06.
 *
 *   - LiteSVM clock manipulation: `svm.warpToSlot()` advances slots; we adjust
 *     the actual `Clock.unix_timestamp` via the same mechanism the DBC tests use.
 *
 *   - Strict assertions only — no `toBeTruthy()` or `toBeDefined()` (per
 *     plan.md REQ-T-003 strict-assertion clause).
 */

import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";
import {
  AccountLayout as TokenAccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  MintLayout,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { createHash } from "crypto";
import IpOwnerVaultIDL from "../target/idl/ip_owner_vault.json";
import { IpOwnerVault } from "../target/types/ip_owner_vault";
import { IP_OWNER_VAULT_PROGRAM_ID } from "./utils/constants";
import { generateAndFund, startSvm } from "./utils/svm";
import { clusterApiUrl, Connection } from "@solana/web3.js";

// VaultError discriminants (Anchor: 6000 + variant index).
//   0: VestingNotStarted          → 0x1770
//   1: NothingToClaim             → 0x1771
//   2: Unauthorized               → 0x1772
//   3: MathOverflow               → 0x1773
//   4: MintMismatch               → 0x1774
//   5: InvalidTokenVerification   → 0x1775
//   6: AmountIsZero               → 0x1776
const ERR_NOTHING_TO_CLAIM = "0x1771";
const ERR_UNAUTHORIZED = "0x1772";
const ERR_INVALID_TOKEN_VERIFICATION = "0x1775";

const VESTING_DURATION_SECONDS = 365 * 86_400;
const VESTING_VAULT_SEED = Buffer.from("vesting");
const TOKEN_VERIFICATION_DISCRIMINATOR = createHash("sha256")
  .update("account:TokenVerification")
  .digest()
  .subarray(0, 8);

function deriveVaultPda(tokenMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VESTING_VAULT_SEED, tokenMint.toBuffer()],
    IP_OWNER_VAULT_PROGRAM_ID
  );
}

function makeProgram(): Program<IpOwnerVault> {
  // Devnet stub provider — LiteSVM will short-circuit RPC calls; we only need
  // the typed `program.methods` builder.
  const wallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(
    new Connection(clusterApiUrl("devnet")),
    wallet,
    { commitment: "confirmed" }
  );
  return new Program<IpOwnerVault>(IpOwnerVaultIDL as IpOwnerVault, provider);
}

/** Create a TokenVerification-shaped account so the vault's discriminator gate accepts it. */
function makeTokenVerificationAccount(
  ipOwner: PublicKey,
  programOwner: PublicKey
) {
  // Layout: 8 disc + 32 ipa_id + 32 ip_owner + 32 pending_ip_owner +
  //         32 ip_treasury + 32 referral + 32 pending_referral + 8 verified_at + 1 bump
  const data = Buffer.alloc(8 + 32 * 6 + 8 + 1);
  TOKEN_VERIFICATION_DISCRIMINATOR.copy(data, 0);
  // ipa_id at offset 8 — leave zeros (not load-bearing for this test)
  // ip_owner at offset 8 + 32 = 40
  ipOwner.toBuffer().copy(data, 40);
  // remainder zero
  return {
    lamports: 1_000_000_000,
    data: new Uint8Array(data),
    owner: programOwner,
    executable: false,
  };
}

/** Set up an SPL mint inside LiteSVM and return its public key. */
function createTestMint(svm: LiteSVM, payer: Keypair, decimals = 6): PublicKey {
  const mintKp = Keypair.generate();
  const rentExempt = svm.minimumBalanceForRentExemption(BigInt(MintLayout.span));

  const tx = new Transaction()
    .add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mintKp.publicKey,
        space: MintLayout.span,
        lamports: Number(rentExempt),
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
  const sigOrErr = svm.sendTransaction(tx);
  if (typeof sigOrErr !== "string" && "err" in sigOrErr) {
    throw new Error(`mint init failed: ${JSON.stringify(sigOrErr)}`);
  }
  svm.expireBlockhash();
  return mintKp.publicKey;
}

/** Create an ATA for `owner` of `mint`. */
function createAta(
  svm: LiteSVM,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey
): PublicKey {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      owner,
      mint,
      TOKEN_PROGRAM_ID
    )
  );
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(payer);
  const sigOrErr = svm.sendTransaction(tx);
  if (typeof sigOrErr !== "string" && "err" in sigOrErr) {
    throw new Error(`ata create failed: ${JSON.stringify(sigOrErr)}`);
  }
  svm.expireBlockhash();
  return ata;
}

/** Mint `amount` tokens to `dest`. */
function mintToAccount(
  svm: LiteSVM,
  payer: Keypair,
  mint: PublicKey,
  dest: PublicKey,
  amount: bigint
) {
  const tx = new Transaction().add(
    createMintToInstruction(mint, dest, payer.publicKey, amount, [], TOKEN_PROGRAM_ID)
  );
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(payer);
  const sigOrErr = svm.sendTransaction(tx);
  if (typeof sigOrErr !== "string" && "err" in sigOrErr) {
    throw new Error(`mintTo failed: ${JSON.stringify(sigOrErr)}`);
  }
  svm.expireBlockhash();
}

function readTokenAccountAmount(svm: LiteSVM, ata: PublicKey): bigint {
  const acct = svm.getAccount(ata);
  if (!acct) throw new Error(`token account ${ata.toBase58()} missing`);
  const decoded = TokenAccountLayout.decode(Buffer.from(acct.data));
  return BigInt(decoded.amount.toString());
}

/** Read `Vault.total_deposited` from the on-chain account (offset 8 + 32). */
function readVaultDeposited(svm: LiteSVM, vaultPda: PublicKey): bigint {
  const acct = svm.getAccount(vaultPda);
  if (!acct) throw new Error(`vault ${vaultPda.toBase58()} missing`);
  const buf = Buffer.from(acct.data);
  return buf.readBigUInt64LE(8 + 32);
}

/** Read `Vault.total_claimed` (offset 8 + 32 + 8). */
function readVaultClaimed(svm: LiteSVM, vaultPda: PublicKey): bigint {
  const acct = svm.getAccount(vaultPda);
  if (!acct) throw new Error(`vault ${vaultPda.toBase58()} missing`);
  const buf = Buffer.from(acct.data);
  return buf.readBigUInt64LE(8 + 32 + 8);
}

/** Read `Vault.vesting_start_unix_timestamp` (offset 8 + 32 + 8 + 8). */
function readVaultVestingStart(svm: LiteSVM, vaultPda: PublicKey): bigint {
  const acct = svm.getAccount(vaultPda);
  if (!acct) throw new Error(`vault ${vaultPda.toBase58()} missing`);
  const buf = Buffer.from(acct.data);
  return buf.readBigInt64LE(8 + 32 + 8 + 8);
}

describe("SPEC-DBC-004 Phase 6 — REQ-I-003 ip-owner-vault flow", () => {
  let svm: LiteSVM;
  let payer: Keypair;
  let ipOwner: Keypair;
  let attacker: Keypair;
  let program: Program<IpOwnerVault>;
  let mint: PublicKey;
  let payerAta: PublicKey;
  let claimerAta: PublicKey;
  let vaultPda: PublicKey;
  let vaultAta: PublicKey;

  beforeEach(() => {
    svm = startSvm();
    payer = generateAndFund(svm);
    ipOwner = generateAndFund(svm);
    attacker = generateAndFund(svm);
    program = makeProgram();

    mint = createTestMint(svm, payer);
    payerAta = createAta(svm, payer, mint, payer.publicKey);
    claimerAta = createAta(svm, payer, mint, ipOwner.publicKey);
    mintToAccount(svm, payer, mint, payerAta, 1_000_000_000n);

    [vaultPda] = deriveVaultPda(mint);
    vaultAta = getAssociatedTokenAddressSync(
      mint,
      vaultPda,
      true,
      TOKEN_PROGRAM_ID
    );
  });

  it("V-01: distribute_to_vault initializes vault on first call and stamps clock", async () => {
    const ix = await program.methods
      .distributeToVault(new BN(500_000_000))
      .accountsPartial({
        vault: vaultPda,
        tokenMint: mint,
        sourceTokenAccount: payerAta,
        vaultTokenAccount: vaultAta,
        authority: payer.publicKey,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ix);
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = svm.latestBlockhash();
    tx.sign(payer);
    const result = svm.sendTransaction(tx);
    if (result instanceof FailedTransactionMetadata) {
      throw new Error(`distribute_to_vault failed: ${result.meta().logs().join("\n")}`);
    }
    svm.expireBlockhash();

    expect(readVaultDeposited(svm, vaultPda)).to.equal(500_000_000n);
    expect(readVaultClaimed(svm, vaultPda)).to.equal(0n);
    // vesting_start matches the LiteSVM clock at deposit time (may be 0 at boot).
    const vestingStart = readVaultVestingStart(svm, vaultPda);
    const clockAtDeposit = svm.getClock().unixTimestamp;
    expect(vestingStart).to.equal(BigInt(clockAtDeposit));
    expect(readTokenAccountAmount(svm, vaultAta)).to.equal(500_000_000n);
    expect(readTokenAccountAmount(svm, payerAta)).to.equal(500_000_000n);
  });

  it("V-02: second distribute_to_vault increments deposit but does NOT reset clock", async () => {
    const firstIx = await program.methods
      .distributeToVault(new BN(300_000_000))
      .accountsPartial({
        vault: vaultPda,
        tokenMint: mint,
        sourceTokenAccount: payerAta,
        vaultTokenAccount: vaultAta,
        authority: payer.publicKey,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx1 = new Transaction().add(firstIx);
    tx1.feePayer = payer.publicKey;
    tx1.recentBlockhash = svm.latestBlockhash();
    tx1.sign(payer);
    const r1 = svm.sendTransaction(tx1);
    if (r1 instanceof FailedTransactionMetadata) {
      throw new Error(`first deposit failed: ${r1.meta().logs().join("\n")}`);
    }
    svm.expireBlockhash();

    const firstStart = readVaultVestingStart(svm, vaultPda);
    const clockAtFirstDeposit = svm.getClock().unixTimestamp;
    expect(firstStart).to.equal(BigInt(clockAtFirstDeposit));

    // Advance LiteSVM clock by warping slots forward.
    svm.warpToSlot(svm.getClock().slot + 1000n);

    const secondIx = await program.methods
      .distributeToVault(new BN(200_000_000))
      .accountsPartial({
        vault: vaultPda,
        tokenMint: mint,
        sourceTokenAccount: payerAta,
        vaultTokenAccount: vaultAta,
        authority: payer.publicKey,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx2 = new Transaction().add(secondIx);
    tx2.feePayer = payer.publicKey;
    tx2.recentBlockhash = svm.latestBlockhash();
    tx2.sign(payer);
    const r2 = svm.sendTransaction(tx2);
    if (r2 instanceof FailedTransactionMetadata) {
      throw new Error(`second deposit failed: ${r2.meta().logs().join("\n")}`);
    }
    svm.expireBlockhash();

    expect(readVaultDeposited(svm, vaultPda)).to.equal(500_000_000n);
    // clock did NOT reset
    expect(readVaultVestingStart(svm, vaultPda)).to.equal(firstStart);
  });

  it("V-03: claim_vested fails when vesting clock has not advanced (NothingToClaim)", async () => {
    // Seed the vault with a deposit (clock starts NOW)
    const depositIx = await program.methods
      .distributeToVault(new BN(1_000_000_000))
      .accountsPartial({
        vault: vaultPda,
        tokenMint: mint,
        sourceTokenAccount: payerAta,
        vaultTokenAccount: vaultAta,
        authority: payer.publicKey,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const tx0 = new Transaction().add(depositIx);
    tx0.feePayer = payer.publicKey;
    tx0.recentBlockhash = svm.latestBlockhash();
    tx0.sign(payer);
    const seedRes = svm.sendTransaction(tx0);
    if (seedRes instanceof FailedTransactionMetadata) {
      throw new Error(`distribute_to_vault failed: ${seedRes.meta().logs().join("\n")}`);
    }
    svm.expireBlockhash();

    // Set up TokenVerification fixture pointing at ipOwner.
    const tvAddr = Keypair.generate().publicKey;
    svm.setAccount(
      tvAddr,
      makeTokenVerificationAccount(ipOwner.publicKey, IP_OWNER_VAULT_PROGRAM_ID)
    );

    const claimIx = await program.methods
      .claimVested()
      .accountsPartial({
        vault: vaultPda,
        tokenMint: mint,
        vaultTokenAccount: vaultAta,
        claimerTokenAccount: claimerAta,
        claimer: ipOwner.publicKey,
        tokenVerification: tvAddr,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(claimIx);
    tx.feePayer = ipOwner.publicKey;
    tx.recentBlockhash = svm.latestBlockhash();
    tx.sign(ipOwner);
    const result = svm.sendTransaction(tx);
    if (!(result instanceof FailedTransactionMetadata)) {
      throw new Error("expected NothingToClaim rejection, got success");
    }
    const logs = result.meta().logs().join("\n");
    // Log the actual logs to understand which error fires (debugging hook)
    if (!logs.includes(ERR_NOTHING_TO_CLAIM)) {
      console.log("V-03 actual logs:\n" + logs);
    }
    expect(logs).to.include(ERR_NOTHING_TO_CLAIM);
  });

  it("V-04: claim_vested fails when claimer is NOT the verified ip_owner (Unauthorized)", async () => {
    // Seed deposit
    const depositIx = await program.methods
      .distributeToVault(new BN(1_000_000_000))
      .accountsPartial({
        vault: vaultPda,
        tokenMint: mint,
        sourceTokenAccount: payerAta,
        vaultTokenAccount: vaultAta,
        authority: payer.publicKey,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const tx0 = new Transaction().add(depositIx);
    tx0.feePayer = payer.publicKey;
    tx0.recentBlockhash = svm.latestBlockhash();
    tx0.sign(payer);
    const seedRes = svm.sendTransaction(tx0);
    if (seedRes instanceof FailedTransactionMetadata) {
      throw new Error(`distribute_to_vault failed: ${seedRes.meta().logs().join("\n")}`);
    }
    svm.expireBlockhash();

    // TokenVerification points at the legitimate ipOwner — but `attacker` will try to claim.
    const tvAddr = Keypair.generate().publicKey;
    svm.setAccount(
      tvAddr,
      makeTokenVerificationAccount(ipOwner.publicKey, IP_OWNER_VAULT_PROGRAM_ID)
    );
    const attackerAta = createAta(svm, payer, mint, attacker.publicKey);

    const claimIx = await program.methods
      .claimVested()
      .accountsPartial({
        vault: vaultPda,
        tokenMint: mint,
        vaultTokenAccount: vaultAta,
        claimerTokenAccount: attackerAta,
        claimer: attacker.publicKey,
        tokenVerification: tvAddr,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    const tx = new Transaction().add(claimIx);
    tx.feePayer = attacker.publicKey;
    tx.recentBlockhash = svm.latestBlockhash();
    tx.sign(attacker);
    const result = svm.sendTransaction(tx);
    if (!(result instanceof FailedTransactionMetadata)) {
      throw new Error("expected Unauthorized rejection, got success");
    }
    const logs = result.meta().logs().join("\n");
    expect(logs).to.include(ERR_UNAUTHORIZED);
  });

  it("V-05: claim_vested rejects bogus TokenVerification account (InvalidTokenVerification)", async () => {
    // Seed deposit
    const depositIx = await program.methods
      .distributeToVault(new BN(1_000_000_000))
      .accountsPartial({
        vault: vaultPda,
        tokenMint: mint,
        sourceTokenAccount: payerAta,
        vaultTokenAccount: vaultAta,
        authority: payer.publicKey,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const tx0 = new Transaction().add(depositIx);
    tx0.feePayer = payer.publicKey;
    tx0.recentBlockhash = svm.latestBlockhash();
    tx0.sign(payer);
    const seedRes = svm.sendTransaction(tx0);
    if (seedRes instanceof FailedTransactionMetadata) {
      throw new Error(`distribute_to_vault failed: ${seedRes.meta().logs().join("\n")}`);
    }
    svm.expireBlockhash();

    // Fake TokenVerification account with WRONG discriminator.
    const bogusTv = Keypair.generate().publicKey;
    const fakeData = Buffer.alloc(8 + 32 * 6 + 8 + 1);
    // Discriminator filled with 0xFF — not a real Anchor account
    fakeData.fill(0xff, 0, 8);
    ipOwner.publicKey.toBuffer().copy(fakeData, 40);
    svm.setAccount(bogusTv, {
      lamports: 1_000_000_000,
      data: new Uint8Array(fakeData),
      owner: IP_OWNER_VAULT_PROGRAM_ID,
      executable: false,
    });

    const claimIx = await program.methods
      .claimVested()
      .accountsPartial({
        vault: vaultPda,
        tokenMint: mint,
        vaultTokenAccount: vaultAta,
        claimerTokenAccount: claimerAta,
        claimer: ipOwner.publicKey,
        tokenVerification: bogusTv,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    const tx = new Transaction().add(claimIx);
    tx.feePayer = ipOwner.publicKey;
    tx.recentBlockhash = svm.latestBlockhash();
    tx.sign(ipOwner);
    const result = svm.sendTransaction(tx);
    if (!(result instanceof FailedTransactionMetadata)) {
      throw new Error("expected InvalidTokenVerification, got success");
    }
    const logs = result.meta().logs().join("\n");
    expect(logs).to.include(ERR_INVALID_TOKEN_VERIFICATION);
  });

  it("V-06: PDA derivation matches Rust seed pattern [b'vesting', token_mint]", () => {
    // Sanity check that TS/Rust PDA derivations are byte-compatible.
    const [pdaA, bumpA] = deriveVaultPda(mint);
    const [pdaB, bumpB] = PublicKey.findProgramAddressSync(
      [Buffer.from("vesting"), mint.toBuffer()],
      IP_OWNER_VAULT_PROGRAM_ID
    );
    expect(pdaA.equals(pdaB)).to.equal(true);
    expect(bumpA).to.equal(bumpB);
  });

  it("V-08: full flow — deposit → warp past full duration → claim_vested releases full amount", async () => {
    const depositIx = await program.methods
      .distributeToVault(new BN(1_000_000_000))
      .accountsPartial({
        vault: vaultPda,
        tokenMint: mint,
        sourceTokenAccount: payerAta,
        vaultTokenAccount: vaultAta,
        authority: payer.publicKey,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const tx0 = new Transaction().add(depositIx);
    tx0.feePayer = payer.publicKey;
    tx0.recentBlockhash = svm.latestBlockhash();
    tx0.sign(payer);
    const r0 = svm.sendTransaction(tx0);
    if (r0 instanceof FailedTransactionMetadata) {
      throw new Error(`deposit failed: ${r0.meta().logs().join("\n")}`);
    }
    svm.expireBlockhash();

    // Warp clock past full vesting duration. setClock to simulate elapsed time.
    const clk = svm.getClock();
    clk.unixTimestamp = clk.unixTimestamp + BigInt(VESTING_DURATION_SECONDS + 1);
    svm.setClock(clk);

    const tvAddr = Keypair.generate().publicKey;
    svm.setAccount(
      tvAddr,
      makeTokenVerificationAccount(ipOwner.publicKey, IP_OWNER_VAULT_PROGRAM_ID)
    );

    const claimIx = await program.methods
      .claimVested()
      .accountsPartial({
        vault: vaultPda,
        tokenMint: mint,
        vaultTokenAccount: vaultAta,
        claimerTokenAccount: claimerAta,
        claimer: ipOwner.publicKey,
        tokenVerification: tvAddr,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    const tx = new Transaction().add(claimIx);
    tx.feePayer = ipOwner.publicKey;
    tx.recentBlockhash = svm.latestBlockhash();
    tx.sign(ipOwner);
    const result = svm.sendTransaction(tx);
    if (result instanceof FailedTransactionMetadata) {
      throw new Error(`claim_vested failed: ${result.meta().logs().join("\n")}`);
    }
    svm.expireBlockhash();

    // After full duration, the entire deposit must be released and claimed.
    expect(readVaultClaimed(svm, vaultPda)).to.equal(1_000_000_000n);
    expect(readTokenAccountAmount(svm, claimerAta)).to.equal(1_000_000_000n);
    expect(readTokenAccountAmount(svm, vaultAta)).to.equal(0n);
  });

  it("V-07: TokenVerification discriminator is sha256('account:TokenVerification')[..8]", () => {
    const expected = createHash("sha256")
      .update("account:TokenVerification")
      .digest()
      .subarray(0, 8);
    expect(Buffer.from(TOKEN_VERIFICATION_DISCRIMINATOR).equals(expected)).to.equal(true);
    // Hard-coded expected bytes per claim_vested.rs
    const hardcoded = Buffer.from([0x04, 0xdf, 0x60, 0xe7, 0x1e, 0xde, 0x90, 0x82]);
    expect(Buffer.from(TOKEN_VERIFICATION_DISCRIMINATOR).equals(hardcoded)).to.equal(true);
  });
});
