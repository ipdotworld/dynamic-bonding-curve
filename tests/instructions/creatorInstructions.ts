import { BN } from "@coral-xyz/anchor";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { LiteSVM } from "litesvm";
import {
  deriveMigrationMetadataAddress,
  derivePoolAuthority,
  getOrCreateAssociatedTokenAccount,
  getTokenAccount,
  getTokenProgram,
  sendTransactionMaybeThrow,
  unwrapSOLInstruction,
} from "../utils";
import { getConfig, getVirtualPool } from "../utils/fetcher";
import { VirtualCurveProgram } from "../utils/types";
import { deriveExtraAccountMetaListAddress, deriveHookConfigAddress } from "../utils/accounts";
import { IPWORLD_HOOK_PROGRAM_ID } from "../utils/constants";

export type ClaimCreatorTradeFeeParams = {
  creator: Keypair;
  pool: PublicKey;
  maxBaseAmount: BN;
  maxQuoteAmount: BN;
};

// SPEC-DBC-004 Phase 3 (REQ-I-001): `claim_creator_trading_fee` instruction
// was removed alongside `creator_share` / `creator_quote_fee` /
// `_deprecated_creator_base_fee`. The helper export is retained as a stub
// (throwing on call) so consuming test files (all `describe.skip`-ed) still
// import successfully; any accidental live invocation surfaces a clear error
// instead of silently passing.
export async function claimCreatorTradingFee(
  _svm: LiteSVM,
  _program: VirtualCurveProgram,
  _params: ClaimCreatorTradeFeeParams
): Promise<any> {
  throw new Error(
    "claimCreatorTradingFee was removed in SPEC-DBC-004 Phase 3 (REQ-I-001). " +
      "Use creatorWithdrawSurplus instead. The enclosing test should be skipped."
  );
}

export type CreatorWithdrawSurplusParams = {
  creator: Keypair;
  virtualPool: PublicKey;
};
export async function creatorWithdrawSurplus(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  params: CreatorWithdrawSurplusParams
): Promise<any> {
  const { creator, virtualPool } = params;
  const poolState = getVirtualPool(svm, program, virtualPool);
  const poolAuthority = derivePoolAuthority();

  const quoteMintInfo = getTokenAccount(svm, poolState.quoteVault)!;

  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];
  const { ata: tokenQuoteAccount, ix: createQuoteTokenAccountIx } =
    getOrCreateAssociatedTokenAccount(
      svm,
      creator,
      quoteMintInfo.mint,
      creator.publicKey,
      TOKEN_PROGRAM_ID
    );

  createQuoteTokenAccountIx && preInstructions.push(createQuoteTokenAccountIx);

  if (quoteMintInfo.mint == NATIVE_MINT) {
    const unrapSOLIx = unwrapSOLInstruction(creator.publicKey);
    unrapSOLIx && postInstructions.push(unrapSOLIx);
  }

  const transaction = await program.methods
    .creatorWithdrawSurplus()
    .accountsPartial({
      poolAuthority,
      config: poolState.config,
      virtualPool,
      tokenQuoteAccount,
      quoteVault: poolState.quoteVault,
      quoteMint: quoteMintInfo.mint,
      creator: creator.publicKey,
      tokenQuoteProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions(preInstructions)
    .postInstructions(postInstructions)
    .transaction();

  sendTransactionMaybeThrow(svm, transaction, [creator]);
}

export async function transferCreator(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  virtualPool: PublicKey,
  creator: Keypair,
  newCreator: PublicKey
): Promise<void> {
  const poolState = getVirtualPool(svm, program, virtualPool);
  const migrationMetadata = deriveMigrationMetadataAddress(virtualPool);
  const transaction = await program.methods
    .transferPoolCreator()
    .accountsPartial({
      virtualPool,
      newCreator,
      config: poolState.config,
      creator: creator.publicKey,
    })
    .remainingAccounts([
      {
        isSigner: false,
        isWritable: false,
        pubkey: migrationMetadata,
      },
    ])
    .transaction();
  sendTransactionMaybeThrow(svm, transaction, [creator]);
}

export type CreatorWithdrawMigrationFeeParams = {
  creator: Keypair;
  virtualPool: PublicKey;
};
export async function creatorWithdrawMigrationFee(
  svm: LiteSVM,
  program: VirtualCurveProgram,
  params: CreatorWithdrawMigrationFeeParams
): Promise<void> {
  const { creator, virtualPool } = params;
  const poolAuthority = derivePoolAuthority();
  const poolState = getVirtualPool(svm, program, virtualPool);
  const configState = getConfig(svm, program, poolState.config);

  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];
  const { ata: tokenQuoteAccount, ix: createQuoteTokenAccountIx } =
    getOrCreateAssociatedTokenAccount(
      svm,
      creator,
      configState.quoteMint,
      creator.publicKey,
      getTokenProgram(configState.quoteTokenFlag)
    );

  createQuoteTokenAccountIx && preInstructions.push(createQuoteTokenAccountIx);

  if (configState.quoteMint.equals(NATIVE_MINT)) {
    const unrapSOLIx = unwrapSOLInstruction(creator.publicKey);
    unrapSOLIx && postInstructions.push(unrapSOLIx);
  }

  const transaction = await program.methods
    .withdrawMigrationFee(1)
    .accountsPartial({
      poolAuthority,
      config: poolState.config,
      virtualPool,
      tokenQuoteAccount,
      quoteVault: poolState.quoteVault,
      quoteMint: configState.quoteMint,
      sender: creator.publicKey,
      tokenQuoteProgram: getTokenProgram(configState.quoteTokenFlag),
    })
    .preInstructions(preInstructions)
    .postInstructions(postInstructions)
    .transaction();

  sendTransactionMaybeThrow(svm, transaction, [creator]);
}
