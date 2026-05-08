import {
  Ed25519Program,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";

/**
 * Serialize a LaunchAuth payload (Borsh layout: creator + config + pool_pda).
 * Must match programs/dynamic-bonding-curve/src/state/auth_structs.rs LaunchAuth.
 */
export function serializeLaunchAuth(
  creator: PublicKey,
  config: PublicKey,
  poolPda: PublicKey
): Buffer {
  return Buffer.concat([
    creator.toBuffer(),
    config.toBuffer(),
    poolPda.toBuffer(),
  ]);
}

/**
 * Serialize a TradeAuth payload (Borsh layout: user + expires_at).
 * Must match programs/dynamic-bonding-curve/src/state/auth_structs.rs TradeAuth.
 */
export function serializeTradeAuth(
  user: PublicKey,
  expiresAt: number
): Buffer {
  const buf = Buffer.alloc(40);
  user.toBuffer().copy(buf, 0);
  buf.writeBigInt64LE(BigInt(expiresAt), 32);
  return buf;
}

/**
 * Build an Ed25519Program instruction that verifies `message` was signed by `authority`.
 * The DBC program reads this as the previous instruction via instructions_sysvar.
 */
export function buildEd25519Ix(
  authority: Keypair,
  message: Buffer
): TransactionInstruction {
  const signature = nacl.sign.detached(message, authority.secretKey);
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: authority.publicKey.toBytes(),
    message,
    signature: Buffer.from(signature),
  });
}
