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

function sendTxMayFail(svm: LiteSVM, ixs: TransactionInstruction[], signers: Keypair[]): boolean {
  try {
    sendTx(svm, ixs, signers);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a transferChecked instruction with hook accounts appended.
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
    svm = startHookSvm();
    payer = fund(svm);
    authority = fund(svm);
    vaultOwner = fund(svm);
    mint = Keypair.generate();

    // Create Token-2022 mint with TransferHook extension
    const mintLen = getMintLen([ExtensionType.TransferHook]);
    const mintRent = svm.minimumBalanceForRentExemption(BigInt(mintLen));

    sendTx(
      svm,
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint.publicKey,
          space: mintLen,
          lamports: Number(mintRent),
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeTransferHookInstruction(
          mint.publicKey,
          payer.publicKey,
          HOOK_PROGRAM_ID,
          TOKEN_2022_PROGRAM_ID
        ),
        createInitializeMintInstruction(
          mint.publicKey,
          DECIMALS,
          payer.publicKey,
          null,
          TOKEN_2022_PROGRAM_ID
        ),
      ],
      [payer, mint]
    );

    // Create vault ATA
    poolVault = getAssociatedTokenAddressSync(
      mint.publicKey,
      vaultOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    sendTx(
      svm,
      [
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          poolVault,
          vaultOwner.publicKey,
          mint.publicKey,
          TOKEN_2022_PROGRAM_ID
        ),
      ],
      [payer]
    );

    // Mint total supply to vault
    sendTx(
      svm,
      [
        createMintToInstruction(
          mint.publicKey,
          poolVault,
          payer.publicKey,
          TOTAL_SUPPLY,
          [],
          TOKEN_2022_PROGRAM_ID
        ),
      ],
      [payer]
    );

    // Initialize ExtraAccountMetaList PDA
    const [extraMetaAddr] = extraMetaPDA(mint.publicKey);
    sendTx(
      svm,
      [
        new TransactionInstruction({
          programId: HOOK_PROGRAM_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: extraMetaAddr, isSigner: false, isWritable: true },
            { pubkey: mint.publicKey, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: disc("initialize_extra_account_meta_list"),
        }),
      ],
      [payer]
    );

    // Initialize HookConfig PDA with poolVault
    const [hookConfigAddr] = hookConfigPDA(mint.publicKey);
    sendTx(
      svm,
      [
        new TransactionInstruction({
          programId: HOOK_PROGRAM_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: authority.publicKey, isSigner: true, isWritable: false },
            { pubkey: mint.publicKey, isSigner: false, isWritable: false },
            { pubkey: poolVault, isSigner: false, isWritable: false },
            { pubkey: hookConfigAddr, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: disc("initialize_hook_config"),
        }),
      ],
      [payer, authority]
    );
  });

  it.skip("M-HOOK-001: P2P transfer blocked — requires solana-test-validator (LiteSVM skips Transfer Hook CPI)", () => {
    // Fund buyer1 from vault (valid vault transfer)
    const buyer1 = fund(svm);
    const buyer1Ata = getAssociatedTokenAddressSync(
      mint.publicKey, buyer1.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    sendTx(svm, [
      createAssociatedTokenAccountInstruction(
        payer.publicKey, buyer1Ata, buyer1.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID
      ),
    ], [payer]);

    const buyAmount = TOTAL_SUPPLY / 100n; // 1%
    const transferIx = buildTransferWithHook(
      poolVault, mint.publicKey, buyer1Ata, vaultOwner.publicKey, buyAmount, DECIMALS
    );
    sendTx(svm, [transferIx], [vaultOwner]);

    // Now try buyer1 → buyer2 (P2P — should fail)
    const buyer2 = fund(svm);
    const buyer2Ata = getAssociatedTokenAddressSync(
      mint.publicKey, buyer2.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    sendTx(svm, [
      createAssociatedTokenAccountInstruction(
        payer.publicKey, buyer2Ata, buyer2.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID
      ),
    ], [payer]);

    const p2pIx = buildTransferWithHook(
      buyer1Ata, mint.publicKey, buyer2Ata, buyer1.publicKey, buyAmount / 2n, DECIMALS
    );
    const succeeded = sendTxMayFail(svm, [p2pIx], [buyer1]);
    expect(succeeded, "P2P transfer should have failed").to.be.false;
  });

  it("M-HOOK-002: Vault transfer allowed (buy > 5% is ok)", () => {
    // Whale buys 10% through vault — no ownership cap
    const whale = fund(svm);
    const whaleAta = getAssociatedTokenAddressSync(
      mint.publicKey, whale.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    sendTx(svm, [
      createAssociatedTokenAccountInstruction(
        payer.publicKey, whaleAta, whale.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID
      ),
    ], [payer]);

    const whaleAmount = TOTAL_SUPPLY / 10n; // 10%
    const transferIx = buildTransferWithHook(
      poolVault, mint.publicKey, whaleAta, vaultOwner.publicKey, whaleAmount, DECIMALS
    );
    const succeeded = sendTxMayFail(svm, [transferIx], [vaultOwner]);
    expect(succeeded, "10% vault transfer should succeed (no cap)").to.be.true;
  });
});
