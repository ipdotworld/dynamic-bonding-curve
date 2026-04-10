/**
 * Initialize IpworldState PDA — stores authority pubkey for LaunchAuth/TradeAuth verification.
 *
 * Usage:
 *   npx ts-node scripts/admin/init-ipworld-state.ts \
 *     --rpc https://api.devnet.solana.com \
 *     --authority <AUTHORITY_PUBKEY>
 *
 * Keys needed: Deployer wallet (set in `solana config`)
 */

import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { execSync } from "child_process";

function parseArgs(): { rpc: string; authority: string } {
  const args = process.argv.slice(2);
  let rpc = "", authority = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rpc") rpc = args[++i];
    if (args[i] === "--authority") authority = args[++i];
  }
  if (!rpc || !authority) {
    console.error("Usage: --rpc <URL> --authority <PUBKEY>");
    process.exit(1);
  }
  return { rpc, authority };
}

function getDeployerKeypair(): Keypair {
  const cfgPath = execSync("solana config get keypair", { encoding: "utf-8" })
    .split("\n").find(l => l.includes("Keypair"))?.split(/\s+/).pop()?.trim();
  if (!cfgPath) throw new Error("No keypair in solana config");
  const raw = JSON.parse(readFileSync(cfgPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function anchorDisc(name: string): Buffer {
  return createHash("sha256").update(name).digest().subarray(0, 8);
}

async function main() {
  const { rpc, authority } = parseArgs();
  const connection = new Connection(rpc, "confirmed");
  const deployer = getDeployerKeypair();
  const authorityPubkey = new PublicKey(authority);

  // Read DBC program ID from Anchor.toml
  const anchorToml = readFileSync("Anchor.toml", "utf-8");
  const dbcMatch = anchorToml.match(/dynamic_bonding_curve\s*=\s*"([^"]+)"/);
  if (!dbcMatch) throw new Error("DBC program ID not found in Anchor.toml");
  const DBC_PROGRAM_ID = new PublicKey(dbcMatch[1]);

  const [ipworldState] = PublicKey.findProgramAddressSync(
    [Buffer.from("ipworld_state")],
    DBC_PROGRAM_ID
  );

  console.log("═══════════════════════════════════════════");
  console.log("  Init IpworldState PDA");
  console.log(`  RPC:       ${rpc}`);
  console.log(`  Admin:     ${deployer.publicKey.toBase58()}`);
  console.log(`  Authority: ${authorityPubkey.toBase58()}`);
  console.log(`  PDA:       ${ipworldState.toBase58()}`);
  console.log(`  Program:   ${DBC_PROGRAM_ID.toBase58()}`);
  console.log("═══════════════════════════════════════════");

  // Check if already initialized
  const existing = await connection.getAccountInfo(ipworldState);
  if (existing) {
    console.log("\n⚠️  IpworldState already initialized!");
    console.log("   Use update-authority.ts to change the authority.");
    process.exit(0);
  }

  const ix = new TransactionInstruction({
    programId: DBC_PROGRAM_ID,
    keys: [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ipworldState, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      anchorDisc("global:init_ipworld_state"),
      authorityPubkey.toBuffer(),
    ]),
  });

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [deployer]);

  console.log(`\n✅ IpworldState initialized!`);
  console.log(`   Signature: ${sig}`);
  console.log(`   Explorer:  https://explorer.solana.com/tx/${sig}?cluster=${rpc.includes("devnet") ? "devnet" : "mainnet-beta"}`);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
