import { BN } from "@coral-xyz/anchor";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";
import { LiteSVM } from "litesvm";
import {
  createVirtualCurveProgram,
  derivePartnerMetadata,
  derivePoolAuthority,
  getOrCreateAssociatedTokenAccount,
  getTokenAccount,
  getTokenProgram,
  sendTransactionMaybeThrow,
  unwrapSOLInstruction,
} from "../utils";
import {
  getConfig,
  getPartnerMetadata,
  getTokenVerification,
  getVirtualPool,
} from "../utils/fetcher";
import { VirtualCurveProgram } from "../utils/types";
import { deriveExtraAccountMetaListAddress, deriveHookConfigAddress, deriveTokenVerificationAddress } from "../utils/accounts";
import { IPWORLD_HOOK_PROGRAM_ID } from "../utils/constants";

export type BaseFee = {
  cliffFeeNumerator: BN;
  firstFactor: number;
  secondFactor: BN;
  thirdFactor: BN;
  baseFeeMode: number;
};

export type DynamicFee = {
  binStep: number;
  binStepU128: BN;
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  maxVolatilityAccumulator: number;
  variableFeeControl: number;
};

export type LockedVestingParams = {
  amountPerPeriod: BN;
  cliffDurationFromMigrationTime: BN;
  frequency: BN;
  numberOfPeriod: BN;
  cliffUnlockAmount: BN;
};

export type TokenSupplyParams = {
  preMigrationTokenSupply: BN;
  postMigrationTokenSupply: BN;
};

export type LiquidityDistributionParameters = {
  sqrtPrice: BN;
  liquidity: BN;
};

export type MigrationFeeParams = {
  feePercentage: number;
  creatorFeePercentage: number;
};

export type MigratedPoolMarketCapFeeSchedulerParams = {
  numberOfPeriod: number;
  sqrtPriceStepBps: number;
  schedulerExpirationDuration: number;
  reductionFactor: BN;
};

export type ConfigParameters = {
  poolFees: {
    baseFee: BaseFee;
    dynamicFee: DynamicFee | null;
  };
  collectFeeMode: number;
  migrationOption: number;
  activationType: number;
  tokenType: number;
  tokenDecimal: number;
  migrationQuoteThreshold: BN;
  partnerLiquidityPercentage: number;
  partnerPermanentLockedLiquidityPercentage: number;
  creatorLiquidityPercentage: number;
  creatorPermanentLockedLiquidityPercentage: number;
  sqrtStartPrice: BN;
  lockedVesting: LockedVestingParams;
  migrationFeeOption: number;
  tokenSupply: TokenSupplyParams | null;
  creatorTradingFeePercentage: number;
  tokenUpdateAuthority: number;
  migrationFee: MigrationFeeParams;
  migratedPoolFee: {
    poolFeeBps: number;
    collectFeeMode: number;
    dynamicFee: number;
  };
  poolCreationFee: BN;
  migratedPoolBaseFeeMode: number;
  migratedPoolMarketCapFeeSchedulerParams: MigratedPoolMarketCapFeeSchedulerParams | null;
  partnerLiquidityVestingInfo: LiquidityVestingInfoParams;
  creatorLiquidityVestingInfo: LiquidityVestingInfoParams;
  enableFirstSwapWithMinFee: boolean;
  compoundingFeeBps: number;
  curve: Array<LiquidityDistributionParameters>;
  // Fee share parameters (IPWorld SELL split; SPEC-DBC-004 Phase 3 — REQ-I-001
  // removed `creatorShare` from on-chain `PoolConfig`).
  // SPEC-DBC-AUDIT-001 Phase 8 (REQ-A-005): `referralShare` was REMOVED from
  // CreateConfigParameters — referral is handled per-swap, not via config.
  // All four are optional here; `createConfig` applies defaults when omitted.
  // `referralShare` is accepted but ignored (silently dropped) for back-compat
  // with legacy test literals that still set it.
  ipOwnerShare?: number;
  airdropShare?: number;
  referralShare?: number;
  tokenAirdropShare?: number;
};

export type LiquidityVestingInfoParams = {
  vestingPercentage: number;
  cliffDurationFromMigrationTime: number;
  bpsPerPeriod: number;
  frequency: number;
  numberOfPeriods: number;
};

export type CreateConfigParams<T> = {
  payer: Keypair;
  feeClaimer: PublicKey;
  quoteMint: PublicKey;
  instructionParams: T;
};

