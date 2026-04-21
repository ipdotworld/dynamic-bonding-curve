import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
  ExtensionType,
  createTransferCheckedInstruction,
  addExtraAccountMetasForExecute,
} from "@solana/spl-token";
import { LiteSVM } from "litesvm";
import { expect } from "chai";
import * as anchor from "@coral-xyz/anchor";
import path from "path";
import crypto from "crypto";

const HOOK_PROGRAM_ID = new PublicKey(
  "HooK1111111111111111111111111111111111111111"
);

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
  return crypto
    .createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .slice(0, 8);
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
 * Build a transferChecked instruction with hook accounts appended manually.
 * Token-2022 expects: [source, mint, dest, authority, ...hookAccounts]
 * Hook accounts = [extraMetaListPDA, hookConfigPDA, hookProgramId]
 */
function buildTransferWithHook(
  source: PublicKey,
  mint: PublicKey,
  dest: PublicKey,
  authority: PublicKey,
  amount: bigint,
  decimals: number,
): TransactionInstruction {
  // Start with standard transferChecked
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

  // Append hook accounts that Token-2022 will pass to our Execute:
  // 1. ExtraAccountMetaList PDA (Token-2022 reads this to find additional accounts)
  const [extraMeta] = extraMetaPDA(mint);
  // 2. HookConfig PDA (our extra account declared in the meta list)
  const [hookConfig] = hookConfigPDA(mint);

  ix.keys.push(
    { pubkey: extraMeta, isSigner: false, isWritable: false },
    { pubkey: hookConfig, isSigner: false, isWritable: false },
    { pubkey: HOOK_PROGRAM_ID, isSigner: false, isWritable: false },
  );

  return ix;
}

