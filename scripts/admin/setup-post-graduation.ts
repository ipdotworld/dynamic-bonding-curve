/**
 * Set up fee splitting for a graduated token.
 * Call this AFTER a token graduates from the bonding curve to DAMM v2.
 * In production, your backend calls this automatically when it detects graduation.
 *
 * Usage:
 *   npx ts-node scripts/admin/setup-post-graduation.ts \
 *     --rpc https://api.devnet.solana.com \
 *     --mint <TOKEN_MINT_ADDRESS> \
 *     --authority <AUTHORITY_PUBKEY> \
 *     --treasury <TREASURY_WALLET> \
 *     --community <COMMUNITY_WALLET> \
 *     --treasury-bps 5714 --community-bps 3429 --owner-bps 857
 *
 * Keys needed: Deployer wallet (payer)
 */

import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import { readFileSync } from "fs";
import { execSync } from "child_process";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) opts[args[i].replace("--", "")] = args[i + 1];

  const required = ["rpc", "mint", "authority", "treasury", "community"];
  for (const r of required) {
    if (!opts[r]) { console.error(`Missing --${r}`); process.exit(1); }
  }
  return {
    rpc: opts.rpc,
    mint: new PublicKey(opts.mint),
    authority: new PublicKey(opts.authority),
    treasury: new PublicKey(opts.treasury),
    community: new PublicKey(opts.community),
    treasuryBps: parseInt(opts["treasury-bps"] || "5714"),
    communityBps: parseInt(opts["community-bps"] || "3429"),
    ownerBps: parseInt(opts["owner-bps"] || "857"),
  };
}

function getDeployerKeypair(): Keypair {
  const cfgPath = execSync("solana config get keypair", { encoding: "utf-8" })
    .split("\n").find(l => l.includes("Keypair"))?.split(/\s+/).pop()?.trim();
  if (!cfgPath) throw new Error("No keypair in solana config");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(cfgPath, "utf-8"))));
}

async function main() {
  const opts = parseArgs();
  const connection = new Connection(opts.rpc, "confirmed");
  const payer = getDeployerKeypair();

  // Read splitter program ID from Anchor.toml
  const anchorToml = readFileSync("Anchor.toml", "utf-8");
  const splitterMatch = anchorToml.match(/ipworld_splitter\s*=\s*"([^"]+)"/);
  if (!splitterMatch) throw new Error("Splitter program ID not found in Anchor.toml");
  const SPLITTER_ID = new PublicKey(splitterMatch[1]);

  const idl = JSON.parse(readFileSync("target/idl/ipworld_splitter.json", "utf-8"));
  const wallet = new Wallet(payer);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(idl, provider);

  const [feeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_config"), opts.mint.toBuffer()], SPLITTER_ID
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), opts.mint.toBuffer()], SPLITTER_ID
  );

  const total = opts.treasuryBps + opts.communityBps + opts.ownerBps;
  if (total !== 10000) {
    console.error(`BPS must sum to 10000, got ${total}`);
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════");
  console.log("  Init Fee Config (Splitter)");
  console.log(`  Mint:      ${opts.mint.toBase58()}`);
  console.log(`  Authority: ${opts.authority.toBase58()}`);
  console.log(`  Treasury:  ${opts.treasury.toBase58()} (${opts.treasuryBps} bps)`);
  console.log(`  Community: ${opts.community.toBase58()} (${opts.communityBps} bps)`);
  console.log(`  Owner:     defaults to community (${opts.ownerBps} bps)`);
  console.log(`  Vault PDA: ${vault.toBase58()}`);
  console.log("═══════════════════════════════════════════");

  const tx = await program.methods
    .initFeeConfig(opts.treasuryBps, opts.communityBps, opts.ownerBps)
    .accountsPartial({
      payer: payer.publicKey,
      authority: opts.authority,
      baseMint: opts.mint,
      feeConfig,
      vault,
      treasury: opts.treasury,
      community: opts.community,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
  console.log(`\n✅ Fee config initialized!`);
  console.log(`   Fee Config PDA: ${feeConfig.toBase58()}`);
  console.log(`   Vault PDA:      ${vault.toBase58()}`);
  console.log(`   Signature:      ${sig}`);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
