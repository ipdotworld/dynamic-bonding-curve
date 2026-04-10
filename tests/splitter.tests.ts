/**
 * ipworld-splitter tests (solana-test-validator)
 *
 * Prerequisites:
 *   cargo build-sbf -p ipworld-splitter  (from programs/ipworld-splitter/)
 *   solana-test-validator \
 *     --bpf-program 3DuLUcRJpiSubGnDtE7LLaJVdKxUSoUqKFHHmT6KBSqC target/deploy/ipworld_splitter.so \
 *     --reset
 *   npx ts-mocha -t 120000 tests/splitter.tests.ts
 */

import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  getAssociatedTokenAddress,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import SplitterIDL from "../target/idl/ipworld_splitter.json";
import { IpworldSplitter } from "../target/types/ipworld_splitter";

const SPLITTER_PROGRAM_ID = new PublicKey("3DuLUcRJpiSubGnDtE7LLaJVdKxUSoUqKFHHmT6KBSqC");
const connection = new Connection("http://127.0.0.1:8899", "confirmed");

// BPS: treasury 5714, community 3429, owner 857 = 10000
const TREASURY_BPS = 5714;
const COMMUNITY_BPS = 3429;
const OWNER_BPS = 857;

function deriveFeeConfig(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee_config"), mint.toBuffer()],
    SPLITTER_PROGRAM_ID
  )[0];
}

function deriveVault(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), mint.toBuffer()],
    SPLITTER_PROGRAM_ID
  );
}

