import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Connection,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  createTransferCheckedWithTransferHookInstruction,
  getMintLen,
  ExtensionType,
} from "@solana/spl-token";
import { expect } from "chai";
import crypto from "crypto";

const HOOK_PROGRAM_ID = new PublicKey(
  "HooK1111111111111111111111111111111111111111"
);

const connection = new Connection("http://127.0.0.1:8899", "confirmed");

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

async function airdrop(pubkey: PublicKey, sol: number = 10) {
  const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig);
}

async function sendV0(ixs: TransactionInstruction[], signers: Keypair[]) {
  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: signers[0].publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  const sig = await connection.sendTransaction(tx);
  await connection.confirmTransaction(sig);
  return sig;
}

describe.skip("Step 1 — ipworld-hook (solana-test-validator)", function () {
  this.timeout(60000);

  let payer: Keypair;
  let authority: Keypair;
  let mint: Keypair;
  let vaultOwner: Keypair;
  let poolVault: PublicKey;
  const DECIMALS = 9;
  const TOTAL_SUPPLY = 1_000_000_000_000_000_000n; // 1B * 10^9

  before(async () => {
    payer = Keypair.generate();
    authority = Keypair.generate();
    vaultOwner = Keypair.generate();
    mint = Keypair.generate();

    await airdrop(payer.publicKey, 100);
    await airdrop(authority.publicKey, 10);
    await airdrop(vaultOwner.publicKey, 10);

    // Create Token-2022 mint with TransferHook extension
    const mintLen = getMintLen([ExtensionType.TransferHook]);
    const mintRent = await connection.getMinimumBalanceForRentExemption(mintLen);

    await sendV0(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint.publicKey,
          space: mintLen,
          lamports: mintRent,
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
    await sendV0(
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
    await sendV0(
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

  it("initialize_extra_account_meta_list", async () => {
    const [pda] = extraMetaPDA(mint.publicKey);
    await sendV0(
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

    const account = await connection.getAccountInfo(pda);
    expect(account).to.not.be.null;
    expect(account!.owner.equals(HOOK_PROGRAM_ID)).to.be.true;
    console.log("    ✅ ExtraAccountMetaList PDA created");
  });

  it("initialize_hook_config", async () => {
    const [pda] = hookConfigPDA(mint.publicKey);
    await sendV0(
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

    const account = await connection.getAccountInfo(pda);
    expect(account).to.not.be.null;
    const storedVault = new PublicKey(account!.data.slice(8, 40));
    expect(storedVault.equals(poolVault)).to.be.true;
    console.log("    ✅ HookConfig PDA created, pool_vault correct");
  });

  it("vault→buyer (1%) should PASS", async () => {
    const buyer = Keypair.generate();
    await airdrop(buyer.publicKey, 2);
    const buyerATA = getAssociatedTokenAddressSync(
      mint.publicKey, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    await sendV0([
      createAssociatedTokenAccountInstruction(
        payer.publicKey, buyerATA, buyer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID
      ),
    ], [payer]);

    const amount = TOTAL_SUPPLY / 100n; // 1%
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection,
      poolVault, mint.publicKey, buyerATA, vaultOwner.publicKey,
      amount, DECIMALS, undefined, undefined, TOKEN_2022_PROGRAM_ID
    );
    await sendV0([ix], [vaultOwner]);
    console.log("    ✅ Vault→buyer (1%) succeeded");
  });

  it("vault→whale (6%) should FAIL — exceeds 5% cap", async () => {
    const whale = Keypair.generate();
    await airdrop(whale.publicKey, 2);
    const whaleATA = getAssociatedTokenAddressSync(
      mint.publicKey, whale.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    await sendV0([
      createAssociatedTokenAccountInstruction(
        payer.publicKey, whaleATA, whale.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID
      ),
    ], [payer]);

    const amount = (TOTAL_SUPPLY * 6n) / 100n; // 6%
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection,
      poolVault, mint.publicKey, whaleATA, vaultOwner.publicKey,
      amount, DECIMALS, undefined, undefined, TOKEN_2022_PROGRAM_ID
    );

    let failed = false;
    try {
      await sendV0([ix], [vaultOwner]);
    } catch (e: any) {
      failed = true;
      console.log("    ✅ 6% transfer correctly rejected");
    }
    expect(failed, "6% transfer should have been rejected").to.be.true;
  });

  it("P2P transfer should FAIL — not through vault", async () => {
    const buyer1 = Keypair.generate();
    const buyer2 = Keypair.generate();
    await airdrop(buyer1.publicKey, 2);
    await airdrop(buyer2.publicKey, 2);

    const ata1 = getAssociatedTokenAddressSync(
      mint.publicKey, buyer1.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    const ata2 = getAssociatedTokenAddressSync(
      mint.publicKey, buyer2.publicKey, false, TOKEN_2022_PROGRAM_ID
    );

    await sendV0([
      createAssociatedTokenAccountInstruction(
        payer.publicKey, ata1, buyer1.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        payer.publicKey, ata2, buyer2.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID
      ),
    ], [payer]);

    // Fund buyer1 from vault (1%)
    const fundIx = await createTransferCheckedWithTransferHookInstruction(
      connection,
      poolVault, mint.publicKey, ata1, vaultOwner.publicKey,
      TOTAL_SUPPLY / 100n, DECIMALS, undefined, undefined, TOKEN_2022_PROGRAM_ID
    );
    await sendV0([fundIx], [vaultOwner]);

    // P2P: buyer1 → buyer2
    const p2pIx = await createTransferCheckedWithTransferHookInstruction(
      connection,
      ata1, mint.publicKey, ata2, buyer1.publicKey,
      1000n, DECIMALS, undefined, undefined, TOKEN_2022_PROGRAM_ID
    );

    let failed = false;
    try {
      await sendV0([p2pIx], [buyer1]);
    } catch (e: any) {
      failed = true;
      console.log("    ✅ P2P transfer correctly rejected");
    }
    expect(failed, "P2P transfer should have been rejected").to.be.true;
  });

  it("vault→buyer exactly 5% should PASS — at boundary", async () => {
    const buyer = Keypair.generate();
    await airdrop(buyer.publicKey, 2);
    const buyerATA = getAssociatedTokenAddressSync(
      mint.publicKey, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    await sendV0([
      createAssociatedTokenAccountInstruction(
        payer.publicKey, buyerATA, buyer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID
      ),
    ], [payer]);

    const amount = TOTAL_SUPPLY / 20n; // exactly 5%
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection,
      poolVault, mint.publicKey, buyerATA, vaultOwner.publicKey,
      amount, DECIMALS, undefined, undefined, TOKEN_2022_PROGRAM_ID
    );
    await sendV0([ix], [vaultOwner]);
    console.log("    ✅ Vault→buyer (exactly 5%) succeeded");
  });

  it("sell back to vault should PASS", async () => {
    const seller = Keypair.generate();
    await airdrop(seller.publicKey, 2);
    const sellerATA = getAssociatedTokenAddressSync(
      mint.publicKey, seller.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    await sendV0([
      createAssociatedTokenAccountInstruction(
        payer.publicKey, sellerATA, seller.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID
      ),
    ], [payer]);

    // Buy first
    const buyIx = await createTransferCheckedWithTransferHookInstruction(
      connection,
      poolVault, mint.publicKey, sellerATA, vaultOwner.publicKey,
      1_000_000_000n, DECIMALS, undefined, undefined, TOKEN_2022_PROGRAM_ID
    );
    await sendV0([buyIx], [vaultOwner]);

    // Sell back
    const sellIx = await createTransferCheckedWithTransferHookInstruction(
      connection,
      sellerATA, mint.publicKey, poolVault, seller.publicKey,
      1_000_000_000n, DECIMALS, undefined, undefined, TOKEN_2022_PROGRAM_ID
    );
    await sendV0([sellIx], [seller]);
    console.log("    ✅ Sell back to vault succeeded");
  });
});
