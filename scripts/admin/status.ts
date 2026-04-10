/**
 * Check deployment status — verifies all programs deployed and state initialized.
 *
 * Usage:
 *   npx ts-node scripts/admin/status.ts --rpc https://api.devnet.solana.com
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync, existsSync } from "fs";

function parseArgs(): { rpc: string } {
  const args = process.argv.slice(2);
  let rpc = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rpc") rpc = args[++i];
  }
  if (!rpc) { console.error("Usage: --rpc <URL>"); process.exit(1); }
  return { rpc };
}

async function checkProgram(connection: Connection, name: string, id: string): Promise<boolean> {
  try {
    const info = await connection.getAccountInfo(new PublicKey(id));
    if (info && info.executable) {
      console.log(`  ✅ ${name}: ${id} (deployed, ${(info.data.length / 1024).toFixed(0)}KB)`);
      return true;
    }
    console.log(`  ❌ ${name}: ${id} (not deployed)`);
    return false;
  } catch {
    console.log(`  ❌ ${name}: ${id} (error checking)`);
    return false;
  }
}

async function main() {
  const { rpc } = parseArgs();
  const connection = new Connection(rpc, "confirmed");

  const anchorToml = readFileSync("Anchor.toml", "utf-8");

  const programs: Record<string, string> = {};
  const matches = anchorToml.matchAll(/(\w+)\s*=\s*"([A-Za-z0-9]+)"/g);
  for (const m of matches) programs[m[1]] = m[2];

  console.log("═══════════════════════════════════════════════════");
  console.log(`  ipworld Deployment Status — ${rpc}`);
  console.log("═══════════════════════════════════════════════════");
  console.log("");

  // Check programs
  console.log("Programs:");
  for (const [name, id] of Object.entries(programs)) {
    await checkProgram(connection, name, id);
  }
  console.log("");

  // Check IpworldState
  console.log("On-chain state:");
  const dbcId = programs["dynamic_bonding_curve"];
  if (dbcId) {
    const DBC = new PublicKey(dbcId);
    const [ipworldState] = PublicKey.findProgramAddressSync([Buffer.from("ipworld_state")], DBC);
    const acct = await connection.getAccountInfo(ipworldState);
    if (acct) {
      const authority = new PublicKey(acct.data.subarray(8, 40));
      const admin = new PublicKey(acct.data.subarray(40, 72));
      console.log(`  ✅ IpworldState: initialized`);
      console.log(`     Authority: ${authority.toBase58()}`);
      console.log(`     Admin:     ${admin.toBase58()}`);
    } else {
      console.log(`  ❌ IpworldState: NOT initialized`);
      console.log(`     Run: npx ts-node scripts/admin/init-ipworld-state.ts --rpc ${rpc} --authority <PUBKEY>`);
    }
  }

  // Check env files
  console.log("");
  console.log("Config files:");
  const network = rpc.includes("devnet") ? "devnet" : rpc.includes("mainnet") ? "mainnet" : "unknown";
  const envFile = `scripts/addresses.${network}.env`;
  if (existsSync(envFile)) {
    const env = readFileSync(envFile, "utf-8");
    const treasury = env.match(/TREASURY_WALLET=(.+)/)?.[1]?.trim();
    const community = env.match(/COMMUNITY_WALLET=(.+)/)?.[1]?.trim();
    console.log(`  ✅ ${envFile} exists`);
    console.log(`     Treasury:  ${treasury || "⚠️  NOT SET"}`);
    console.log(`     Community: ${community || "⚠️  NOT SET"}`);
  } else {
    console.log(`  ❌ ${envFile} not found`);
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════");
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
