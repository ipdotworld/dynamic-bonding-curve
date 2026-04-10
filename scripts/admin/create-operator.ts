/**
 * Create an operator account — required before creating pool configs.
 *
 * Usage:
 *   npx ts-node scripts/admin/create-operator.ts --rpc https://api.devnet.solana.com
 *
 * Keys needed: Admin wallet (set in `solana config`)
 * The admin's own address is registered as the operator.
 */

import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "fs";
import { execSync } from "child_process";
import VirtualCurveIDL from "../../target/idl/dynamic_bonding_curve.json";
import { DynamicBondingCurve as VirtualCurve } from "../../target/types/dynamic_bonding_curve";

function parseArgs(): { rpc: string } {
  const args = process.argv.slice(2);
  let rpc = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rpc") rpc = args[++i];
  }
  if (!rpc) { console.error("Usage: --rpc <URL>"); process.exit(1); }
  return { rpc };
}

function getDeployerKeypair(): Keypair {
  const cfgPath = execSync("solana config get keypair", { encoding: "utf-8" })
    .split("\n").find(l => l.includes("Keypair"))?.split(/\s+/).pop()?.trim();
  if (!cfgPath) throw new Error("No keypair in solana config");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(cfgPath, "utf-8"))));
}

async function main() {
  const { rpc } = parseArgs();
  const connection = new Connection(rpc, "confirmed");
  const admin = getDeployerKeypair();

  const anchorToml = readFileSync("Anchor.toml", "utf-8");
  const dbcMatch = anchorToml.match(/dynamic_bonding_curve\s*=\s*"([^"]+)"/);
  if (!dbcMatch) throw new Error("DBC program ID not found");
  const DBC_PROGRAM_ID = new PublicKey(dbcMatch[1]);

  const wallet = new Wallet(admin);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program<VirtualCurve>(VirtualCurveIDL as VirtualCurve, provider);

  const [operatorPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("operator"), admin.publicKey.toBuffer()], DBC_PROGRAM_ID
  );

  console.log("═══════════════════════════════════════════");
  console.log("  Create Operator Account");
  console.log(`  Admin:    ${admin.publicKey.toBase58()}`);
  console.log(`  Operator: ${operatorPDA.toBase58()}`);
  console.log("═══════════════════════════════════════════");

  const tx = await program.methods
    .createOperatorAccount(new BN(1)) // permission level
    .accountsPartial({
      operator: operatorPDA,
      whitelistedAddress: admin.publicKey,
      signer: admin.publicKey,
      payer: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  const sig = await sendAndConfirmTransaction(connection, tx, [admin]);
  console.log(`\n✅ Operator created!`);
  console.log(`   PDA: ${operatorPDA.toBase58()}`);
  console.log(`   Sig: ${sig}`);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
