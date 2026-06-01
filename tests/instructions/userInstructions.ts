import { BN } from "@coral-xyz/anchor";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";
import { LiteSVM } from "litesvm";
import {
  deriveVirtualPoolMetadata,
  getOrCreateAssociatedTokenAccount,
  getTokenAccount,
  METAPLEX_PROGRAM_ID,
  sendTransactionMaybeThrow,
  unwrapSOLInstruction,
  wrapSOLInstruction,
} from "../utils";
import {
  deriveExtraAccountMetaListAddress,
  deriveHookConfigAddress,
  deriveIpworldStateAddress,
  deriveMetadataAccount,
  derivePoolAddress,
  derivePoolAuthority,
  deriveTokenVaultAddress,
  deriveTokenVerificationAddress,
} from "../utils/accounts";
import { IPWORLD_HOOK_PROGRAM_ID } from "../utils/constants";
import {
  getConfig,
  getVirtualPool,
  getVirtualPoolMetadata,
} from "../utils/fetcher";
import { VirtualCurveProgram } from "../utils/types";
import { getSvmAuthority, generateAndFund } from "../utils/svm";
import { mintSplTokenTo } from "../utils/token";
import { buildEd25519Ix, serializeLaunchAuth, serializeTradeAuth } from "../utils/ed25519";

export type InitializePoolParameters = {
  name: string;
  symbol: string;
  uri: string;
};
export type CreatePoolSplTokenParams = {
  payer: Keypair;
  poolCreator: Keypair;
  quoteMint: PublicKey;
  config: PublicKey;
  instructionParams: InitializePoolParameters;
};

export type CreatePoolToken2022Params = CreatePoolSplTokenParams;

export async function createInitializePoolWithSplTokenIx(
  _svm: LiteSVM,
  _program: VirtualCurveProgram,
  _params: CreatePoolSplTokenParams
): Promise<{
  instruction: TransactionInstruction;
  pool: PublicKey;
  baseMintKP: Keypair;
}> {
  // SPEC-DBC-AUDIT-001 (S-02): initialize_virtual_pool_with_spl_token was DELETED
  // — IPWorld is Token-2022 only. There is no single-instruction SPL pool-create
  // builder anymore; use createPoolWithToken2022 (which also emits the required
  // Ed25519 LaunchAuth pre-instruction).
  throw new Error(
    "createInitializePoolWithSplTokenIx removed (S-02: SPL pool creation deleted, " +
      "Token-2022 only). Use createPoolWithToken2022."
  );
}

export async function createPoolWithSplToken(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  params: CreatePoolSplTokenParams
): Promise<PublicKey> {
  // SPL Token pools are disabled — IPWorld uses Token-2022 exclusively.
  // Redirect to createPoolWithToken2022 transparently.
  return createPoolWithToken2022(svm, program, params);
}

export async function createPoolWithToken2022(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  params: CreatePoolToken2022Params
): Promise<PublicKey> {
  const { payer, quoteMint, config, instructionParams, poolCreator } = params;

  const poolAuthority = derivePoolAuthority();
  const baseMintKP = Keypair.generate();
  const pool = derivePoolAddress(config, baseMintKP.publicKey, quoteMint);
  const baseVault = deriveTokenVaultAddress(baseMintKP.publicKey, pool);
  const quoteVault = deriveTokenVaultAddress(quoteMint, pool);
  const hookConfig = deriveHookConfigAddress(baseMintKP.publicKey);
  const extraAccountMetaList = deriveExtraAccountMetaListAddress(baseMintKP.publicKey);

  // Build Ed25519 LaunchAuth instruction (must precede pool creation ix)
  const authority = getSvmAuthority();
  const launchAuthMsg = serializeLaunchAuth(poolCreator.publicKey, config, pool);
  const ed25519Ix = buildEd25519Ix(authority, launchAuthMsg);

  const poolCreateIx = await program.methods
    .initializeVirtualPoolWithToken2022(instructionParams)
    .accountsPartial({
      config,
      baseMint: baseMintKP.publicKey,
      quoteMint,
      pool,
      payer: payer.publicKey,
      creator: poolCreator.publicKey,
      poolAuthority,
      baseVault,
      quoteVault,
      tokenQuoteProgram: TOKEN_PROGRAM_ID,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      ipworldHookProgram: IPWORLD_HOOK_PROGRAM_ID,
      hookConfig,
      extraAccountMetaList,
      ipworldState: deriveIpworldStateAddress(),
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();

  const transaction = new Transaction().add(
    ed25519Ix,
    poolCreateIx,
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 400_000,
    })
  );

  sendTransactionMaybeThrow(svm, transaction, [payer, baseMintKP, poolCreator]);

  return pool;
}