export async function createConfig(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  params: CreateConfigParams<ConfigParameters>
): Promise<PublicKey> {
  const { payer, feeClaimer, quoteMint, instructionParams } =
    params;
  const config = Keypair.generate();

  if (instructionParams.migratedPoolMarketCapFeeSchedulerParams == null) {
    instructionParams.migratedPoolMarketCapFeeSchedulerParams = {
      numberOfPeriod: 0,
      sqrtPriceStepBps: 0,
      schedulerExpirationDuration: 0,
      reductionFactor: new BN(0),
    };
  }

  // Apply defaults for IPWorld 4-way SELL fee shares if not provided.
  // Note: `creatorShare` was removed in SPEC-DBC-004 Phase 3 (REQ-I-001).
  // Any legacy callers passing it via spread will have their value silently
  // dropped — `createConfig` below includes only the supported fields.
  const ipOwnerShare = instructionParams.ipOwnerShare ?? 50000;
  const airdropShare = instructionParams.airdropShare ?? 30000;
  const tokenAirdropShare = instructionParams.tokenAirdropShare ?? 50000;
  // SPEC-DBC-AUDIT-001 Phase 8 (REQ-A-005): `referralShare` was removed from
  // CreateConfigParameters. Strip it from the spread so it is never forwarded
  // to the program (legacy literals may still set it).
  const { referralShare: _droppedReferralShare, ...instructionParamsNoReferral } =
    instructionParams;

  // Ensure collectFeeMode is OutputToken (1), not QuoteToken (0) for most
  // pools. Exception: fee rate limiter (baseFeeMode=2) requires QuoteToken
  // mode — keep collectFeeMode=0 in that case.
  const isRateLimiterMode = instructionParams.poolFees.baseFee.baseFeeMode === 2;
  const collectFeeMode =
    instructionParams.collectFeeMode === 0 && !isRateLimiterMode
      ? 1
      : instructionParams.collectFeeMode;

  // MigrationOption 0 (MeteoraDamm) is disabled — redirect to DammV2 (1)
  const migrationOption =
    instructionParams.migrationOption === 0 ? 1 : instructionParams.migrationOption;

  // SPL Token pools are disabled (S-02) — force tokenType to Token2022 (1)
  const tokenType =
    instructionParams.tokenType === 0 ? 1 : instructionParams.tokenType;

  // Normalize migratedPoolFee: when migrationFeeOption != Customizable (1),
  // the program requires ALL migratedPoolFee fields to be zero.
  // When poolFeeBps > 0, ensure it's in valid range [10, 1000].
  const rawMPF = instructionParams.migratedPoolFee;
  const migratedPoolFee =
    rawMPF.poolFeeBps === 0
      ? { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 0 }
      : rawMPF;

  const poolFees = instructionParams.poolFees;

  const transaction = await program.methods
    .createConfig({
      ...instructionParamsNoReferral,
      collectFeeMode,
      migrationOption,
      tokenType,
      migratedPoolFee,
      poolFees,
      ipOwnerShare,
      airdropShare,
      tokenAirdropShare,
      // referralShare intentionally omitted (removed from program — REQ-A-005)
      padding: new Array(2).fill(0),
    })
    .accountsPartial({
      config: config.publicKey,
      feeClaimer,
      quoteMint,
      payer: payer.publicKey,
    })
    .transaction();

  sendTransactionMaybeThrow(svm, transaction, [payer, config]);
  //
  const configState = getConfig(svm, program, config.publicKey);
  // TODO add assertion data fields
  expect(configState.quoteMint.toString()).equal(quoteMint.toString());
  expect(configState.partnerLiquidityPercentage).equal(
    instructionParams.partnerLiquidityPercentage
  );
  expect(configState.partnerPermanentLockedLiquidityPercentage).equal(
    instructionParams.partnerPermanentLockedLiquidityPercentage
  );
  expect(configState.creatorLiquidityPercentage).equal(
    instructionParams.creatorLiquidityPercentage
  );
  expect(configState.creatorPermanentLockedLiquidityPercentage).equal(
    instructionParams.creatorPermanentLockedLiquidityPercentage
  );

  return config.publicKey;
}

