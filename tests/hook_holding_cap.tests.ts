/**
 * SPEC-DBC-AUDIT-001 — 5% holding-cap boundary (REQ-B-001) (LiteSVM)
 *
 * The ipworld-hook's Execute handler enforces a persistent per-recipient cap: after
 * a transfer, a NON-exempt recipient may not hold strictly more than 5% of the
 * mint's total supply. Exactly 5% is allowed (inclusive boundary). The POOL VAULT
 * is the ONLY exempt recipient (it holds ~all supply pre-graduation, so a SELL back
 * into the curve must never be blocked). Below the cap, transfers/buys progress.
 *
 * APPROACH — two complementary layers:
 *  (1) DIRECT exact-boundary control. We stand up a standalone Token-2022 mint with
 *      the real ipworld-hook installed as its transfer hook, run the real
 *      `initialize_extra_account_meta_list`, and write the `HookConfig` PDA directly
 *      (the on-chain `initialize_hook_config` requires a pool_authority PDA signer we
 *      cannot produce from TS — and Guard 1/3 are already covered by the hook's Rust
 *      unit tests). Because the test is the mint authority it controls the supply
 *      EXACTLY, so it can land a recipient at PRECISELY 5% — impossible to hit
 *      through bonding-curve math. The hook fires on these top-level transfers under
 *      LiteSVM (verified), giving a genuine end-to-end exercise of the on-chain cap.
 *  (2) END-TO-END via real DBC swaps. Many buyers each acquiring < 5% succeed and the
 *      curve progresses; a single buy that would hand one buyer > 5% reverts with
 *      HoldingCapExceeded from inside the swap's Token-2022 transfer-hook CPI.
 *
 * Error: HookError::HoldingCapExceeded = 6003 = 0x1773; TransferNotThroughCurve = 6000.
 *
 * Build: anchor build -p dynamic_bonding_curve -- --features local
 * Run:   yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/hook_holding_cap.tests.ts
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
  AccountLayout as TokenAccountLayout,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { createHash } from "crypto";

import {
  BaseFee,
  ConfigParameters,
  createConfig,
  createPoolWithToken2022,
  swap,
  SwapMode,
} from "./instructions";
import {
  createVirtualCurveProgram,
  generateAndFund,
  startSvm,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  U64_MAX,
} from "./utils";
import {
  deriveHookConfigAddress,
  deriveExtraAccountMetaListAddress,
} from "./utils/accounts";
import { getVirtualPool } from "./utils/fetcher";
import { IPWORLD_HOOK_PROGRAM_ID } from "./utils/constants";
import { VirtualCurveProgram } from "./utils/types";

const HOLDING_CAP_EXCEEDED = "HoldingCapExceeded";
const TRANSFER_NOT_THROUGH_CURVE = "TransferNotThroughCurve";

function globalDisc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — direct exact-boundary control over a standalone hooked Token-2022 mint
// ─────────────────────────────────────────────────────────────────────────────
describe("SPEC-DBC-AUDIT-001 — 5% holding-cap boundary, direct control (REQ-B-001)", () => {
  let svm: LiteSVM;
  let payer: Keypair;
  let vaultOwner: Keypair; // owns the pool-vault ATA (the exempt recipient)
  let mint: Keypair;
  let poolVault: PublicKey; // the exempt recipient (hook_config.pool_vault)

  const DECIMALS = 9;
  // Tiny round supply so 5% is an exact integer: 5% of 1_000_000 = 50_000.
  const SUPPLY = 1_000_000n;
  const FIVE_PCT = 50_000n;

  before(() => {
    svm = startSvm();
    payer = generateAndFund(svm);
    vaultOwner = generateAndFund(svm);
    mint = Keypair.generate();

    // 1) Token-2022 mint with TransferHook -> real ipworld-hook program.
    const mintLen = getMintLen([ExtensionType.TransferHook]);
    const rent = svm.minimumBalanceForRentExemption(BigInt(mintLen));
    sendOrThrow(svm, [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        space: mintLen,
        lamports: Number(rent),
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(mint.publicKey, payer.publicKey, IPWORLD_HOOK_PROGRAM_ID, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mint.publicKey, DECIMALS, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    ], [payer, mint]);

    // 2) pool-vault ATA = the exempt recipient; mint the WHOLE supply to it (the
    //    curve holds ~all supply pre-graduation).
    poolVault = ata(mint.publicKey, vaultOwner.publicKey);
    sendOrThrow(svm, [createAssociatedTokenAccountInstruction(payer.publicKey, poolVault, vaultOwner.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID)], [payer]);
    sendOrThrow(svm, [createMintToInstruction(mint.publicKey, poolVault, payer.publicKey, SUPPLY, [], TOKEN_2022_PROGRAM_ID)], [payer]);

    // 3) real initialize_extra_account_meta_list (so Token-2022 resolves the hook).
    const extraMeta = deriveExtraAccountMetaListAddress(mint.publicKey);
    sendOrThrow(svm, [new TransactionInstruction({
      programId: IPWORLD_HOOK_PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: extraMeta, isSigner: false, isWritable: true },
        { pubkey: mint.publicKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: globalDisc("initialize_extra_account_meta_list"),
    })], [payer]);

    // 4) write HookConfig directly (pool_vault = the exempt recipient). The on-chain
    //    initialize_hook_config needs a pool_authority PDA signer (Guard 1) which we
    //    cannot produce from TS; those guards are covered by the hook's Rust unit
    //    tests. Layout: 8 disc + 32 pool_vault + 1 bump.
    const hookConfig = deriveHookConfigAddress(mint.publicKey);
    const [, bump] = PublicKey.findProgramAddressSync([Buffer.from("hook_config"), mint.publicKey.toBuffer()], IPWORLD_HOOK_PROGRAM_ID);
    const cfg = Buffer.alloc(41);
    createHash("sha256").update("account:HookConfig").digest().subarray(0, 8).copy(cfg, 0);
    poolVault.toBuffer().copy(cfg, 8);
    cfg.writeUInt8(bump, 40);
    svm.setAccount(hookConfig, { lamports: 1_000_000_000, data: new Uint8Array(cfg), owner: IPWORLD_HOOK_PROGRAM_ID, executable: false });
  });

  /** transferChecked from `source` to `dest` with the hook accounts appended. */
  function transferWithHook(source: PublicKey, dest: PublicKey, authority: Keypair, amount: bigint) {
    const ix = createTransferCheckedInstruction(source, mint.publicKey, dest, authority.publicKey, amount, DECIMALS, [], TOKEN_2022_PROGRAM_ID);
    ix.keys.push(
      { pubkey: deriveExtraAccountMetaListAddress(mint.publicKey), isSigner: false, isWritable: false },
      { pubkey: deriveHookConfigAddress(mint.publicKey), isSigner: false, isWritable: false },
      { pubkey: IPWORLD_HOOK_PROGRAM_ID, isSigner: false, isWritable: false }
    );
    const tx = new Transaction().add(ix);
    tx.feePayer = authority.publicKey;
    tx.recentBlockhash = svm.latestBlockhash();
    tx.sign(authority);
    const r = svm.sendTransaction(tx);
    svm.expireBlockhash();
    return r;
  }

  it("BOUNDARY: a recipient landing at EXACTLY 5% of supply SUCCEEDS (inclusive boundary)", () => {
    const buyer = generateAndFund(svm);
    const buyerAta = ata(mint.publicKey, buyer.publicKey);
    sendOrThrow(svm, [createAssociatedTokenAccountInstruction(payer.publicKey, buyerAta, buyer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID)], [payer]);

    // Vault (exempt source) -> buyer: exactly 5% (50_000). post-balance == 5% → allowed.
    const r = transferWithHook(poolVault, buyerAta, vaultOwner, FIVE_PCT);
    if (r instanceof FailedTransactionMetadata) {
      throw new Error("exactly-5% transfer must succeed, got revert:\n" + r.meta().logs().join("\n").slice(-400));
    }
    expect(readAmount(svm, buyerAta)).to.equal(FIVE_PCT);
  });

  it("BOUNDARY: a transfer pushing the recipient OVER 5% reverts (HoldingCapExceeded)", () => {
    // Fresh buyer at exactly 5%, then one more unit → 50_001 > 5% → must revert.
    const buyer = generateAndFund(svm);
    const buyerAta = ata(mint.publicKey, buyer.publicKey);
    sendOrThrow(svm, [createAssociatedTokenAccountInstruction(payer.publicKey, buyerAta, buyer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID)], [payer]);
    // Seat them at exactly 5% first (allowed).
    const ok = transferWithHook(poolVault, buyerAta, vaultOwner, FIVE_PCT);
    expect(ok instanceof FailedTransactionMetadata, "seating at 5% should succeed").to.equal(false);

    // One more unit crosses the cap.
    const r = transferWithHook(poolVault, buyerAta, vaultOwner, 1n);
    expect(r instanceof FailedTransactionMetadata, "over-5% transfer must revert").to.equal(true);
    const logs = (r as FailedTransactionMetadata).meta().logs().join("\n");
    expect(logs, "expected HoldingCapExceeded:\n" + logs.slice(-400)).to.include(HOLDING_CAP_EXCEEDED);
    // Balance unchanged by the failed transfer.
    expect(readAmount(svm, buyerAta)).to.equal(FIVE_PCT);
  });

  it("BOUNDARY: a single transfer of > 5% to an empty recipient reverts (HoldingCapExceeded)", () => {
    const buyer = generateAndFund(svm);
    const buyerAta = ata(mint.publicKey, buyer.publicKey);
    sendOrThrow(svm, [createAssociatedTokenAccountInstruction(payer.publicKey, buyerAta, buyer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID)], [payer]);

    const r = transferWithHook(poolVault, buyerAta, vaultOwner, FIVE_PCT + 1n);
    expect(r instanceof FailedTransactionMetadata, "single >5% transfer must revert").to.equal(true);
    const logs = (r as FailedTransactionMetadata).meta().logs().join("\n");
    expect(logs).to.include(HOLDING_CAP_EXCEEDED);
    expect(readAmount(svm, buyerAta)).to.equal(0n);
  });

  it("EXEMPTION: a SELL back into the curve (recipient IS the pool vault) is NOT blocked even above 5%", () => {
    // Seat a buyer at exactly 5% (allowed), then have them sell ALL of it back to
    // the pool vault. The pool vault would then hold ~all supply (far > 5%), but it
    // is the exempt recipient, so the transfer is allowed.
    const buyer = generateAndFund(svm);
    const buyerAta = ata(mint.publicKey, buyer.publicKey);
    sendOrThrow(svm, [createAssociatedTokenAccountInstruction(payer.publicKey, buyerAta, buyer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID)], [payer]);
    const seat = transferWithHook(poolVault, buyerAta, vaultOwner, FIVE_PCT);
    expect(seat instanceof FailedTransactionMetadata, "seating at 5% should succeed").to.equal(false);

    const vaultBefore = readAmount(svm, poolVault);
    // buyer -> poolVault (SELL). dst == pool_vault → exempt, allowed regardless of >5%.
    const r = transferWithHook(buyerAta, poolVault, buyer, FIVE_PCT);
    if (r instanceof FailedTransactionMetadata) {
      throw new Error("SELL into the curve vault must NOT be blocked, got revert:\n" + r.meta().logs().join("\n").slice(-400));
    }
    expect(readAmount(svm, poolVault)).to.equal(vaultBefore + FIVE_PCT);
    expect(readAmount(svm, buyerAta)).to.equal(0n);
  });

  it("EXEMPTION: the vault remains far above 5% after a SELL — its post-balance is never the limiting factor", () => {
    // The pool vault holds the bulk of supply (it started with 100%). A buyer seated
    // at exactly 5% sells back; the vault's post-transfer balance is well above 5% of
    // supply, yet the transfer is allowed because the vault is the exempt recipient.
    // This asserts the exemption is about the RECIPIENT identity (== pool_vault), not
    // the transferred amount or the resulting balance.
    const buyer = generateAndFund(svm);
    const buyerAta = ata(mint.publicKey, buyer.publicKey);
    sendOrThrow(svm, [createAssociatedTokenAccountInstruction(payer.publicKey, buyerAta, buyer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID)], [payer]);
    const seat = transferWithHook(poolVault, buyerAta, vaultOwner, FIVE_PCT);
    expect(seat instanceof FailedTransactionMetadata).to.equal(false);

    const vaultBefore = readAmount(svm, poolVault);
    // vault already holds >> 5% of SUPPLY; receiving the SELL keeps it >> 5% — allowed.
    expect(vaultBefore * 100n > SUPPLY * 5n, "sanity: vault is over the cap").to.equal(true); // …

    const r = transferWithHook(buyerAta, poolVault, buyer, FIVE_PCT);
    expect(r instanceof FailedTransactionMetadata, "SELL into exempt vault must succeed").to.equal(false); // …yet the transfer to it is allowed.
    expect(readAmount(svm, poolVault)).to.equal(vaultBefore + FIVE_PCT);
  });

  it("P2P BLOCK (REQ-B-002): a wallet-to-wallet transfer (neither side is the vault) reverts (TransferNotThroughCurve)", () => {
    // Seat buyer1 at 5% from the vault (one side IS the vault → allowed).
    const buyer1 = generateAndFund(svm);
    const buyer1Ata = ata(mint.publicKey, buyer1.publicKey);
    sendOrThrow(svm, [createAssociatedTokenAccountInstruction(payer.publicKey, buyer1Ata, buyer1.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID)], [payer]);
    const seat = transferWithHook(poolVault, buyer1Ata, vaultOwner, FIVE_PCT);
    expect(seat instanceof FailedTransactionMetadata, "vault->buyer1 should succeed").to.equal(false);

    // buyer1 -> buyer2 (neither is the vault) → P2P block.
    const buyer2 = generateAndFund(svm);
    const buyer2Ata = ata(mint.publicKey, buyer2.publicKey);
    sendOrThrow(svm, [createAssociatedTokenAccountInstruction(payer.publicKey, buyer2Ata, buyer2.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID)], [payer]);
    const r = transferWithHook(buyer1Ata, buyer2Ata, buyer1, 1_000n);
    expect(r instanceof FailedTransactionMetadata, "P2P transfer must revert").to.equal(true);
    const logs = (r as FailedTransactionMetadata).meta().logs().join("\n");
    expect(logs, "expected TransferNotThroughCurve:\n" + logs.slice(-400)).to.include(TRANSFER_NOT_THROUGH_CURVE);
  });

  // helpers bound to this mint/svm
  function ata(m: PublicKey, owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(m, owner, false, TOKEN_2022_PROGRAM_ID);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — end-to-end through real DBC swaps (the live transfer-hook CPI)
// ─────────────────────────────────────────────────────────────────────────────
describe("SPEC-DBC-AUDIT-001 — 5% holding cap end-to-end via DBC swaps (REQ-B-001)", () => {
  let svm: LiteSVM;
  let program: VirtualCurveProgram;
  let partner: Keypair;
  let poolCreator: Keypair;
  let config: PublicKey;
  let pool: PublicKey;
  let baseMint: PublicKey;

  before(async () => {
    svm = startSvm();
    program = createVirtualCurveProgram();
    partner = generateAndFund(svm);
    poolCreator = generateAndFund(svm);

    config = await createConfig(svm, program, {
      payer: partner,
      feeClaimer: partner.publicKey,
      quoteMint: NATIVE_MINT,
      instructionParams: capConfig(),
    });
    pool = await createPoolWithToken2022(svm, program, {
      poolCreator,
      payer: poolCreator,
      quoteMint: NATIVE_MINT,
      config,
      instructionParams: { name: "Cap Token", symbol: "CAP", uri: "x" },
    });
    baseMint = getVirtualPool(svm, program, pool).baseMint;
  });

  it("ACCUMULATION: many buyers each acquiring < 5% succeed and the curve progresses", async () => {
    const reserveBefore = Number(getVirtualPool(svm, program, pool).quoteReserve);

    // Each buyer does a small 0.1 SOL buy → well under 5% of supply per wallet.
    // (Same cap-aware pattern as graduation_hook_removal.) 8 buys is enough to show
    // monotonic curve progression without graduating.
    let successful = 0;
    for (let i = 0; i < 8; i++) {
      const buyer = generateAndFund(svm);
      const r = await swap(svm, program, {
        config,
        payer: buyer,
        pool,
        inputTokenMint: NATIVE_MINT,
        outputTokenMint: baseMint,
        amountIn: new BN(LAMPORTS_PER_SOL * 0.1),
        minimumAmountOut: new BN(0),
        swapMode: SwapMode.PartialFill,
        referralTokenAccount: null,
      });
      successful++;
      expect(r.completed, "8 small buys must not graduate the pool").to.equal(false);
    }
    expect(successful).to.equal(8);

    // Curve progressed: quote reserve strictly increased.
    const reserveAfter = Number(getVirtualPool(svm, program, pool).quoteReserve);
    expect(reserveAfter).to.be.greaterThan(reserveBefore);
  });

  it("OVER-CAP: a single buy handing one buyer > 5% of supply reverts (HoldingCapExceeded) from inside the swap hook CPI", async () => {
    // A 4 SOL buy (near the 5 SOL migration threshold) hands the buyer far more than
    // 5% of supply. The base-vault -> buyer Token-2022 transfer fires the hook, which
    // reverts the whole swap with HoldingCapExceeded.
    const whale = generateAndFund(svm);
    let threw = false;
    try {
      await swap(svm, program, {
        config,
        payer: whale,
        pool,
        inputTokenMint: NATIVE_MINT,
        outputTokenMint: baseMint,
        amountIn: new BN(LAMPORTS_PER_SOL * 4),
        minimumAmountOut: new BN(0),
        swapMode: SwapMode.PartialFill,
        referralTokenAccount: null,
      });
    } catch (e: any) {
      threw = true;
      const m = String(e.message);
      expect(
        m.includes(HOLDING_CAP_EXCEEDED) || m.includes("0x1773"),
        "expected HoldingCapExceeded, got:\n" + m.slice(-500)
      ).to.equal(true);
    }
    expect(threw, "over-cap buy must revert").to.equal(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shared config + low-level helpers
// ─────────────────────────────────────────────────────────────────────────────
function capConfig(): ConfigParameters {
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

function sendOrThrow(svm: LiteSVM, ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(...signers);
  const r = svm.sendTransaction(tx);
  if (r instanceof FailedTransactionMetadata) throw new Error("setup tx failed:\n" + r.meta().logs().join("\n"));
  svm.expireBlockhash();
}

function readAmount(svm: LiteSVM, tokenAccount: PublicKey): bigint {
  const acct = svm.getAccount(tokenAccount);
  if (!acct) throw new Error("token account missing: " + tokenAccount.toBase58());
  return BigInt(TokenAccountLayout.decode(Buffer.from(acct.data)).amount.toString());
}
