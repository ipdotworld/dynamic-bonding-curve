import { describe, it, before } from "mocha";
import { expect } from "chai";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "crypto";

const DBC_PROGRAM_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
const IPWORLD_STATE_SEED = Buffer.from("ipworld_state");

const connection = new Connection("http://127.0.0.1:8899", "confirmed");

async function airdrop(pubkey: PublicKey, sol: number) {
  const sig = await connection.requestAirdrop(pubkey, sol * 1e9);
  await connection.confirmTransaction(sig, "confirmed");
}

function getIpworldStatePDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([IPWORLD_STATE_SEED], DBC_PROGRAM_ID);
}

// Build the init_ipworld_state instruction manually via Anchor discriminator
function buildInitIx(
  payer: PublicKey,
  ipworldState: PublicKey,
  authority: PublicKey
): TransactionInstruction {
  const disc = createHash("sha256")
    .update("global:init_ipworld_state")
    .digest()
    .slice(0, 8);

  // Borsh-serialize the authority pubkey argument
  const data = Buffer.concat([disc, authority.toBuffer()]);

  return new TransactionInstruction({
    programId: DBC_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ipworldState, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildUpdateAuthorityIx(
  admin: PublicKey,
  ipworldState: PublicKey,
  newAuthority: PublicKey
): TransactionInstruction {
  const disc = createHash("sha256")
    .update("global:update_ipworld_authority")
    .digest()
    .slice(0, 8);

  const data = Buffer.concat([disc, newAuthority.toBuffer()]);

  return new TransactionInstruction({
    programId: DBC_PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: false },
      { pubkey: ipworldState, isSigner: false, isWritable: true },
    ],
    data,
  });
}

function buildUpdateAdminIx(
  admin: PublicKey,
  ipworldState: PublicKey,
  newAdmin: PublicKey
): TransactionInstruction {
  const disc = createHash("sha256")
    .update("global:update_ipworld_admin")
    .digest()
    .slice(0, 8);

  const data = Buffer.concat([disc, newAdmin.toBuffer()]);

  return new TransactionInstruction({
    programId: DBC_PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: false },
      { pubkey: ipworldState, isSigner: false, isWritable: true },
    ],
    data,
  });
}

async function fetchIpworldState(
  conn: Connection,
  pda: PublicKey
): Promise<{ authority: PublicKey; admin: PublicKey; bump: number }> {
  const info = await conn.getAccountInfo(pda);
  expect(info).to.not.be.null;
  // Skip 8-byte Anchor discriminator
  const data = info!.data.slice(8);
  const authority = new PublicKey(data.slice(0, 32));
  const admin = new PublicKey(data.slice(32, 64));
  const bump = data[64];
  return { authority, admin, bump };
}

describe("Step 2 — IpworldState admin instructions", () => {
  const deployer = Keypair.generate();
  const authority = Keypair.generate();
  const [ipworldStatePDA] = getIpworldStatePDA();

  before(async () => {
    await airdrop(deployer.publicKey, 5);
  });

  it("init_ipworld_state — creates PDA with correct fields", async () => {
    const ix = buildInitIx(deployer.publicKey, ipworldStatePDA, authority.publicKey);
    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(connection, tx, [deployer]);

    const state = await fetchIpworldState(connection, ipworldStatePDA);
    expect(state.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(state.admin.toBase58()).to.equal(deployer.publicKey.toBase58());
    console.log("    ✅ IpworldState PDA created, authority + admin correct");
  });

  it("init_ipworld_state — double init should fail", async () => {
    const ix = buildInitIx(deployer.publicKey, ipworldStatePDA, authority.publicKey);
    const tx = new Transaction().add(ix);
    let failed = false;
    try {
      await sendAndConfirmTransaction(connection, tx, [deployer]);
    } catch {
      failed = true;
    }
    expect(failed, "Double init should have failed").to.be.true;
    console.log("    ✅ Double init correctly rejected");
  });

  it("update_ipworld_authority — admin can rotate authority", async () => {
    const newAuthority = Keypair.generate();
    const ix = buildUpdateAuthorityIx(
      deployer.publicKey,
      ipworldStatePDA,
      newAuthority.publicKey
    );
    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(connection, tx, [deployer]);

    const state = await fetchIpworldState(connection, ipworldStatePDA);
    expect(state.authority.toBase58()).to.equal(newAuthority.publicKey.toBase58());
    console.log("    ✅ Authority rotated successfully");
  });

  it("update_ipworld_authority — wrong signer rejected", async () => {
    const imposter = Keypair.generate();
    await airdrop(imposter.publicKey, 1);
    const newAuthority = Keypair.generate();
    const ix = buildUpdateAuthorityIx(
      imposter.publicKey,
      ipworldStatePDA,
      newAuthority.publicKey
    );
    const tx = new Transaction().add(ix);
    let failed = false;
    try {
      await sendAndConfirmTransaction(connection, tx, [imposter]);
    } catch {
      failed = true;
    }
    expect(failed, "Wrong signer should be rejected").to.be.true;
    console.log("    ✅ Wrong signer correctly rejected");
  });

  it("update_ipworld_admin — admin can transfer admin rights", async () => {
    const newAdmin = Keypair.generate();
    await airdrop(newAdmin.publicKey, 2);
    const ix = buildUpdateAdminIx(deployer.publicKey, ipworldStatePDA, newAdmin.publicKey);
    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(connection, tx, [deployer]);

    const state = await fetchIpworldState(connection, ipworldStatePDA);
    expect(state.admin.toBase58()).to.equal(newAdmin.publicKey.toBase58());
    console.log("    ✅ Admin transferred successfully");

    // Now verify old admin is locked out
    const anotherAuthority = Keypair.generate();
    const ix2 = buildUpdateAuthorityIx(
      deployer.publicKey,
      ipworldStatePDA,
      anotherAuthority.publicKey
    );
    const tx2 = new Transaction().add(ix2);
    let failed = false;
    try {
      await sendAndConfirmTransaction(connection, tx2, [deployer]);
    } catch {
      failed = true;
    }
    expect(failed, "Old admin should be locked out").to.be.true;
    console.log("    ✅ Old admin correctly locked out after transfer");
  });
});