export enum SwapMode {
  ExactIn,
  PartialFill,
  ExactOut,
}

export type SwapParams = {
  config: PublicKey;
  payer: Keypair;
  pool: PublicKey;
  inputTokenMint: PublicKey;
  outputTokenMint: PublicKey;
  amountIn: BN;
  minimumAmountOut: BN;
  swapMode: SwapMode;
  referralTokenAccount: PublicKey | null;
};

export type SwapParams2 = {
  config: PublicKey;
  payer: Keypair;
  pool: PublicKey;
  inputTokenMint: PublicKey;
  outputTokenMint: PublicKey;
  amount0: BN;
  amount1: BN;
  swapMode: number;
  referralTokenAccount: PublicKey | null;
};

export async function swapPartialFill(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  params: SwapParams
): Promise<{
  pool: PublicKey;
  computeUnitsConsumed: number;
  message: any;
  numInstructions: number;
  completed: boolean;
}> {
  const {
    config,
    payer,
    pool,
    inputTokenMint,
    outputTokenMint,
    amountIn,
    minimumAmountOut,
    referralTokenAccount,
  } = params;

  const poolAuthority = derivePoolAuthority();
  let poolState = getVirtualPool(svm, program, pool);

  const configState = getConfig(svm, program, config);

  const tokenBaseProgram =
    configState.tokenType == 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const isInputBaseMint = inputTokenMint.equals(poolState.baseMint);

  const quoteMint = isInputBaseMint ? outputTokenMint : inputTokenMint;
  const [inputTokenProgram, outputTokenProgram] = isInputBaseMint
    ? [tokenBaseProgram, TOKEN_PROGRAM_ID]
    : [TOKEN_PROGRAM_ID, tokenBaseProgram];

  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];

  const preUserQuoteTokenBalance = 0;
  const preBaseVaultBalance = getTokenAccount(svm, poolState.baseVault).amount;
  const [
    { ata: inputTokenAccount, ix: createInputTokenXIx },
    { ata: outputTokenAccount, ix: createOutputTokenYIx },
  ] = [
    getOrCreateAssociatedTokenAccount(
      svm,
      payer,
      inputTokenMint,
      payer.publicKey,
      inputTokenProgram
    ),
    getOrCreateAssociatedTokenAccount(
      svm,
      payer,
      outputTokenMint,
      payer.publicKey,
      outputTokenProgram
    ),
  ];
  createInputTokenXIx && preInstructions.push(createInputTokenXIx);
  createOutputTokenYIx && preInstructions.push(createOutputTokenYIx);

  if (inputTokenMint.equals(NATIVE_MINT) && !amountIn.isZero()) {
    const wrapSOLIx = wrapSOLInstruction(
      payer.publicKey,
      inputTokenAccount,
      BigInt(amountIn.toString())
    );

    preInstructions.push(...wrapSOLIx);
  }

  if (outputTokenMint.equals(NATIVE_MINT)) {
    const unrapSOLIx = unwrapSOLInstruction(payer.publicKey);

    unrapSOLIx && postInstructions.push(unrapSOLIx);
  }

  // Ed25519 TradeAuth must be the instruction immediately before swap (current_idx - 1)
  const authority = getSvmAuthority();
  const tradeAuthMsg = serializeTradeAuth(payer.publicKey, Math.floor(Date.now() / 1000) + 3600);
  preInstructions.push(buildEd25519Ix(authority, tradeAuthMsg));

  const transaction = await program.methods
    .swap({
      amount0: amountIn,
      amount1: minimumAmountOut,
      swapMode: 1,
    })
    .accountsPartial({
      poolAuthority,
      config,
      pool,
      inputTokenAccount,
      outputTokenAccount,
      baseVault: poolState.baseVault,
      quoteVault: poolState.quoteVault,
      baseMint: poolState.baseMint,
      quoteMint,
      payer: payer.publicKey,
      tokenBaseProgram,
      tokenQuoteProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount,
      // SPEC-DBC-AUDIT-001 Phase 2 (REQ-A-003): swap requires the pool's
      // TokenVerification PDA whenever a referral payout is requested; anchor
      // still wants the optional account passed explicitly (null when no referral).
      tokenVerification: referralTokenAccount
        ? deriveTokenVerificationAddress(pool)
        : null,
      ipworldState: deriveIpworldStateAddress(),
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .remainingAccounts(
      [
        {
          isSigner: false,
          isWritable: false,
          pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        },
        {
          isSigner: false,
          isWritable: false,
          pubkey: IPWORLD_HOOK_PROGRAM_ID,
        },
        {
          isSigner: false,
          isWritable: false,
          pubkey: deriveExtraAccountMetaListAddress(poolState.baseMint),
        },
        {
          isSigner: false,
          isWritable: false,
          pubkey: deriveHookConfigAddress(poolState.baseMint),
        },
      ]
    )
    .preInstructions(preInstructions)
    .postInstructions(postInstructions)
    .transaction();

  transaction.recentBlockhash = svm.latestBlockhash();
  transaction.feePayer = payer.publicKey;
  transaction.sign(payer);

  let simu = svm.simulateTransaction(transaction);
  const consumedCUSwap = Number(simu.meta().computeUnitsConsumed);

  sendTransactionMaybeThrow(svm, transaction, [payer]);

  poolState = getVirtualPool(svm, program, pool);
  const configs = getConfig(svm, program, config);
  return {
    pool,
    computeUnitsConsumed: consumedCUSwap,
    message: simu.meta().logs[0],
    numInstructions: transaction.instructions.length,
    completed:
      Number(poolState.quoteReserve) >= Number(configs.migrationQuoteThreshold),
  };
}

export async function swap(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  params: SwapParams
): Promise<{
  pool: PublicKey;
  computeUnitsConsumed: number;
  message: any;
  numInstructions: number;
  completed: boolean;
}> {
  const {
    config,
    payer,
    pool,
    inputTokenMint,
    outputTokenMint,
    amountIn,
    minimumAmountOut,
    swapMode,
    referralTokenAccount,
  } = params;

  const poolAuthority = derivePoolAuthority();
  let poolState = getVirtualPool(svm, program, pool);

  const configState = getConfig(svm, program, config);

  const tokenBaseProgram =
    configState.tokenType == 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const isInputBaseMint = inputTokenMint.equals(poolState.baseMint);

  const quoteMint = isInputBaseMint ? outputTokenMint : inputTokenMint;
  const [inputTokenProgram, outputTokenProgram] = isInputBaseMint
    ? [tokenBaseProgram, TOKEN_PROGRAM_ID]
    : [TOKEN_PROGRAM_ID, tokenBaseProgram];

  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];

  const [
    { ata: inputTokenAccount, ix: createInputTokenXIx },
    { ata: outputTokenAccount, ix: createOutputTokenYIx },
  ] = [
    getOrCreateAssociatedTokenAccount(
      svm,
      payer,
      inputTokenMint,
      payer.publicKey,
      inputTokenProgram
    ),
    getOrCreateAssociatedTokenAccount(
      svm,
      payer,
      outputTokenMint,
      payer.publicKey,
      outputTokenProgram
    ),
  ];
  createInputTokenXIx && preInstructions.push(createInputTokenXIx);
  createOutputTokenYIx && preInstructions.push(createOutputTokenYIx);

  if (inputTokenMint.equals(NATIVE_MINT) && !amountIn.isZero()) {
    const wrapSOLIx = wrapSOLInstruction(
      payer.publicKey,
      inputTokenAccount,
      BigInt(amountIn.toString())
    );

    preInstructions.push(...wrapSOLIx);
  }

  if (outputTokenMint.equals(NATIVE_MINT)) {
    const unrapSOLIx = unwrapSOLInstruction(payer.publicKey);

    unrapSOLIx && postInstructions.push(unrapSOLIx);
  }

  // Ed25519 TradeAuth must be the instruction immediately before swap (current_idx - 1)
  const authority = getSvmAuthority();
  const tradeAuthMsg = serializeTradeAuth(payer.publicKey, Math.floor(Date.now() / 1000) + 3600);
  preInstructions.push(buildEd25519Ix(authority, tradeAuthMsg));

  const transaction = await program.methods
    .swap({ amount0: amountIn, amount1: minimumAmountOut, swapMode: swapMode })
    .accountsPartial({
      poolAuthority,
      config,
      pool,
      inputTokenAccount,
      outputTokenAccount,
      baseVault: poolState.baseVault,
      quoteVault: poolState.quoteVault,
      baseMint: poolState.baseMint,
      quoteMint,
      payer: payer.publicKey,
      tokenBaseProgram,
      tokenQuoteProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount,
      // SPEC-DBC-AUDIT-001 Phase 2 (REQ-A-003): swap requires the pool's
      // TokenVerification PDA whenever a referral payout is requested; anchor
      // still wants the optional account passed explicitly (null when no referral).
      tokenVerification: referralTokenAccount
        ? deriveTokenVerificationAddress(pool)
        : null,
      ipworldState: deriveIpworldStateAddress(),
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .remainingAccounts(
      [
        {
          isSigner: false,
          isWritable: false,
          pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        },
        // Hook accounts for Token-2022 transfer hook resolution
        {
          isSigner: false,
          isWritable: false,
          pubkey: IPWORLD_HOOK_PROGRAM_ID,
        },
        {
          isSigner: false,
          isWritable: false,
          pubkey: deriveExtraAccountMetaListAddress(poolState.baseMint),
        },
        {
          isSigner: false,
          isWritable: false,
          pubkey: deriveHookConfigAddress(poolState.baseMint),
        },
      ]
    )
    .preInstructions(preInstructions)
    .postInstructions(postInstructions)
    .transaction();

  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 400_000,
    })
  );

  transaction.recentBlockhash = svm.latestBlockhash();
  transaction.sign(payer);

  let simu = svm.simulateTransaction(transaction);
  const consumedCUSwap = Number(simu.meta().computeUnitsConsumed);
  sendTransactionMaybeThrow(svm, transaction, [payer]);

  poolState = getVirtualPool(svm, program, pool);
  const configs = getConfig(svm, program, config);
  return {
    pool,
    computeUnitsConsumed: consumedCUSwap,
    message: simu.meta().logs()[0],
    numInstructions: transaction.instructions.length,
    completed:
      Number(poolState.quoteReserve) >= Number(configs.migrationQuoteThreshold),
  };
}

