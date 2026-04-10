/**
 * Show current IpworldState PDA — displays authority, admin, and program status.
 *
 * Usage:
 *   npx ts-node scripts/admin/show-ipworld-state.ts --rpc https://api.devnet.solana.com
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import { readFileSync } from "fs";

function parseArgs(): { rpc: string } {
  const args = process.argv.slice(2);
  let rpc = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rpc") rpc = args[++i];
  }
  if (!rpc) { console.error("Usage: --rpc <URL>"); process.exit(1); }
  return { rpc };
}

async function main() {
  const { rpc } = parseArgs();
  const connection = new Connection(rpc, "confirmed");

  const anchorToml = readFileSync("Anchor.toml", "utf-8");
  const dbcMatch = anchorToml.match(/dynamic_bonding_curve\s*=\s*"([^"]+)"/);
  if (!dbcMatch) throw new Error("DBC program ID not found in Anchor.toml");
  const DBC_PROGRAM_ID = new PublicKey(dbcMatch[1]);

  const [ipworldState] = PublicKey.findProgramAddressSync(
    [Buffer.from("ipworld_state")], DBC_PROGRAM_ID
  );

  const acct = await connection.getAccountInfo(ipworldState);
  if (!acct) {
    console.log("❌ IpworldState not initialized");
    console.log(`   Expected PDA: ${ipworldState.toBase58()}`);
    console.log(`   Run: npx ts-node scripts/admin/init-ipworld-state.ts --rpc ${rpc} --authority <PUBKEY>`);
    process.exit(1);
  }

  // Parse: 8 disc + 32 authority + 32 admin + 1 bump
  const data = acct.data;
  const authority = new PublicKey(data.subarray(8, 40));
  const admin = new PublicKey(data.subarray(40, 72));
  const bump = data[72];

  console.log("═══════════════════════════════════════════");
  console.log("  IpworldState PDA");
  console.log(`  Address:   ${ipworldState.toBase58()}`);
  console.log(`  Authority: ${authority.toBase58()}`);
  console.log(`  Admin:     ${admin.toBase58()}`);
  console.log(`  Bump:      ${bump}`);
  console.log(`  Program:   ${DBC_PROGRAM_ID.toBase58()}`);
  console.log("═══════════════════════════════════════════");
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
