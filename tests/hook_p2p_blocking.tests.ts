/**
 * T-06: Hook P2P Blocking Tests (LiteSVM)
 *
 * Verifies that the ipworld-hook enforces P2P transfer blocking:
 * - Direct user-to-user transfers are rejected (not through vault)
 * - Vault-based transfers (buys > 5% of supply) are allowed
 *   (ownership cap was removed; only P2P blocking remains)
 *
 * This test uses LiteSVM directly (no external validator needed).
 * Only the ipworld_hook.so binary is required.
 *
 * Prerequisites:
 *   cargo build-sbf
 *   npx ts-mocha -t 120000 tests/hook_p2p_blocking.tests.ts
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import { LiteSVM } from "litesvm";
import { expect as chaiExpect } from "chai";
import crypto from "crypto";
import path from "path";

const HOOK_PROGRAM_ID = new PublicKey("HooK1111111111111111111111111111111111111111");

function startHookSvm(): LiteSVM {
  const svm = new LiteSVM();
  svm.addProgramFromFile(
    HOOK_PROGRAM_ID,
    path.resolve("./target/deploy/ipworld_hook.so")
  );
  return svm;
}

function fund(svm: LiteSVM): Keypair {
  const kp = Keypair.generate();
  svm.airdrop(kp.publicKey, BigInt(100 * LAMPORTS_PER_SOL));
  return kp;
}

function disc(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}

function hookConfigPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("hook_config"), mint.toBuffer()],
    HOOK_PROGRAM_ID
  );
}

function extraMetaPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    HOOK_PROGRAM_ID
  );
}

function sendTx(svm: LiteSVM, ixs: TransactionInstruction[], signers: Keypair[]) {
  const msg = new TransactionMessage({
    payerKey: signers[0].publicKey,
    recentBlockhash: svm.latestBlockhash(),
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  return svm.sendTransaction(tx);
}

/**
 * Build a transferChecked instruction with hook accounts appended.
 * Mirrors the pattern in ipworld_hook.tests.ts buildTransferWithHook().
 */
function buildTransferWithHook(
  source: PublicKey,
  mint: PublicKey,
  dest: PublicKey,
  authority: PublicKey,
  amount: bigint,
  decimals: number
): TransactionInstruction {
  const ix = createTransferCheckedInstruction(
    source,
    mint,
    dest,
    authority,
    amount,
    decimals,
    [],
    TOKEN_2022_PROGRAM_ID
  );

  const [extraMeta] = extraMetaPDA(mint);
  const [hookConfig] = hookConfigPDA(mint);

  ix.keys.push(
    { pubkey: extraMeta, isSigner: false, isWritable: false },
    { pubkey: hookConfig, isSigner: false, isWritable: false },
    { pubkey: HOOK_PROGRAM_ID, isSigner: false, isWritable: false }
  );

  return ix;
}

describe("T-06: Hook P2P Blocking", () => {
  let svm: LiteSVM;
  let payer: Keypair;
  let authority: Keypair;
  let mint: Keypair;
  let vaultOwner: Keypair;
  let poolVault: PublicKey;

  const DECIMALS = 9;
  const TOTAL_SUPPLY = 1_000_000_000_000_000_000n; // 1B * 10^9

  before(() => {
    // TODO: implement — follows the exact pattern from ipworld_hook.tests.ts
    // Steps:
    //   1. svm = startHookSvm()
    //   2. Generate and fund: payer, authority, vaultOwner
    //   3. Generate mint keypair
    //   4. Create Token-2022 mint with TransferHook extension pointing to HOOK_PROGRAM_ID
    //   5. Create vault ATA (poolVault) for vaultOwner
    //   6. Mint TOTAL_SUPPLY to poolVault
    //   7. Call initialize_extra_account_meta_list to create ExtraAccountMeta PDA
    //   8. Call initialize_hook_config to register poolVault as the authorized vault
  });

  it("M-HOOK-001: P2P transfer blocked (no ownership cap)", async () => {
    // TODO: implement
    // Context:
    //   The ownership cap (5% per buyer limit) has been REMOVED from the hook.
    //   Only the P2P transfer block remains active.
    //   A transfer is P2P when the source is NOT the poolVault.
    //
    // Steps:
    //   1. Create buyer1 and buyer2 keypairs, fund with SOL
    //   2. Create Token-2022 ATAs for both buyers
    //   3. Transfer a small amount from poolVault to buyer1 (this is a valid vault transfer)
    //   4. Attempt to transfer from buyer1 directly to buyer2 (this is P2P)
    //   5. Expect: sendTx throws an error
    //   6. Verify the error is the P2P blocking error (TransferNotThroughCurve or similar)
    //
    // Note: The amount does NOT matter for P2P rejection — only the source matters.
    //   Even 1 token P2P should fail.
  });

  it("M-HOOK-002: Vault transfer allowed (buy > 5% is ok)", async () => {
    // TODO: implement
    // Context:
    //   The ownership cap (5% limit) has been REMOVED.
    //   A whale buying >5% through the vault should now SUCCEED.
    //   (Previously this would have failed with OwnershipCapExceeded.)
    //
    // Steps:
    //   1. Create a whale keypair, fund with SOL
    //   2. Create Token-2022 ATA for whale
    //   3. Calculate 10% of TOTAL_SUPPLY
    //   4. Build transferWithHook from poolVault to whale.ATA for 10% amount
    //   5. Send tx signed by vaultOwner
    //   6. Expect: tx confirms successfully (no ownership cap rejection)
    //   7. Verify whale's token balance == 10% of total supply
  });
});
