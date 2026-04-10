/**
 * Distribute fees from a splitter vault — permissionless, anyone can call.
 *
 * Usage:
 *   npx ts-node scripts/admin/distribute.ts \
 *     --rpc https://api.devnet.solana.com \
 *     --mint <TOKEN_MINT_ADDRESS>
 *
 * Keys needed: Any funded wallet (just pays tx fee ~0.000005 SOL)
 */

import {
  Connection, Keypair, PublicKey,
  Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddress,
} from "@solana/spl-token";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "fs";
import { execSync } from "child_process";

function parseArgs() {
  const args = process.argv.slice(2);
  let rpc = "", mint = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rpc") rpc = args[++i];
    if (args[i] === "--mint") mint = args[++i];
  }
  if (!rpc || !mint) { console.error("Usage: --rpc <URL> --mint <PUBKEY>"); process.exit(1); }
  return { rpc, mint: new PublicKey(mint) };
}

function getPayerKeypair(): Keypair {
  const cfgPath = execSync("solana config get keypair", { encoding: "utf-8" })
    .split("\n").find(l => l.includes("Keypair"))?.split(/\s+/).pop()?.trim();
  if (!cfgPath) throw new Error("No keypair in solana config");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(cfgPath, "utf-8"))));
}

async function main() {
  const { rpc, mint } = parseArgs();
  const connection = new Connection(rpc, "confirmed");
  const payer = getPayerKeypair();

  const anchorToml = readFileSync("Anchor.toml", "utf-8");
  const splitterMatch = anchorToml.match(/ipworld_splitter\s*=\s*"([^"]+)"/);
  if (!splitterMatch) throw new Error("Splitter program ID not found");
  const SPLITTER_ID = new PublicKey(splitterMatch[1]);

  const idl = JSON.parse(readFileSync("target/idl/ipworld_splitter.json", "utf-8"));
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const program = new Program(idl, provider);

  const [feeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_config"), mint.toBuffer()], SPLITTER_ID
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), mint.toBuffer()], SPLITTER_ID
  );

  // Read config to get addresses
  const config = await program.account.feeConfig.fetch(feeConfig);
  const treasuryAta = await getAssociatedTokenAddress(mint, config.treasury, false, TOKEN_2022_PROGRAM_ID);
  const communityAta = await getAssociatedTokenAddress(mint, config.community, false, TOKEN_2022_PROGRAM_ID);
  const ownerAta = await getAssociatedTokenAddress(mint, config.owner, false, TOKEN_2022_PROGRAM_ID);

  // Check vault balance
  const vaultInfo = await connection.getTokenAccountBalance(vault);
  const balance = vaultInfo.value.uiAmount;

  console.log("═══════════════════════════════════════════");
  console.log("  Distribute Fees");
  console.log(`  Mint:      ${mint.toBase58()}`);
  console.log(`  Vault:     ${vault.toBase58()} (${balance} tokens)`);
  console.log(`  Treasury:  ${config.treasury.toBase58()} (${config.treasuryBps} bps)`);
  console.log(`  Community: ${config.community.toBase58()} (${config.communityBps} bps)`);
  console.log(`  Owner:     ${config.owner.toBase58()} (${config.ownerBps} bps)`);
  console.log("═══════════════════════════════════════════");

  if (!balance || balance === 0) {
    console.log("\n⚠️  Vault is empty — nothing to distribute.");
    process.exit(0);
  }

  const tx = await program.methods
    .distribute()
    .accountsPartial({
      feeConfig,
      baseMint: mint,
      vault,
      treasuryTokenAccount: treasuryAta,
      communityTokenAccount: communityAta,
      ownerTokenAccount: ownerAta,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .transaction();

  const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
  console.log(`\n✅ Fees distributed!`);
  console.log(`   Signature: ${sig}`);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
