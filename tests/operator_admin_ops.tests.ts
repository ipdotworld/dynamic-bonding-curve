/**
 * SPEC-DBC-AUDIT-001 — Operator-direct admin ops + single-role enforcement (LiteSVM)
 *
 * Security coverage (pass T2):
 *   REQ-D-002 / SEC-CORE-02 / SEC-CORE-03 — operator-direct signing for the five
 *     backend admin ops, and the structural elimination of the relayed-Ed25519
 *     replay vector.
 *   REQ-D-004 — single valid role per Operator account.
 *
 * What this supersedes: the quarantined `ip_owner_verify.tests.ts`, which used the
 * pre-audit relayed-Ed25519 admin-op pattern (serializeVerifyAuth + Ed25519Program
 * + ipworldState/instructionsSysvar accounts). The audit (Phase 4) switched all five
 * backend ops to OPERATOR-DIRECT-SIGNING: each takes its payload as a plain arg and
 * is gated by `#[access_control(is_valid_operator_role(.., VerifyToken))]` in lib.rs.
 * There is no signed message to replay because the operator is the direct caller.
 *
 * Authorization model (verified against programs/dynamic-bonding-curve/src):
 *   - create_operator_account is gated by is_admin(signer). Under `--features local`
 *     `assert_eq_admin` returns true unconditionally, so the test build accepts any
 *     signer as admin — this lets us mint Operator accounts freely. The REAL guard we
 *     exercise here is is_valid_operator_role, which is NOT bypassed by `local`: it
 *     checks the on-chain Operator.permission bitmask AND signer == whitelisted_address.
 *   - OperatorPermission: ClaimProtocolFee=0, VerifyToken=2, ClaimAirdrop=3 (gaps at
 *     1,4 — Backend/_Reserved1 removed). The five backend ops all require VerifyToken.
 *
 * Build: anchor build -p dynamic_bonding_curve -- --features local
 * Run:   yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/operator_admin_ops.tests.ts
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { LiteSVM } from "litesvm";
import {
  BaseFee,
  ConfigParameters,
  createConfig,
  createOperatorAccount,
  createPoolWithToken2022,
  OperatorPermission,
  encodePermissions,
} from "./instructions";
import {
  createVirtualCurveProgram,
  generateAndFund,
  getTokenVerification,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  sendTransactionMaybeThrow,
  startSvm,
  U64_MAX,
} from "./utils";
import {
  deriveOperatorAddress,
  deriveTokenVerificationAddress,
} from "./utils/accounts";
import { getVirtualPool } from "./utils/fetcher";
import { VirtualCurveProgram } from "./utils/types";

// ── Shared Token-2022 + DAMM v2 config (the IPWorld production shape) ──────────
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
    migrationOption: 1, // DAMM v2
    tokenType: 1, // Token2022
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

/** Set up a fresh Token-2022 pool. Returns the pool + its base mint. */
async function setupPool(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  partner: Keypair,
  poolCreator: Keypair
): Promise<{ config: PublicKey; pool: PublicKey; baseMint: PublicKey }> {
  const config = await createConfig(svm, program, {
    payer: partner,
    feeClaimer: partner.publicKey,
    quoteMint: NATIVE_MINT,
    instructionParams: token2022Config(),
  });
  const pool = await createPoolWithToken2022(svm, program, {
    poolCreator,
    payer: poolCreator,
    quoteMint: NATIVE_MINT,
    config,
    instructionParams: { name: "Op Test", symbol: "OPT", uri: "x" },
  });
  const ps = getVirtualPool(svm, program, pool);
  return { config, pool, baseMint: ps.baseMint };
}