describe("ipworld-splitter", () => {
  let admin: Keypair;
  let authority: Keypair;
  let treasuryWallet: Keypair;
  let communityWallet: Keypair;
  let ownerWallet: Keypair;
  let newOwnerWallet: Keypair;
  let mint: PublicKey;
  let program: Program<IpworldSplitter>;

  let treasuryAta: PublicKey;
  let communityAta: PublicKey;
  let ownerAta: PublicKey;
  let newOwnerAta: PublicKey;
  let vault: PublicKey;

  async function airdrop(pubkey: PublicKey, sol: number) {
    const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }

  async function getTokenBalance(ata: PublicKey): Promise<bigint> {
    const acct = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
    return acct.amount;
  }

  before(async () => {
    admin = Keypair.generate();
    authority = Keypair.generate();
    treasuryWallet = Keypair.generate();
    communityWallet = Keypair.generate();
    ownerWallet = Keypair.generate();
    newOwnerWallet = Keypair.generate();

    await airdrop(admin.publicKey, 20);
    await airdrop(newOwnerWallet.publicKey, 1);

    const wallet = new Wallet(admin);
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    program = new Program<IpworldSplitter>(SplitterIDL as IpworldSplitter, provider);

    // Create Token-2022 mint (admin is mint authority)
    mint = await createMint(
      connection,
      admin,
      admin.publicKey,
      null,
      6,
      undefined,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    // Create ATAs for treasury, community, owner, newOwner
    treasuryAta = await createAssociatedTokenAccount(
      connection, admin, mint, treasuryWallet.publicKey, { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
    );
    communityAta = await createAssociatedTokenAccount(
      connection, admin, mint, communityWallet.publicKey, { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
    );
    ownerAta = await createAssociatedTokenAccount(
      connection, admin, mint, ownerWallet.publicKey, { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
    );
    newOwnerAta = await createAssociatedTokenAccount(
      connection, admin, mint, newOwnerWallet.publicKey, { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
    );

    [vault] = deriveVault(mint);
  });

  it("✅ Init fee config", async () => {
    const tx = await program.methods
      .initFeeConfig(TREASURY_BPS, COMMUNITY_BPS, OWNER_BPS)
      .accountsPartial({
        payer: admin.publicKey,
        authority: authority.publicKey,
        baseMint: mint,
        feeConfig: deriveFeeConfig(mint),
        vault,
        treasury: treasuryWallet.publicKey,
        community: communityWallet.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    await sendAndConfirmTransaction(connection, tx, [admin]);

    // Verify config
    const config = await program.account.feeConfig.fetch(deriveFeeConfig(mint));
    expect(config.baseMint.equals(mint)).to.be.true;
    expect(config.authority.equals(authority.publicKey)).to.be.true;
    expect(config.treasury.equals(treasuryWallet.publicKey)).to.be.true;
    expect(config.community.equals(communityWallet.publicKey)).to.be.true;
    // Owner defaults to community
    expect(config.owner.equals(communityWallet.publicKey)).to.be.true;
    expect(config.treasuryBps).to.equal(TREASURY_BPS);
    expect(config.communityBps).to.equal(COMMUNITY_BPS);
    expect(config.ownerBps).to.equal(OWNER_BPS);
  });

  it("✅ Distribute 1,000,000 tokens (owner → community since no owner set)", async () => {
    const DEPOSIT = 1_000_000_000_000n; // 1M tokens (6 decimals)

    // Mint tokens to the vault (simulates backend depositing claimed fees)
    await mintTo(
      connection, admin, mint, vault, admin, DEPOSIT,
      [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
    );

    // Anyone can call distribute (using admin but no signer check)
    const tx = await program.methods
      .distribute()
      .accountsPartial({
        feeConfig: deriveFeeConfig(mint),
        baseMint: mint,
        vault,
        treasuryTokenAccount: treasuryAta,
        communityTokenAccount: communityAta,
        // Owner is still community wallet, so owner_token_account = communityAta
        ownerTokenAccount: communityAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .transaction();

    await sendAndConfirmTransaction(connection, tx, [admin]);

    // Check balances
    const treasuryBal = await getTokenBalance(treasuryAta);
    const communityBal = await getTokenBalance(communityAta);

    // Treasury: 1M * 5714 / 10000 = 571,400 tokens
    const expectedTreasury = (DEPOSIT * BigInt(TREASURY_BPS)) / 10000n;
    // Community: 1M * 3429 / 10000 = 342,900 + owner remainder
    const expectedCommunity = (DEPOSIT * BigInt(COMMUNITY_BPS)) / 10000n;
    const expectedOwner = DEPOSIT - expectedTreasury - expectedCommunity;
    // Owner ATA = community ATA, so community gets community + owner
    const expectedCommunityTotal = expectedCommunity + expectedOwner;

    expect(treasuryBal).to.equal(expectedTreasury);
    expect(communityBal).to.equal(expectedCommunityTotal);
  });

  it("❌ Distribute on empty vault fails", async () => {
    try {
      const tx = await program.methods
        .distribute()
        .accountsPartial({
          feeConfig: deriveFeeConfig(mint),
          baseMint: mint,
          vault,
          treasuryTokenAccount: treasuryAta,
          communityTokenAccount: communityAta,
          ownerTokenAccount: communityAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .transaction();

      await sendAndConfirmTransaction(connection, tx, [admin]);
      expect.fail("Should have thrown — empty vault");
    } catch (e: any) {
      const logs = e.logs?.join("\n") || e.message || "";
      expect(logs).to.match(/EmptyVault|custom program error/);
    }
  });

  it("✅ Update owner — flushes to new owner, updates address", async () => {
    const DEPOSIT = 500_000_000_000n; // 500K tokens

    // Deposit more fees
    await mintTo(
      connection, admin, mint, vault, admin, DEPOSIT,
      [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
    );

    const treasuryBefore = await getTokenBalance(treasuryAta);
    const newOwnerBefore = await getTokenBalance(newOwnerAta);

    // Authority calls update_owner
    const tx = await program.methods
      .updateOwner()
      .accountsPartial({
        feeConfig: deriveFeeConfig(mint),
        authority: authority.publicKey,
        baseMint: mint,
        vault,
        treasuryTokenAccount: treasuryAta,
        communityTokenAccount: communityAta,
        newOwner: newOwnerWallet.publicKey,
        newOwnerTokenAccount: newOwnerAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .transaction();

    await sendAndConfirmTransaction(connection, tx, [admin, authority]);

    // Check config updated
    const config = await program.account.feeConfig.fetch(deriveFeeConfig(mint));
    expect(config.owner.equals(newOwnerWallet.publicKey)).to.be.true;

    // Check new owner received their share
    const newOwnerAfter = await getTokenBalance(newOwnerAta);
    const expectedOwnerShare = DEPOSIT - (DEPOSIT * BigInt(TREASURY_BPS)) / 10000n - (DEPOSIT * BigInt(COMMUNITY_BPS)) / 10000n;
    expect(newOwnerAfter - newOwnerBefore).to.equal(expectedOwnerShare);

    // Treasury also got its share
    const treasuryAfter = await getTokenBalance(treasuryAta);
    const expectedTreasuryShare = (DEPOSIT * BigInt(TREASURY_BPS)) / 10000n;
    expect(treasuryAfter - treasuryBefore).to.equal(expectedTreasuryShare);
  });

  it("✅ Distribute after owner update sends to new owner", async () => {
    const DEPOSIT = 200_000_000_000n; // 200K tokens

    await mintTo(
      connection, admin, mint, vault, admin, DEPOSIT,
      [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
    );

    const newOwnerBefore = await getTokenBalance(newOwnerAta);

    const tx = await program.methods
      .distribute()
      .accountsPartial({
        feeConfig: deriveFeeConfig(mint),
        baseMint: mint,
        vault,
        treasuryTokenAccount: treasuryAta,
        communityTokenAccount: communityAta,
        ownerTokenAccount: newOwnerAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .transaction();

    await sendAndConfirmTransaction(connection, tx, [admin]);

    const newOwnerAfter = await getTokenBalance(newOwnerAta);
    const expectedOwnerShare = DEPOSIT - (DEPOSIT * BigInt(TREASURY_BPS)) / 10000n - (DEPOSIT * BigInt(COMMUNITY_BPS)) / 10000n;
    expect(newOwnerAfter - newOwnerBefore).to.equal(expectedOwnerShare);
  });

  it("❌ Non-authority cannot update owner", async () => {
    try {
      const fakeSigner = Keypair.generate();
      await airdrop(fakeSigner.publicKey, 1);

      const tx = await program.methods
        .updateOwner()
        .accountsPartial({
          feeConfig: deriveFeeConfig(mint),
          authority: fakeSigner.publicKey,
          baseMint: mint,
          vault,
          treasuryTokenAccount: treasuryAta,
          communityTokenAccount: communityAta,
          newOwner: fakeSigner.publicKey,
          newOwnerTokenAccount: newOwnerAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .transaction();

      await sendAndConfirmTransaction(connection, tx, [admin, fakeSigner]);
      expect.fail("Should have thrown — wrong authority");
    } catch (e: any) {
      const logs = e.logs?.join("\n") || e.message || "";
      expect(logs).to.match(/ConstraintHasOne|has_one|custom program error|2001/);
    }
  });
});
