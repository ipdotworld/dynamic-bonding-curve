/**
 * Transfer IpworldState admin rights to a new wallet.
 *
 * Usage:
 *   npx ts-node scripts/admin/update-admin.ts \
 *     --rpc https://api.devnet.solana.com \
 *     --new-admin <NEW_ADMIN_PUBKEY>
 *
 * Keys needed: Current admin wallet (set in `solana config`)
 *
 * ⚠️  After this, only the new admin can update authority/admin.
 */

import {
  Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { execSync } from "child_process";

function parseArgs(): { rpc: string; newAdmin: string } {
  const args = process.argv.slice(2);
  let rpc = "", newAdmin = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rpc") rpc = args[++i];
    if (args[i] === "--new-admin") newAdmin = args[++i];
  }
  if (!rpc || !newAdmin) {
    console.error("Usage: --rpc <URL> --new-admin <PUBKEY>");
    process.exit(1);
  }
  return { rpc, newAdmin };
}

function getDeployerKeypair(): Keypair {
  const cfgPath = execSync("solana config get keypair", { encoding: "utf-8" })
    .split("\n").find(l => l.includes("Keypair"))?.split(/\s+/).pop()?.trim();
  if (!cfgPath) throw new Error("No keypair in solana config");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(cfgPath, "utf-8"))));
}

function anchorDisc(name: string): Buffer {
  return createHash("sha256").update(name).digest().subarray(0, 8);
}

async function main() {
  const { rpc, newAdmin } = parseArgs();
  const connection = new Connection(rpc, "confirmed");
  const admin = getDeployerKeypair();
  const newAdminPubkey = new PublicKey(newAdmin);

  const anchorToml = readFileSync("Anchor.toml", "utf-8");
  const dbcMatch = anchorToml.match(/dynamic_bonding_curve\s*=\s*"([^"]+)"/);
  if (!dbcMatch) throw new Error("DBC program ID not found");
  const DBC_PROGRAM_ID = new PublicKey(dbcMatch[1]);

  const [ipworldState] = PublicKey.findProgramAddressSync(
    [Buffer.from("ipworld_state")], DBC_PROGRAM_ID
  );

  const acct = await connection.getAccountInfo(ipworldState);
  if (!acct) throw new Error("IpworldState not initialized");
  const currentAdmin = new PublicKey(acct.data.subarray(40, 72));

  console.log("═══════════════════════════════════════════");
  console.log("  Transfer Admin Rights");
  console.log(`  Current admin: ${currentAdmin.toBase58()}`);
  console.log(`  New admin:     ${newAdminPubkey.toBase58()}`);
  console.log("═══════════════════════════════════════════");

  if (!currentAdmin.equals(admin.publicKey)) {
    throw new Error(`You are not the admin. Admin is: ${currentAdmin.toBase58()}`);
  }

  const ix = new TransactionInstruction({
    programId: DBC_PROGRAM_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: ipworldState, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([
      anchorDisc("global:update_ipworld_admin"),
      newAdminPubkey.toBuffer(),
    ]),
  });

  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [admin]);
  console.log(`\n✅ Admin transferred!`);
  console.log(`   New admin: ${newAdminPubkey.toBase58()}`);
  console.log(`   Sig: ${sig}`);
  console.log(`\n⚠️  You can no longer update authority/admin. Only the new admin can.`);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
