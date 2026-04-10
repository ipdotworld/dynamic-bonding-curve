/**
 * Update the authority key in IpworldState (key rotation).
 *
 * Usage:
 *   npx ts-node scripts/admin/update-authority.ts \
 *     --rpc https://api.devnet.solana.com \
 *     --new-authority <NEW_AUTHORITY_PUBKEY>
 *
 * Keys needed: Admin wallet (the deployer who initialized IpworldState)
 */

import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { execSync } from "child_process";

function parseArgs(): { rpc: string; newAuthority: string } {
  const args = process.argv.slice(2);
  let rpc = "", newAuthority = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rpc") rpc = args[++i];
    if (args[i] === "--new-authority") newAuthority = args[++i];
  }
  if (!rpc || !newAuthority) {
    console.error("Usage: --rpc <URL> --new-authority <PUBKEY>");
    process.exit(1);
  }
  return { rpc, newAuthority };
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
  const { rpc, newAuthority } = parseArgs();
  const connection = new Connection(rpc, "confirmed");
  const admin = getDeployerKeypair();
  const newAuthorityPubkey = new PublicKey(newAuthority);

  const anchorToml = readFileSync("Anchor.toml", "utf-8");
  const dbcMatch = anchorToml.match(/dynamic_bonding_curve\s*=\s*"([^"]+)"/);
  if (!dbcMatch) throw new Error("DBC program ID not found in Anchor.toml");
  const DBC_PROGRAM_ID = new PublicKey(dbcMatch[1]);

  const [ipworldState] = PublicKey.findProgramAddressSync(
    [Buffer.from("ipworld_state")], DBC_PROGRAM_ID
  );

  // Show current state
  const acct = await connection.getAccountInfo(ipworldState);
  if (!acct) throw new Error("IpworldState not initialized");
  const currentAuthority = new PublicKey(acct.data.subarray(8, 40));
  const currentAdmin = new PublicKey(acct.data.subarray(40, 72));

  console.log("═══════════════════════════════════════════");
  console.log("  Update Authority");
  console.log(`  Current authority: ${currentAuthority.toBase58()}`);
  console.log(`  New authority:     ${newAuthorityPubkey.toBase58()}`);
  console.log(`  Admin (signer):   ${admin.publicKey.toBase58()}`);
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
      anchorDisc("global:update_ipworld_authority"),
      newAuthorityPubkey.toBuffer(),
    ]),
  });

  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [admin]);
  console.log(`\n✅ Authority updated!`);
  console.log(`   Old: ${currentAuthority.toBase58()}`);
  console.log(`   New: ${newAuthorityPubkey.toBase58()}`);
  console.log(`   Sig: ${sig}`);
  console.log(`\n⚠️  Update your backend to use the new authority key!`);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
