/**
 * Update IP owner address — flushes accumulated fees to new owner, then updates.
 *
 * Usage:
 *   npx ts-node scripts/admin/update-owner.ts \
 *     --rpc https://api.devnet.solana.com \
 *     --mint <TOKEN_MINT_ADDRESS> \
 *     --new-owner <OWNER_WALLET_ADDRESS> \
 *     --authority keys/devnet/authority-keypair.json
 *
 * Keys needed: Authority keypair (signer), payer wallet (from solana config)
 */

import {
  Connection, Keypair, PublicKey,
  Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "fs";
import { execSync } from "child_process";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) opts[args[i].replace("--", "")] = args[i + 1];
  const required = ["rpc", "mint", "new-owner", "authority"];
  for (const r of required) {
    if (!opts[r]) { console.error(`Missing --${r}`); process.exit(1); }
  }
  return {
    rpc: opts.rpc,
    mint: new PublicKey(opts.mint),
    newOwner: new PublicKey(opts["new-owner"]),
    authorityPath: opts.authority,
  };
}

function getPayerKeypair(): Keypair {
  const cfgPath = execSync("solana config get keypair", { encoding: "utf-8" })
    .split("\n").find(l => l.includes("Keypair"))?.split(/\s+/).pop()?.trim();
  if (!cfgPath) throw new Error("No keypair in solana config");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(cfgPath, "utf-8"))));
}

async function main() {
  const opts = parseArgs();
  const connection = new Connection(opts.rpc, "confirmed");
  const payer = getPayerKeypair();
  const authority = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(opts.authorityPath, "utf-8")))
  );

  const anchorToml = readFileSync("Anchor.toml", "utf-8");
  const splitterMatch = anchorToml.match(/ipworld_splitter\s*=\s*"([^"]+)"/);
  if (!splitterMatch) throw new Error("Splitter program ID not found");
  const SPLITTER_ID = new PublicKey(splitterMatch[1]);

  const idl = JSON.parse(readFileSync("target/idl/ipworld_splitter.json", "utf-8"));
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const program = new Program(idl, provider);

  const [feeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_config"), opts.mint.toBuffer()], SPLITTER_ID
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), opts.mint.toBuffer()], SPLITTER_ID
  );

  const config = await program.account.feeConfig.fetch(feeConfig);
  const treasuryAta = await getAssociatedTokenAddress(opts.mint, config.treasury, false, TOKEN_2022_PROGRAM_ID);
  const communityAta = await getAssociatedTokenAddress(opts.mint, config.community, false, TOKEN_2022_PROGRAM_ID);
  const newOwnerAta = await getAssociatedTokenAddress(opts.mint, opts.newOwner, false, TOKEN_2022_PROGRAM_ID);

  const vaultInfo = await connection.getTokenAccountBalance(vault);

  console.log("═══════════════════════════════════════════");
  console.log("  Update Owner");
  console.log(`  Mint:       ${opts.mint.toBase58()}`);
  console.log(`  Old owner:  ${config.owner.toBase58()}`);
  console.log(`  New owner:  ${opts.newOwner.toBase58()}`);
  console.log(`  Vault:      ${vaultInfo.value.uiAmount} tokens (will be flushed)`);
  console.log("═══════════════════════════════════════════");

  // Create new owner ATA if it doesn't exist
  const preIxs = [];
  try {
    await getAccount(connection, newOwnerAta, "confirmed", TOKEN_2022_PROGRAM_ID);
  } catch {
    console.log(`  Creating ATA for new owner...`);
    preIxs.push(
      createAssociatedTokenAccountInstruction(
        payer.publicKey, newOwnerAta, opts.newOwner, opts.mint, TOKEN_2022_PROGRAM_ID
      )
    );
  }

  const tx = await program.methods
    .updateOwner()
    .accountsPartial({
      feeConfig,
      authority: authority.publicKey,
      baseMint: opts.mint,
      vault,
      treasuryTokenAccount: treasuryAta,
      communityTokenAccount: communityAta,
      newOwner: opts.newOwner,
      newOwnerTokenAccount: newOwnerAta,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .preInstructions(preIxs)
    .transaction();

  const sig = await sendAndConfirmTransaction(connection, tx, [payer, authority]);
  console.log(`\n✅ Owner updated!`);
  console.log(`   New owner: ${opts.newOwner.toBase58()}`);
  console.log(`   Signature: ${sig}`);
  console.log(`\n   Future distribute() calls will send owner share to this address.`);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