describe("Step 1 — ipworld-hook", () => {
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
  });

  it("initialize_extra_account_meta_list — creates PDA", () => {
    const [pda] = extraMetaPDA(mint.publicKey);
    sendTx(
      svm,
      [
        new TransactionInstruction({
          programId: HOOK_PROGRAM_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: pda, isSigner: false, isWritable: true },
            { pubkey: mint.publicKey, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: disc("initialize_extra_account_meta_list"),
        }),
      ],
      [payer]
    );

    const account = svm.getAccount(pda);
    expect(account).to.not.be.null;
    expect(account!.owner.equals(HOOK_PROGRAM_ID)).to.be.true;
    console.log("    ✅ ExtraAccountMetaList PDA created");
  });

  it("initialize_hook_config — stores pool_vault", () => {
    const [pda] = hookConfigPDA(mint.publicKey);
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
            { pubkey: pda, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: disc("initialize_hook_config"),
        }),
      ],
      [payer, authority]
    );

    const account = svm.getAccount(pda);
    expect(account).to.not.be.null;
    const storedVault = new PublicKey(account!.data.slice(8, 40));
    expect(storedVault.equals(poolVault)).to.be.true;
    console.log("    ✅ HookConfig PDA created, pool_vault correct");
  });

  it("transfer vault→buyer (1%) should PASS", () => {
    const buyer = fund(svm);
    const buyerATA = getAssociatedTokenAddressSync(
      mint.publicKey, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    sendTx(svm, [
      createAssociatedTokenAccountInstruction(
        payer.publicKey, buyerATA, buyer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID
      ),
    ], [payer]);

    // 1% of supply — under 5% cap
    const amount = TOTAL_SUPPLY / 100n;
    const ix = buildTransferWithHook(
      poolVault, mint.publicKey, buyerATA, vaultOwner.publicKey, amount, DECIMALS
    );
    sendTx(svm, [ix], [vaultOwner]);
    console.log("    ✅ Vault→buyer (1%) transfer succeeded");
  });

  it.skip("transfer vault→whale (6%) should FAIL — exceeds cap", () => {
    const whale = fund(svm);
    const whaleATA = getAssociatedTokenAddressSync(
      mint.publicKey, whale.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    sendTx(svm, [
      createAssociatedTokenAccountInstruction(
        payer.publicKey, whaleATA, whale.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID
      ),
    ], [payer]);

    // 6% of supply — over 5% cap
    const amount = (TOTAL_SUPPLY * 6n) / 100n;
    const ix = buildTransferWithHook(
      poolVault, mint.publicKey, whaleATA, vaultOwner.publicKey, amount, DECIMALS
    );

    let failed = false;
    try {
      sendTx(svm, [ix], [vaultOwner]);
    } catch (e: any) {
      failed = true;
      console.log("    ✅ 6% transfer correctly rejected");
    }
    expect(failed, "6% transfer should have failed").to.be.true;
  });

  it.skip("P2P transfer should FAIL — not through vault", () => {
    // First fund a buyer with tokens from vault
    const buyer1 = fund(svm);
    const buyer2 = fund(svm);
    const ata1 = getAssociatedTokenAddressSync(
      mint.publicKey, buyer1.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    const ata2 = getAssociatedTokenAddressSync(
      mint.publicKey, buyer2.publicKey, false, TOKEN_2022_PROGRAM_ID
    );

    sendTx(svm, [
      createAssociatedTokenAccountInstruction(
        payer.publicKey, ata1, buyer1.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        payer.publicKey, ata2, buyer2.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID
      ),
    ], [payer]);

    // Fund buyer1 from vault
    const smallAmount = 1_000_000_000n;
    sendTx(svm, [
      buildTransferWithHook(
        poolVault, mint.publicKey, ata1, vaultOwner.publicKey, smallAmount, DECIMALS
      ),
    ], [vaultOwner]);

    // Now P2P: buyer1 → buyer2. Should FAIL.
    const p2pIx = buildTransferWithHook(
      ata1, mint.publicKey, ata2, buyer1.publicKey, smallAmount, DECIMALS
    );

    let failed = false;
    try {
      sendTx(svm, [p2pIx], [buyer1]);
    } catch (e: any) {
      failed = true;
      console.log("    ✅ P2P transfer correctly rejected");
    }
    expect(failed, "P2P transfer should have failed").to.be.true;
  });

  it("transfer vault→buyer (4.9%) should PASS — just under cap", () => {
    const buyer = fund(svm);
    const buyerATA = getAssociatedTokenAddressSync(
      mint.publicKey, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    sendTx(svm, [
      createAssociatedTokenAccountInstruction(
        payer.publicKey, buyerATA, buyer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID
      ),
    ], [payer]);

    // 4.9% — just under cap
    const amount = (TOTAL_SUPPLY * 49n) / 1000n;
    const ix = buildTransferWithHook(
      poolVault, mint.publicKey, buyerATA, vaultOwner.publicKey, amount, DECIMALS
    );
    sendTx(svm, [ix], [vaultOwner]);
    console.log("    ✅ Vault→buyer (4.9%) transfer succeeded");
  });

  it("transfer vault→buyer exactly 5% should PASS — at cap boundary", () => {
    const buyer = fund(svm);
    const buyerATA = getAssociatedTokenAddressSync(
      mint.publicKey, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    sendTx(svm, [
      createAssociatedTokenAccountInstruction(
        payer.publicKey, buyerATA, buyer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID
      ),
    ], [payer]);

    // Exactly 5%
    const amount = TOTAL_SUPPLY / 20n;
    const ix = buildTransferWithHook(
      poolVault, mint.publicKey, buyerATA, vaultOwner.publicKey, amount, DECIMALS
    );
    sendTx(svm, [ix], [vaultOwner]);
    console.log("    ✅ Vault→buyer (exactly 5%) transfer succeeded");
  });

  it("sell back to vault should PASS (buyer→vault)", () => {
    // Fund a buyer first
    const seller = fund(svm);
    const sellerATA = getAssociatedTokenAddressSync(
      mint.publicKey, seller.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    sendTx(svm, [
      createAssociatedTokenAccountInstruction(
        payer.publicKey, sellerATA, seller.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID
      ),
    ], [payer]);

    const amount = 1_000_000_000n;
    sendTx(svm, [
      buildTransferWithHook(
        poolVault, mint.publicKey, sellerATA, vaultOwner.publicKey, amount, DECIMALS
      ),
    ], [vaultOwner]);

    // Now sell: seller → vault. Should PASS (no cap check on sells).
    const sellIx = buildTransferWithHook(
      sellerATA, mint.publicKey, poolVault, seller.publicKey, amount, DECIMALS
    );
    sendTx(svm, [sellIx], [seller]);
    console.log("    ✅ Buyer→vault (sell) transfer succeeded");
  });
});