describe("SPEC-DBC-AUDIT-001 — operator-direct admin ops (REQ-D-002, SEC-CORE-02/03)", () => {
  let svm: LiteSVM;
  let program: VirtualCurveProgram;
  let admin: Keypair;
  let partner: Keypair;
  let poolCreator: Keypair;

  // The legitimate backend operator: a single-role Operator with VerifyToken (bit 2).
  let verifyOperator: Keypair;
  // An operator holding the WRONG role (ClaimAirdrop, bit 3) — must be rejected.
  let airdropOperator: Keypair;
  // A keypair with no Operator account at all.
  let nonOperator: Keypair;

  before(async () => {
    svm = startSvm();
    program = createVirtualCurveProgram();
    admin = generateAndFund(svm);
    partner = generateAndFund(svm);
    poolCreator = generateAndFund(svm);
    verifyOperator = generateAndFund(svm);
    airdropOperator = generateAndFund(svm);
    nonOperator = generateAndFund(svm);

    // Mint the two single-role Operator accounts.
    await createOperatorAccount(svm, program, {
      admin,
      whitelistedAddress: verifyOperator.publicKey,
      permissions: [OperatorPermission.VerifyToken],
    });
    await createOperatorAccount(svm, program, {
      admin,
      whitelistedAddress: airdropOperator.publicKey,
      permissions: [OperatorPermission.ClaimAirdrop],
    });
  });

  // ── verify_token ────────────────────────────────────────────────────────────
  it("verify_token: a VerifyToken operator + its signer SUCCEEDS and writes ip_owner", async () => {
    const { pool } = await setupPool(svm, program, partner, poolCreator);
    const ipOwner = Keypair.generate().publicKey;
    const tvAddr = deriveTokenVerificationAddress(pool);

    const tx = await program.methods
      .verifyToken(ipOwner)
      .accountsPartial({
        payer: verifyOperator.publicKey,
        tokenVerification: tvAddr,
        pool,
        operator: deriveOperatorAddress(verifyOperator.publicKey),
        signer: verifyOperator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, tx, [verifyOperator]);

    const tv = getTokenVerification(svm, program, tvAddr);
    expect(tv.ipOwner.toBase58()).to.equal(ipOwner.toBase58());
  });

  it("verify_token: a non-operator signer is REJECTED (InvalidPermission)", async () => {
    const { pool } = await setupPool(svm, program, partner, poolCreator);
    const tvAddr = deriveTokenVerificationAddress(pool);

    // nonOperator has no Operator account → its derived operator PDA does not
    // exist, so account validation fails before the access_control even runs.
    let threw = false;
    try {
      const tx = await program.methods
        .verifyToken(Keypair.generate().publicKey)
        .accountsPartial({
          payer: nonOperator.publicKey,
          tokenVerification: tvAddr,
          pool,
          operator: deriveOperatorAddress(nonOperator.publicKey),
          signer: nonOperator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .transaction();
      sendTransactionMaybeThrow(svm, tx, [nonOperator]);
    } catch (e: any) {
      threw = true;
      // nonOperator has no Operator PDA, so the `operator: AccountLoader<Operator>`
      // constraint fails first: the derived address is an empty System-owned account,
      // which Anchor rejects with AccountOwnedByWrongProgram (0xbbf). (If the account
      // happened to exist it would instead be InvalidPermission.) Either is a genuine
      // operator-auth rejection — a non-operator can never satisfy the operator gate.
      const m = String(e.message);
      expect(
        m.includes("AccountOwnedByWrongProgram") ||
          m.includes("0xbbf") ||
          m.includes("AccountNotInitialized") ||
          m.includes("InvalidPermission"),
        "expected an operator-auth rejection, got:\n" + m.slice(-400)
      ).to.equal(true);
    }
    expect(threw, "non-operator verify_token must revert").to.equal(true);
  });

  it("verify_token: an operator holding the WRONG role (ClaimAirdrop) is REJECTED (InvalidPermission)", async () => {
    const { pool } = await setupPool(svm, program, partner, poolCreator);
    const tvAddr = deriveTokenVerificationAddress(pool);

    let threw = false;
    try {
      const tx = await program.methods
        .verifyToken(Keypair.generate().publicKey)
        .accountsPartial({
          payer: airdropOperator.publicKey,
          tokenVerification: tvAddr,
          pool,
          operator: deriveOperatorAddress(airdropOperator.publicKey),
          signer: airdropOperator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .transaction();
      sendTransactionMaybeThrow(svm, tx, [airdropOperator]);
    } catch (e: any) {
      threw = true;
      expect(
        String(e.message).includes("InvalidPermission"),
        "expected InvalidPermission, got:\n" + String(e.message).slice(-400)
      ).to.equal(true);
    }
    expect(threw, "wrong-role operator verify_token must revert").to.equal(true);
  });

  // ── The other four backend ops share the exact same operator gate. We verify a
  // ── positive + a wrong-role negative for each to prove the gate is wired on all
  // ── five (REQ-D-002), not just verify_token. Each op first needs a verified TV.
  async function verifiedPool(): Promise<{ pool: PublicKey; tvAddr: PublicKey; ipOwner: PublicKey }> {
    const { pool } = await setupPool(svm, program, partner, poolCreator);
    const tvAddr = deriveTokenVerificationAddress(pool);
    const ipOwner = generateAndFund(svm).publicKey;
    const tx = await program.methods
      .verifyToken(ipOwner)
      .accountsPartial({
        payer: verifyOperator.publicKey,
        tokenVerification: tvAddr,
        pool,
        operator: deriveOperatorAddress(verifyOperator.publicKey),
        signer: verifyOperator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, tx, [verifyOperator]);
    return { pool, tvAddr, ipOwner };
  }

  it("set_ip_treasury: VerifyToken operator SUCCEEDS; wrong-role operator REJECTED", async () => {
    const { pool, tvAddr } = await verifiedPool();
    const treasury = Keypair.generate().publicKey;

    // positive
    const okTx = await program.methods
      .setIpTreasury(treasury)
      .accountsPartial({
        tokenVerification: tvAddr,
        pool,
        operator: deriveOperatorAddress(verifyOperator.publicKey),
        signer: verifyOperator.publicKey,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, okTx, [verifyOperator]);
    expect(
      getTokenVerification(svm, program, tvAddr).ipTreasury.toBase58()
    ).to.equal(treasury.toBase58());

    // negative: wrong role on a fresh pool's TV
    const { tvAddr: tv2, pool: pool2 } = await verifiedPool();
    let threw = false;
    try {
      const badTx = await program.methods
        .setIpTreasury(Keypair.generate().publicKey)
        .accountsPartial({
          tokenVerification: tv2,
          pool: pool2,
          operator: deriveOperatorAddress(airdropOperator.publicKey),
          signer: airdropOperator.publicKey,
        })
        .transaction();
      sendTransactionMaybeThrow(svm, badTx, [airdropOperator]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message).includes("InvalidPermission")).to.equal(true);
    }
    expect(threw, "wrong-role set_ip_treasury must revert").to.equal(true);
  });

  it("set_referral: VerifyToken operator SUCCEEDS; wrong-role operator REJECTED", async () => {
    const { pool, tvAddr } = await verifiedPool();
    const newReferral = Keypair.generate().publicKey;

    const okTx = await program.methods
      .setReferral(newReferral)
      .accountsPartial({
        tokenVerification: tvAddr,
        pool,
        operator: deriveOperatorAddress(verifyOperator.publicKey),
        signer: verifyOperator.publicKey,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, okTx, [verifyOperator]);
    expect(
      getTokenVerification(svm, program, tvAddr).pendingReferral.toBase58()
    ).to.equal(newReferral.toBase58());

    const { tvAddr: tv2, pool: pool2 } = await verifiedPool();
    let threw = false;
    try {
      const badTx = await program.methods
        .setReferral(Keypair.generate().publicKey)
        .accountsPartial({
          tokenVerification: tv2,
          pool: pool2,
          operator: deriveOperatorAddress(airdropOperator.publicKey),
          signer: airdropOperator.publicKey,
        })
        .transaction();
      sendTransactionMaybeThrow(svm, badTx, [airdropOperator]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message).includes("InvalidPermission")).to.equal(true);
    }
    expect(threw, "wrong-role set_referral must revert").to.equal(true);
  });

  it("transfer_ip_owner: VerifyToken operator SUCCEEDS; wrong-role operator REJECTED", async () => {
    const { pool, tvAddr } = await verifiedPool();
    const newIpOwner = Keypair.generate().publicKey;

    const okTx = await program.methods
      .transferIpOwner(newIpOwner)
      .accountsPartial({
        tokenVerification: tvAddr,
        pool,
        operator: deriveOperatorAddress(verifyOperator.publicKey),
        signer: verifyOperator.publicKey,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, okTx, [verifyOperator]);
    expect(
      getTokenVerification(svm, program, tvAddr).pendingIpOwner.toBase58()
    ).to.equal(newIpOwner.toBase58());

    const { tvAddr: tv2, pool: pool2 } = await verifiedPool();
    let threw = false;
    try {
      const badTx = await program.methods
        .transferIpOwner(Keypair.generate().publicKey)
        .accountsPartial({
          tokenVerification: tv2,
          pool: pool2,
          operator: deriveOperatorAddress(airdropOperator.publicKey),
          signer: airdropOperator.publicKey,
        })
        .transaction();
      sendTransactionMaybeThrow(svm, badTx, [airdropOperator]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message).includes("InvalidPermission")).to.equal(true);
    }
    expect(threw, "wrong-role transfer_ip_owner must revert").to.equal(true);
  });

  it("link_token_to_ip: VerifyToken operator SUCCEEDS; wrong-role operator REJECTED", async () => {
    const { pool, tvAddr } = await verifiedPool();
    const ipaId = Keypair.generate().publicKey;

    const okTx = await program.methods
      .linkTokenToIp(ipaId)
      .accountsPartial({
        tokenVerification: tvAddr,
        pool,
        operator: deriveOperatorAddress(verifyOperator.publicKey),
        signer: verifyOperator.publicKey,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, okTx, [verifyOperator]);
    expect(
      getTokenVerification(svm, program, tvAddr).ipaId.toBase58()
    ).to.equal(ipaId.toBase58());

    const { tvAddr: tv2, pool: pool2 } = await verifiedPool();
    let threw = false;
    try {
      const badTx = await program.methods
        .linkTokenToIp(Keypair.generate().publicKey)
        .accountsPartial({
          tokenVerification: tv2,
          pool: pool2,
          operator: deriveOperatorAddress(airdropOperator.publicKey),
          signer: airdropOperator.publicKey,
        })
        .transaction();
      sendTransactionMaybeThrow(svm, badTx, [airdropOperator]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message).includes("InvalidPermission")).to.equal(true);
    }
    expect(threw, "wrong-role link_token_to_ip must revert").to.equal(true);
  });

  // ── Replay vector structurally eliminated (SEC-CORE-02/03) ────────────────────
  it("the relayed-Ed25519 replay path is GONE: verify_token's IDL takes ip_owner as an arg and has no sysvar/ipworld_state account", () => {
    // The typed IDL exposes names in camelCase; normalize so this is robust to either
    // convention (the on-chain JSON uses snake_case).
    const norm = (s: string) => s.toLowerCase().replace(/_/g, "");
    const ix = program.idl.instructions.find((i) => norm(i.name) === "verifytoken");
    expect(ix, "verify_token must exist in the IDL").to.not.equal(undefined);

    // (a) The payload is a direct instruction ARGUMENT (not a relayed signed message).
    const argNames = ix!.args.map((a) => a.name);
    expect(argNames).to.include.oneOf(["ip_owner", "ipOwner"]);

    // (b) NONE of the pre-audit relay accounts remain: no instructions sysvar, no
    //     ipworld_state, no ed25519 message account. Their presence WAS the replay
    //     surface; their absence proves the vector is structurally removed.
    const acctNames = ix!.accounts.map((a) => a.name.toLowerCase());
    for (const banned of ["instructionssysvar", "instructions_sysvar", "ipworldstate", "ipworld_state", "sysvarinstructions"]) {
      expect(acctNames).to.not.include(banned);
    }
    // The op IS gated by an operator + a direct signer instead.
    expect(acctNames).to.include("operator");
    expect(acctNames).to.include("signer");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPEC-DBC-AUDIT-001 gap coverage (pass T3): two-step accept_ip_owner +
// set_ip_treasury one-time immutability. These restore (and correct) the two-step
// surface previously in the now-deleted quarantined ip_owner_verify.tests.ts.
// ─────────────────────────────────────────────────────────────────────────────
describe("SPEC-DBC-AUDIT-001 — accept_ip_owner two-step + set_ip_treasury immutability", () => {
  let svm: LiteSVM;
  let program: VirtualCurveProgram;
  let admin: Keypair;
  let partner: Keypair;
  let poolCreator: Keypair;
  let verifyOperator: Keypair;

  before(async () => {
    svm = startSvm();
    program = createVirtualCurveProgram();
    admin = generateAndFund(svm);
    partner = generateAndFund(svm);
    poolCreator = generateAndFund(svm);
    verifyOperator = generateAndFund(svm);
    await createOperatorAccount(svm, program, {
      admin,
      whitelistedAddress: verifyOperator.publicKey,
      permissions: [OperatorPermission.VerifyToken],
    });
  });

  // Sets up a pool whose TokenVerification.ip_owner is a keypair WE control (so we
  // can sign accept_ip_owner as the current owner). Returns pool, TV, owner keypair.
  async function verifiedPoolWithOwner(): Promise<{
    pool: PublicKey;
    tvAddr: PublicKey;
    ipOwner: Keypair;
  }> {
    const config = await createConfig(svm, program, {
      payer: partner,
      feeClaimer: partner.publicKey,
      quoteMint: NATIVE_MINT,
      instructionParams: token2022Config(),
    });
    const pool = await createPoolWithToken2022(svm, program, {
      poolCreator,
      payer: poolCreator,
      quoteMint: NATIVE_MINT,
      config,
      instructionParams: { name: "Op Test", symbol: "OPT", uri: "x" },
    });
    const tvAddr = deriveTokenVerificationAddress(pool);
    const ipOwner = generateAndFund(svm);
    const tx = await program.methods
      .verifyToken(ipOwner.publicKey)
      .accountsPartial({
        payer: verifyOperator.publicKey,
        tokenVerification: tvAddr,
        pool,
        operator: deriveOperatorAddress(verifyOperator.publicKey),
        signer: verifyOperator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, tx, [verifyOperator]);
    return { pool, tvAddr, ipOwner };
  }

  it("accept_ip_owner: the CURRENT ip_owner finalizes a pending transfer (pending promoted, cleared)", async () => {
    const { pool, tvAddr, ipOwner } = await verifiedPoolWithOwner();
    const newOwner = Keypair.generate().publicKey;

    // Operator proposes the transfer (sets pending_ip_owner).
    const proposeTx = await program.methods
      .transferIpOwner(newOwner)
      .accountsPartial({
        tokenVerification: tvAddr,
        pool,
        operator: deriveOperatorAddress(verifyOperator.publicKey),
        signer: verifyOperator.publicKey,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, proposeTx, [verifyOperator]);
    expect(
      getTokenVerification(svm, program, tvAddr).pendingIpOwner.toBase58()
    ).to.equal(newOwner.toBase58());

    // NOTE on the two-step shape: the program's `accept_ip_owner` is signed by the
    // CURRENT `ip_owner` (constraint `ip_owner.key() == token_verification.ip_owner`),
    // which then PROMOTES `pending_ip_owner`. (This differs from a "pending recipient
    // accepts" pattern — the on-chain guard is the current owner's signature.)
    const acceptTx = await program.methods
      .acceptIpOwner()
      .accountsPartial({
        ipOwner: ipOwner.publicKey,
        tokenVerification: tvAddr,
        pool,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, acceptTx, [ipOwner]);

    const tv = getTokenVerification(svm, program, tvAddr);
    expect(tv.ipOwner.toBase58()).to.equal(newOwner.toBase58());
    expect(tv.pendingIpOwner.toBase58()).to.equal(PublicKey.default.toBase58());
  });

  it("accept_ip_owner: a signer that is NOT the current ip_owner is REJECTED (Unauthorized)", async () => {
    const { pool, tvAddr, ipOwner } = await verifiedPoolWithOwner();

    // Propose a transfer so there's a pending owner to (illegitimately) accept.
    const proposeTx = await program.methods
      .transferIpOwner(Keypair.generate().publicKey)
      .accountsPartial({
        tokenVerification: tvAddr,
        pool,
        operator: deriveOperatorAddress(verifyOperator.publicKey),
        signer: verifyOperator.publicKey,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, proposeTx, [verifyOperator]);

    // A stranger (not the current ip_owner) tries to finalize → ConstraintRaw /
    // Unauthorized (the `ip_owner.key() == token_verification.ip_owner` constraint).
    const stranger = generateAndFund(svm);
    let threw = false;
    try {
      const badTx = await program.methods
        .acceptIpOwner()
        .accountsPartial({
          ipOwner: stranger.publicKey,
          tokenVerification: tvAddr,
          pool,
        })
        .transaction();
      sendTransactionMaybeThrow(svm, badTx, [stranger]);
    } catch (e: any) {
      threw = true;
      const m = String(e.message);
      expect(
        m.includes("Unauthorized") || m.includes("ConstraintRaw") || m.includes("2003"),
        "expected an Unauthorized/ConstraintRaw rejection, got:\n" + m.slice(-400)
      ).to.equal(true);
    }
    expect(threw, "wrong-signer accept_ip_owner must revert").to.equal(true);
    // ip_owner unchanged (the illegitimate accept did not take effect).
    expect(
      getTokenVerification(svm, program, tvAddr).ipOwner.toBase58()
    ).to.equal(ipOwner.publicKey.toBase58());
  });

  it("set_ip_treasury: first set SUCCEEDS; a SECOND set is REJECTED (IpTreasuryAlreadySet)", async () => {
    const { pool, tvAddr } = await verifiedPoolWithOwner();
    const treasury1 = Keypair.generate().publicKey;

    // First set: ip_treasury is still default → require!() passes.
    const okTx = await program.methods
      .setIpTreasury(treasury1)
      .accountsPartial({
        tokenVerification: tvAddr,
        pool,
        operator: deriveOperatorAddress(verifyOperator.publicKey),
        signer: verifyOperator.publicKey,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, okTx, [verifyOperator]);
    expect(
      getTokenVerification(svm, program, tvAddr).ipTreasury.toBase58()
    ).to.equal(treasury1.toBase58());

    // Second set: ip_treasury is now non-default → require!() fires
    // IpTreasuryAlreadySet (0x17ae). One-time immutability (REQ-I-005).
    let threw = false;
    try {
      const badTx = await program.methods
        .setIpTreasury(Keypair.generate().publicKey)
        .accountsPartial({
          tokenVerification: tvAddr,
          pool,
          operator: deriveOperatorAddress(verifyOperator.publicKey),
          signer: verifyOperator.publicKey,
        })
        .transaction();
      sendTransactionMaybeThrow(svm, badTx, [verifyOperator]);
    } catch (e: any) {
      threw = true;
      const m = String(e.message);
      expect(
        m.includes("IpTreasuryAlreadySet") || m.includes("0x17ae"),
        "expected IpTreasuryAlreadySet, got:\n" + m.slice(-400)
      ).to.equal(true);
    }
    expect(threw, "second set_ip_treasury must revert").to.equal(true);
    // The original treasury is unchanged.
    expect(
      getTokenVerification(svm, program, tvAddr).ipTreasury.toBase58()
    ).to.equal(treasury1.toBase58());
  });
});

describe("SPEC-DBC-AUDIT-001 — single-role operator enforcement (REQ-D-004)", () => {
  let svm: LiteSVM;
  let program: VirtualCurveProgram;
  let admin: Keypair;

  before(() => {
    svm = startSvm();
    program = createVirtualCurveProgram();
    admin = generateAndFund(svm);
  });

  /** Raw create_operator_account with an explicit u128 permission bitmask. */
  async function createOperatorRaw(permission: BN, whitelisted: PublicKey, signer: Keypair) {
    const tx = await program.methods
      .createOperatorAccount(permission)
      .accountsPartial({
        signer: signer.publicKey,
        operator: deriveOperatorAddress(whitelisted),
        whitelistedAddress: whitelisted,
        payer: signer.publicKey,
      })
      .transaction();
    sendTransactionMaybeThrow(svm, tx, [signer]);
  }

  it("a single-role value (VerifyToken = 1<<2) SUCCEEDS and stores the bitmask", async () => {
    const whitelisted = Keypair.generate().publicKey;
    await createOperatorRaw(new BN(1).shln(2), whitelisted, admin);

    // Read it back: Operator layout is 8 disc + 32 whitelisted + 16 permission(u128) + ...
    const acct = svm.getAccount(deriveOperatorAddress(whitelisted));
    expect(acct, "operator account must exist").to.not.equal(null);
    const buf = Buffer.from(acct!.data);
    const storedWhitelisted = new PublicKey(buf.subarray(8, 40));
    expect(storedWhitelisted.toBase58()).to.equal(whitelisted.toBase58());
    // permission u128 LE at offset 40: low 8 bytes carry bit 2 → value 4.
    expect(buf.readBigUInt64LE(40)).to.equal(4n);
  });

  it("a MULTI-bit permission (VerifyToken | ClaimAirdrop) is REJECTED (InvalidPermission)", async () => {
    const whitelisted = Keypair.generate().publicKey;
    const multi = encodePermissions([
      OperatorPermission.VerifyToken,
      OperatorPermission.ClaimAirdrop,
    ]); // (1<<2)|(1<<3) = 12 — two bits set
    expect(multi.toNumber()).to.equal(12);

    let threw = false;
    try {
      await createOperatorRaw(multi, whitelisted, admin);
    } catch (e: any) {
      threw = true;
      expect(
        String(e.message).includes("InvalidPermission"),
        "expected InvalidPermission, got:\n" + String(e.message).slice(-400)
      ).to.equal(true);
    }
    expect(threw, "multi-bit permission must revert").to.equal(true);
  });

  it("a zero permission (no role) is REJECTED (InvalidPermission)", async () => {
    const whitelisted = Keypair.generate().publicKey;
    let threw = false;
    try {
      await createOperatorRaw(new BN(0), whitelisted, admin);
    } catch (e: any) {
      threw = true;
      expect(String(e.message).includes("InvalidPermission")).to.equal(true);
    }
    expect(threw, "zero permission must revert").to.equal(true);
  });

  it("the REMOVED _Reserved1 slot (bit 1) is not constructible (InvalidPermission)", async () => {
    const whitelisted = Keypair.generate().publicKey;
    let threw = false;
    try {
      // single bit at slot 1 — a dead/removed slot with no OperatorPermission variant.
      await createOperatorRaw(new BN(1).shln(1), whitelisted, admin);
    } catch (e: any) {
      threw = true;
      expect(String(e.message).includes("InvalidPermission")).to.equal(true);
    }
    expect(threw, "reserved slot 1 must revert").to.equal(true);
  });

  it("the REMOVED Backend slot (bit 4) is not constructible (InvalidPermission)", async () => {
    const whitelisted = Keypair.generate().publicKey;
    let threw = false;
    try {
      // single bit at slot 4 — formerly `Backend`, removed in REQ-D-004.
      await createOperatorRaw(new BN(1).shln(4), whitelisted, admin);
    } catch (e: any) {
      threw = true;
      expect(String(e.message).includes("InvalidPermission")).to.equal(true);
    }
    expect(threw, "reserved slot 4 must revert").to.equal(true);
  });

  it("each surviving single role (ClaimProtocolFee=0, VerifyToken=2, ClaimAirdrop=3) is constructible", async () => {
    for (const perm of [
      OperatorPermission.ClaimProtocolFee,
      OperatorPermission.VerifyToken,
      OperatorPermission.ClaimAirdrop,
    ]) {
      const whitelisted = Keypair.generate().publicKey;
      await createOperatorRaw(new BN(1).shln(perm), whitelisted, admin);
      const acct = svm.getAccount(deriveOperatorAddress(whitelisted));
      expect(acct, `operator for role ${perm} must exist`).to.not.equal(null);
    }
  });
});