export async function getSwap2Instruction(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  params: SwapParams
): Promise<TransactionInstruction> {
  const {
    config,
    payer,
    pool,
    inputTokenMint,
    outputTokenMint,
    amountIn,
    minimumAmountOut,
    referralTokenAccount,
  } = params;

  const poolAuthority = derivePoolAuthority();
  let poolState = getVirtualPool(svm, program, pool);

  const configState = getConfig(svm, program, config);

  const tokenBaseProgram =
    configState.tokenType == 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const isInputBaseMint = inputTokenMint.equals(poolState.baseMint);

  const quoteMint = isInputBaseMint ? outputTokenMint : inputTokenMint;
  const [inputTokenProgram, outputTokenProgram] = isInputBaseMint
    ? [tokenBaseProgram, TOKEN_PROGRAM_ID]
    : [TOKEN_PROGRAM_ID, tokenBaseProgram];

  const [
    { ata: inputTokenAccount, ix: _createInputTokenXIx },
    { ata: outputTokenAccount, ix: _createOutputTokenYIx },
  ] = [
    getOrCreateAssociatedTokenAccount(
      svm,
      payer,
      inputTokenMint,
      payer.publicKey,
      inputTokenProgram
    ),
    getOrCreateAssociatedTokenAccount(
      svm,
      payer,
      outputTokenMint,
      payer.publicKey,
      outputTokenProgram
    ),
  ];

  const instruction = await program.methods
    .swap({
      amount0: amountIn,
      amount1: minimumAmountOut,
      swapMode: 0,
    })
    .accountsPartial({
      poolAuthority,
      config,
      pool,
      inputTokenAccount,
      outputTokenAccount,
      baseVault: poolState.baseVault,
      quoteVault: poolState.quoteVault,
      baseMint: poolState.baseMint,
      quoteMint,
      payer: payer.publicKey,
      tokenBaseProgram,
      tokenQuoteProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount,
      // SPEC-DBC-AUDIT-001 Phase 2 (REQ-A-003): swap requires the pool's
      // TokenVerification PDA whenever a referral payout is requested; anchor
      // still wants the optional account passed explicitly (null when no referral).
      tokenVerification: referralTokenAccount
        ? deriveTokenVerificationAddress(pool)
        : null,
      ipworldState: deriveIpworldStateAddress(),
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .remainingAccounts([
      {
        isSigner: false,
        isWritable: false,
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
      },
    ])
    .instruction();

  return instruction;
}

export async function getSwapInstruction(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  params: SwapParams
): Promise<TransactionInstruction> {
  const {
    config,
    payer,
    pool,
    inputTokenMint,
    outputTokenMint,
    amountIn,
    minimumAmountOut,
    referralTokenAccount,
  } = params;

  const poolAuthority = derivePoolAuthority();
  let poolState = getVirtualPool(svm, program, pool);

  const configState = getConfig(svm, program, config);

  const tokenBaseProgram =
    configState.tokenType == 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const isInputBaseMint = inputTokenMint.equals(poolState.baseMint);

  const quoteMint = isInputBaseMint ? outputTokenMint : inputTokenMint;
  const [inputTokenProgram, outputTokenProgram] = isInputBaseMint
    ? [tokenBaseProgram, TOKEN_PROGRAM_ID]
    : [TOKEN_PROGRAM_ID, tokenBaseProgram];

  const [
    { ata: inputTokenAccount, ix: _createInputTokenXIx },
    { ata: outputTokenAccount, ix: _createOutputTokenYIx },
  ] = [
    getOrCreateAssociatedTokenAccount(
      svm,
      payer,
      inputTokenMint,
      payer.publicKey,
      inputTokenProgram
    ),
    getOrCreateAssociatedTokenAccount(
      svm,
      payer,
      outputTokenMint,
      payer.publicKey,
      outputTokenProgram
    ),
  ];

  // SPEC-DBC-AUDIT-001: legacy `swap` (SwapParameters{amountIn,minimumAmountOut})
  // was deleted; `swap2` was renamed to `swap` and takes SwapParameters2.
  const instruction = await program.methods
    .swap({
      amount0: amountIn,
      amount1: minimumAmountOut,
      swapMode: SwapMode.ExactIn,
    })
    .accountsPartial({
      poolAuthority,
      config,
      pool,
      inputTokenAccount,
      outputTokenAccount,
      baseVault: poolState.baseVault,
      quoteVault: poolState.quoteVault,
      baseMint: poolState.baseMint,
      quoteMint,
      payer: payer.publicKey,
      tokenBaseProgram,
      tokenQuoteProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount,
      // SPEC-DBC-AUDIT-001 Phase 2 (REQ-A-003): swap requires the pool's
      // TokenVerification PDA whenever a referral payout is requested; anchor
      // still wants the optional account passed explicitly (null when no referral).
      tokenVerification: referralTokenAccount
        ? deriveTokenVerificationAddress(pool)
        : null,
      ipworldState: deriveIpworldStateAddress(),
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .remainingAccounts([
      {
        isSigner: false,
        isWritable: false,
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
      },
    ])
    .instruction();

  return instruction;
}

export async function swap2(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  params: SwapParams2
): Promise<{
  pool: PublicKey;
  computeUnitsConsumed: number;
  message: any;
  numInstructions: number;
  completed: boolean;
}> {
  const {
    config,
    payer,
    pool,
    inputTokenMint,
    outputTokenMint,
    amount0: amountIn,
    amount1: minimumAmountOut,
    referralTokenAccount,
    swapMode,
  } = params;

  const poolAuthority = derivePoolAuthority();
  let poolState = getVirtualPool(svm, program, pool);

  const configState = getConfig(svm, program, config);

  const tokenBaseProgram =
    configState.tokenType == 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const isInputBaseMint = inputTokenMint.equals(poolState.baseMint);

  const quoteMint = isInputBaseMint ? outputTokenMint : inputTokenMint;
  const [inputTokenProgram, outputTokenProgram] = isInputBaseMint
    ? [tokenBaseProgram, TOKEN_PROGRAM_ID]
    : [TOKEN_PROGRAM_ID, tokenBaseProgram];

  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];

  const [
    { ata: inputTokenAccount, ix: createInputTokenXIx },
    { ata: outputTokenAccount, ix: createOutputTokenYIx },
  ] = [
    getOrCreateAssociatedTokenAccount(
      svm,
      payer,
      inputTokenMint,
      payer.publicKey,
      inputTokenProgram
    ),
    getOrCreateAssociatedTokenAccount(
      svm,
      payer,
      outputTokenMint,
      payer.publicKey,
      outputTokenProgram
    ),
  ];
  createInputTokenXIx && preInstructions.push(createInputTokenXIx);
  createOutputTokenYIx && preInstructions.push(createOutputTokenYIx);

  if (inputTokenMint.equals(NATIVE_MINT) && !amountIn.isZero()) {
    const wrapSOLIx = wrapSOLInstruction(
      payer.publicKey,
      inputTokenAccount,
      BigInt(amountIn.toString())
    );

    preInstructions.push(...wrapSOLIx);
  }

  if (outputTokenMint.equals(NATIVE_MINT)) {
    const unrapSOLIx = unwrapSOLInstruction(payer.publicKey);

    unrapSOLIx && postInstructions.push(unrapSOLIx);
  }

  // Ed25519 TradeAuth must be the instruction immediately before swap (current_idx - 1)
  const authority = getSvmAuthority();
  const tradeAuthMsg = serializeTradeAuth(payer.publicKey, Math.floor(Date.now() / 1000) + 3600);
  preInstructions.push(buildEd25519Ix(authority, tradeAuthMsg));

  const transaction = await program.methods
    .swap({
      amount0: amountIn,
      amount1: minimumAmountOut,
      swapMode,
    })
    .accountsPartial({
      poolAuthority,
      config,
      pool,
      inputTokenAccount,
      outputTokenAccount,
      baseVault: poolState.baseVault,
      quoteVault: poolState.quoteVault,
      baseMint: poolState.baseMint,
      quoteMint,
      payer: payer.publicKey,
      tokenBaseProgram,
      tokenQuoteProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount,
      // SPEC-DBC-AUDIT-001 Phase 2 (REQ-A-003): swap requires the pool's
      // TokenVerification PDA whenever a referral payout is requested; anchor
      // still wants the optional account passed explicitly (null when no referral).
      tokenVerification: referralTokenAccount
        ? deriveTokenVerificationAddress(pool)
        : null,
      ipworldState: deriveIpworldStateAddress(),
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .preInstructions(preInstructions)
    .postInstructions(postInstructions)
    .remainingAccounts([
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
    ])
    .transaction();

  transaction.recentBlockhash = svm.latestBlockhash();
  transaction.feePayer = payer.publicKey;
  transaction.sign(payer);

  let simu = svm.simulateTransaction(transaction);
  const consumedCUSwap = Number(simu.meta().computeUnitsConsumed);
  sendTransactionMaybeThrow(svm, transaction, [payer]);

  poolState = getVirtualPool(svm, program, pool);
  const configs = getConfig(svm, program, config);
  return {
    pool,
    computeUnitsConsumed: consumedCUSwap,
    message: simu.meta().logs()[0],
    numInstructions: transaction.instructions.length,
    completed:
      Number(poolState.quoteReserve) >= Number(configs.migrationQuoteThreshold),
  };
}

export async function swapSimulate(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  params: SwapParams
): Promise<{
  pool: PublicKey;
  computeUnitsConsumed: number;
  message: any;
  numInstructions: number;
  completed: boolean;
}> {
  const {
    config,
    payer,
    pool,
    inputTokenMint,
    outputTokenMint,
    amountIn,
    minimumAmountOut,
    referralTokenAccount,
  } = params;

  const poolAuthority = derivePoolAuthority();
  let poolState = getVirtualPool(svm, program, pool);

  const configState = getConfig(svm, program, config);

  const tokenBaseProgram =
    configState.tokenType == 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const isInputBaseMint = inputTokenMint.equals(poolState.baseMint);
  const [inputTokenProgram, outputTokenProgram] = isInputBaseMint
    ? [tokenBaseProgram, TOKEN_PROGRAM_ID]
    : [TOKEN_PROGRAM_ID, tokenBaseProgram];

  const quoteMint = isInputBaseMint ? outputTokenMint : inputTokenMint;

  const [
    { ata: inputTokenAccount, ix: createInputTokenXIx },
    { ata: outputTokenAccount, ix: createOutputTokenYIx },
  ] = [
    getOrCreateAssociatedTokenAccount(
      svm,
      payer,
      inputTokenMint,
      payer.publicKey,
      inputTokenProgram
    ),
    getOrCreateAssociatedTokenAccount(
      svm,
      payer,
      outputTokenMint,
      payer.publicKey,
      outputTokenProgram
    ),
  ];
  const wrapSOLIx = wrapSOLInstruction(
    payer.publicKey,
    inputTokenAccount,
    BigInt(amountIn.toString())
  );
  const instructions: TransactionInstruction[] = [];
  createInputTokenXIx && instructions.push(createInputTokenXIx);
  createOutputTokenYIx && instructions.push(createOutputTokenYIx);
  instructions.push(...wrapSOLIx);
  const wrapSolTx = new Transaction().add(...instructions);

  sendTransactionMaybeThrow(svm, wrapSolTx, [payer]);

  // Ed25519 TradeAuth must be the instruction immediately before swap (current_idx - 1)
  const authority = getSvmAuthority();
  const tradeAuthMsg = serializeTradeAuth(payer.publicKey, Math.floor(Date.now() / 1000) + 3600);
  const ed25519Ix = buildEd25519Ix(authority, tradeAuthMsg);

  const swap2Ix = await program.methods
    .swap({
      amount0: amountIn,
      amount1: minimumAmountOut,
      swapMode: SwapMode.PartialFill,
    })
    .accountsPartial({
      poolAuthority,
      config,
      pool,
      inputTokenAccount,
      outputTokenAccount,
      baseVault: poolState.baseVault,
      quoteVault: poolState.quoteVault,
      baseMint: poolState.baseMint,
      quoteMint,
      payer: payer.publicKey,
      tokenBaseProgram,
      tokenQuoteProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount,
      // SPEC-DBC-AUDIT-001 Phase 2 (REQ-A-003): swap requires the pool's
      // TokenVerification PDA whenever a referral payout is requested; anchor
      // still wants the optional account passed explicitly (null when no referral).
      tokenVerification: referralTokenAccount
        ? deriveTokenVerificationAddress(pool)
        : null,
      ipworldState: deriveIpworldStateAddress(),
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();

  const transaction = new Transaction().add(ed25519Ix, swap2Ix);

  transaction.recentBlockhash = svm.latestBlockhash();
  transaction.feePayer = payer.publicKey;
  transaction.sign(payer);

  let simu = svm.simulateTransaction(transaction);
  const consumedCUSwap = Number(simu.meta().computeUnitsConsumed);
  sendTransactionMaybeThrow(svm, transaction, [payer]);

  poolState = getVirtualPool(svm, program, pool);
  const configs = getConfig(svm, program, config);
  return {
    pool,
    computeUnitsConsumed: consumedCUSwap,
    message: simu.meta().logs()[0],
    numInstructions: transaction.instructions.length,
    completed:
      Number(poolState.quoteReserve) >= Number(configs.migrationQuoteThreshold),
  };
}

// ---------------------------------------------------------------------------
// SPEC-DBC-AUDIT-001 cap-aware graduation helper.
//
// Why this exists: the IPWorld transfer hook (Phase 3) enforces a 5%-of-supply
// holding cap on every pre-graduation recipient (HoldingCapExceeded = 0x1773).
// Legacy tests graduated a curve with ONE buy of `migrationQuoteThreshold`,
// which hands a single buyer ~100% of the circulating base and trips the cap.
//
// `progressCurveToGraduation` spreads the total quote across MANY distinct buyer
// wallets, each kept under 5%, mirroring the proven multi-buyer pattern in
// graduation_hook_removal.tests.ts. The curve ends in the SAME state a single
// PartialFill of `threshold` would have produced (quoteReserve == threshold,
// pool complete), so downstream migration / fee / LP-claim assertions are
// unaffected — only HOW the curve is progressed changes.
//
// Two constraints shape the algorithm:
//   1. The 5% holding cap binds hardest on the FIRST (cheapest) buyer — early
//      buys must be small. As the curve price rises, a fixed SOL amount buys
//      proportionally LESS base, so later buys can be much larger and still stay
//      under 5%. The helper therefore RAMPS the per-buyer amount up geometrically.
//   2. LiteSVM has an empirically-confirmed ~98 distinct-fee-payer ceiling: past
//      ~98 distinct signing accounts, `sendTransaction` fails with EMPTY logs.
//      The geometric ramp graduates even a 300-SOL threshold in ~25 buyers,
//      keeping the distinct-buyer count well under that ceiling. (A flat tiny
//      per-buyer would need ~200 buyers and hit the wall mid-curve.)
//
// Quote funding:
//   - NATIVE_MINT pool  -> each buyer is funded with SOL (generateAndFund) and
//     the `swap` builder wraps it automatically. No `quoteMintAuthority` needed.
//   - custom SPL quote  -> caller MUST pass `quoteMintAuthority` (the keypair
//     that minted the quote, e.g. `admin` in designCurve tests); the helper
//     mints each buyer's quote.
// ---------------------------------------------------------------------------
export type ProgressCurveOptions = {
  // Mint authority for a custom (non-NATIVE_MINT) quote token. Required only
  // when the pool's quote mint is not NATIVE_MINT.
  quoteMintAuthority?: Keypair;
  // Starting per-buyer quote. Defaults to migrationQuoteThreshold / `startDivisor`.
  startPerBuyerAmount?: BN;
  // Controls the (small, cap-safe) FIRST buy size: threshold / startDivisor.
  // 150 lands the first buy comfortably under 5% on both the standard and the
  // front-loaded designCurve families; the loop also auto-shrinks on a cap hit.
  startDivisor?: number;
  // Geometric growth applied to the per-buyer amount after each successful buy
  // (numerator/denominator). 7/5 = 1.4x — fast enough to graduate large
  // thresholds in ~25 buys, gentle enough to stay under the cap as price rises.
  growthNum?: number;
  growthDen?: number;
  // Safety ceiling on buyer count. Kept below the ~98 LiteSVM fee-payer limit.
  maxBuyers?: number;
};

export async function progressCurveToGraduation(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  config: PublicKey,
  pool: PublicKey,
  options: ProgressCurveOptions = {}
): Promise<{ buyersUsed: number; completed: boolean }> {
  const poolState = getVirtualPool(svm, program, pool);
  const configState = getConfig(svm, program, config);

  const baseMint = poolState.baseMint;
  const quoteMint = configState.quoteMint;
  const isNativeQuote = quoteMint.equals(NATIVE_MINT);

  if (!isNativeQuote && !options.quoteMintAuthority) {
    throw new Error(
      "progressCurveToGraduation: custom quote mint requires `quoteMintAuthority` " +
        "(the keypair that can mint the quote token to each buyer)."
    );
  }

  const threshold: BN = configState.migrationQuoteThreshold;
  const startDivisor = options.startDivisor ?? 150;
  // Growth 2x graduates a 300-SOL threshold in ~13 buyers. Several tests share
  // ONE LiteSVM instance across multiple graduations (e.g. creator_claim_trading_fee
  // runs 4 in a `before`), so keeping each graduation lean keeps the cumulative
  // distinct-buyer count under the ~98 LiteSVM fee-payer ceiling. The cap-shrink
  // path below still protects the (cap-binding) first buy.
  const growthNum = new BN(options.growthNum ?? 2);
  const growthDen = new BN(options.growthDen ?? 1);
  const maxBuyers = options.maxBuyers ?? 90; // under the ~98 LiteSVM limit

  let perBuyer: BN =
    options.startPerBuyerAmount ?? threshold.div(new BN(startDivisor)).addn(1);

  // Floor for the cap-shrink path: never shrink below threshold/4000. Hitting it
  // means even a near-minimal buy exceeds 5% — a real cap-vs-curve problem.
  const minPerBuyer = threshold.div(new BN(4000)).addn(1);

  let buyersUsed = 0;
  let completed = false;

  for (let attempt = 0; attempt < maxBuyers; attempt++) {
    const buyer = generateAndFund(svm);

    if (!isNativeQuote) {
      mintSplTokenTo(
        svm,
        buyer,
        quoteMint,
        options.quoteMintAuthority!,
        buyer.publicKey,
        BigInt(perBuyer.toString())
      );
    }

    try {
      const res = await swap(svm, program, {
        config,
        payer: buyer,
        pool,
        inputTokenMint: quoteMint,
        outputTokenMint: baseMint,
        amountIn: perBuyer,
        minimumAmountOut: new BN(0),
        // PartialFill: the buy that crosses the threshold only takes what's
        // needed to reach it, so the final buyer never overshoots (the resulting
        // quoteReserve == threshold matches the legacy single-buy end state).
        swapMode: SwapMode.PartialFill,
        referralTokenAccount: null,
      });
      buyersUsed++;

      if (res.completed) {
        completed = true;
        break;
      }
      // Ramp up: price has risen, so a larger next buy still stays under the cap.
      perBuyer = perBuyer.mul(growthNum).div(growthDen).addn(1);
    } catch (e: unknown) {
      const msg = String(e instanceof Error ? e.message : e);
      // HoldingCapExceeded (0x1773 / 6003): this buyer's slice exceeds 5% of
      // supply at the current price. Halve and retry with a fresh buyer; the
      // reverted tx left curve state unchanged so no progress is lost.
      const isHoldingCap =
        msg.includes("HoldingCapExceeded") ||
        msg.includes("0x1773") ||
        msg.includes("6003");
      if (!isHoldingCap) {
        throw e;
      }
      const halved = perBuyer.div(new BN(2));
      if (halved.lte(minPerBuyer)) {
        throw new Error(
          `progressCurveToGraduation: even a near-minimal buy (${perBuyer.toString()}) ` +
            `trips the 5% holding cap — the curve may be too front-loaded for the cap. ` +
            `Original error: ${msg}`
        );
      }
      perBuyer = halved;
    }
  }

  if (!completed) {
    throw new Error(
      `progressCurveToGraduation: curve did not reach migration threshold after ` +
        `${buyersUsed} successful buys (final perBuyer=${perBuyer.toString()}, ` +
        `threshold=${threshold.toString()}). The geometric ramp should graduate ` +
        `within ~${maxBuyers} buyers; if not, the curve/threshold combination may ` +
        `need a tuned startDivisor/growth.`
    );
  }

  return { buyersUsed, completed };
}

export async function createVirtualPoolMetadata(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  params: {
    virtualPool: PublicKey;
    name: string;
    website: string;
    logo: string;
    creator: Keypair;
    payer: Keypair;
  }
) {
  const { virtualPool, creator, payer, name, website, logo } = params;
  const virtualPoolMetadata = deriveVirtualPoolMetadata(virtualPool);
  const transaction = await program.methods
    .createVirtualPoolMetadata({
      padding: new Array(96).fill(0),
      name,
      website,
      logo,
    })
    .accountsPartial({
      virtualPool,
      virtualPoolMetadata,
      creator: creator.publicKey,
      payer: payer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  sendTransactionMaybeThrow(svm, transaction, [payer, creator]);
  //
  const metadataState = getVirtualPoolMetadata(
    svm,
    program,
    virtualPoolMetadata
  );
  expect(metadataState.virtualPool.toString()).equal(virtualPool.toString());
  expect(metadataState.name.toString()).equal(name.toString());
  expect(metadataState.website.toString()).equal(website.toString());
  expect(metadataState.logo.toString()).equal(logo.toString());
}