export async function createPartnerMetadata(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  params: {
    name: string;
    website: string;
    logo: string;
    feeClaimer: Keypair;
    payer: Keypair;
  }
) {
  const { payer, feeClaimer, name, website, logo } = params;
  const partnerMetadata = derivePartnerMetadata(feeClaimer.publicKey);
  const transaction = await program.methods
    .createPartnerMetadata({
      padding: new Array(96).fill(0),
      name,
      website,
      logo,
    })
    .accountsPartial({
      partnerMetadata,
      feeClaimer: feeClaimer.publicKey,
      payer: payer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  sendTransactionMaybeThrow(svm, transaction, [payer, feeClaimer]);
  //
  const metadataState = getPartnerMetadata(svm, program, partnerMetadata);
  expect(metadataState.feeClaimer.toString()).equal(
    feeClaimer.publicKey.toString()
  );
  expect(metadataState.name.toString()).equal(name.toString());
  expect(metadataState.website.toString()).equal(website.toString());
  expect(metadataState.logo.toString()).equal(logo.toString());
}

export type ClaimTradeFeeParams = {
  feeClaimer: Keypair;
  pool: PublicKey;
  maxBaseAmount: BN;
  maxQuoteAmount: BN;
};
export async function claimTradingFee(
  _svm: LiteSVM,
  _program: VirtualCurveProgram,
  _params: ClaimTradeFeeParams
): Promise<any> {
  // SPEC-DBC-AUDIT-001 / A-04 (partner system removal): the partner+creator
  // trading-fee split was replaced by the IPWorld fee model. `claim_trading_fee`
  // no longer exists on-chain. Tests exercising the legacy partner fee claim
  // are removed; this stub guards any straggler caller with a clear error.
  throw new Error(
    "claimTradingFee removed (A-04 partner system removal). Use the IPWorld " +
      "claim ops: claimProtocolFee / claimIpOwnerFee / claimAirdropFee."
  );
}

export type PartnerWithdrawSurplusParams = {
  feeClaimer: Keypair;
  virtualPool: PublicKey;
};
export async function partnerWithdrawSurplus(
  _svm: LiteSVM,
  _program: VirtualCurveProgram,
  _params: PartnerWithdrawSurplusParams
): Promise<any> {
  // SPEC-DBC-AUDIT-001 / A-04 (partner system removal): partner_withdraw_surplus
  // no longer exists on-chain. Surplus handling moved to creator_withdraw_surplus.
  throw new Error(
    "partnerWithdrawSurplus removed (A-04 partner system removal). Use " +
      "creatorWithdrawSurplus instead."
  );
}

export async function withdrawLeftover(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  params: {
    payer: Keypair;
    virtualPool: PublicKey;
  }
): Promise<any> {
  const { payer, virtualPool } = params;
  const poolState = getVirtualPool(svm, program, virtualPool);
  const configState = getConfig(svm, program, poolState.config);
  const poolAuthority = derivePoolAuthority();

  // AC-A08: read ip_treasury from TokenVerification PDA instead of config.leftoverReceiver
  const tokenVerificationPDA = deriveTokenVerificationAddress(virtualPool);
  const tokenVerification = getTokenVerification(svm, program, tokenVerificationPDA);
  const ipTreasury = tokenVerification.ipTreasury;

  const tokenBaseProgram =
    configState.tokenType == 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];
  const { ata: tokenBaseAccount, ix: createBaseTokenAccountIx } =
    getOrCreateAssociatedTokenAccount(
      svm,
      payer,
      poolState.baseMint,
      ipTreasury,
      tokenBaseProgram
    );

  createBaseTokenAccountIx && preInstructions.push(createBaseTokenAccountIx);
  const transaction = await program.methods
    .withdrawLeftover()
    .accountsPartial({
      poolAuthority,
      config: poolState.config,
      virtualPool,
      tokenVerification: tokenVerificationPDA,
      tokenBaseAccount,
      baseVault: poolState.baseVault,
      baseMint: poolState.baseMint,
      tokenBaseProgram,
    })
    .preInstructions(preInstructions)
    .postInstructions(postInstructions)
    .transaction();

  sendTransactionMaybeThrow(svm, transaction, [payer]);
}

export type PartnerWithdrawMigrationFeeParams = {
  partner: Keypair;
  virtualPool: PublicKey;
};
export async function partnerWithdrawMigrationFee(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  params: PartnerWithdrawMigrationFeeParams
): Promise<void> {
  const { partner, virtualPool } = params;
  const poolAuthority = derivePoolAuthority();
  const poolState = getVirtualPool(svm, program, virtualPool);
  const configState = getConfig(svm, program, poolState.config);

  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];
  const { ata: tokenQuoteAccount, ix: createQuoteTokenAccountIx } =
    getOrCreateAssociatedTokenAccount(
      svm,
      partner,
      configState.quoteMint,
      partner.publicKey,
      getTokenProgram(configState.quoteTokenFlag)
    );

  createQuoteTokenAccountIx && preInstructions.push(createQuoteTokenAccountIx);

  if (configState.quoteMint.equals(NATIVE_MINT)) {
    const unrapSOLIx = unwrapSOLInstruction(partner.publicKey);
    unrapSOLIx && postInstructions.push(unrapSOLIx);
  }

  // SPEC-DBC-AUDIT-001: withdraw_migration_fee no longer takes a flag arg.
  const transaction = await program.methods
    .withdrawMigrationFee()
    .accountsPartial({
      poolAuthority,
      config: poolState.config,
      virtualPool,
      tokenQuoteAccount,
      quoteVault: poolState.quoteVault,
      quoteMint: configState.quoteMint,
      sender: partner.publicKey,
      tokenQuoteProgram: getTokenProgram(configState.quoteTokenFlag),
    })
    .preInstructions(preInstructions)
    .postInstructions(postInstructions)
    .transaction();

  sendTransactionMaybeThrow(svm, transaction, [partner]);
}

export async function claimPartnerPoolCreationFee(
  _svm: LiteSVM,
  _feeClaimer: Keypair,
  _config: PublicKey,
  _virtualPool: PublicKey,
  _feeReceiver: PublicKey
) {
  // SPEC-DBC-AUDIT-001 / A-04 (partner system removal): the partner
  // pool-creation-fee claim path no longer exists on-chain.
  throw new Error(
    "claimPartnerPoolCreationFee removed (A-04 partner system removal)."
  );
}
