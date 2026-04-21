import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { createHash } from "crypto";
import { LiteSVM } from "litesvm";
import path from "path";
import { deriveIpworldStateAddress, derivePoolAuthority } from "./accounts";
import {
  DAMM_PROGRAM_ID,
  DAMM_V2_PROGRAM_ID,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  FLASH_RENT_FUND,
  IPWORLD_HOOK_PROGRAM_ID,
  JUPITER_V6_PROGRAM_ID,
  LOCKER_PROGRAM_ID,
  METAPLEX_PROGRAM_ID,
  VAULT_PROGRAM_ID,
  ZAP_PROGRAM_ID,
} from "./constants";

export function startSvm() {
  const svm = new LiteSVM();

  const sourceFileDbcPath = path.resolve(
    "./target/deploy/dynamic_bonding_curve.so"
  );
  const sourceFileDammV2Path = path.resolve("./tests/fixtures/damm_v2.so");
  const sourceFileDammV1Path = path.resolve("./tests/fixtures/amm.so");
  const sourceFileAlphaVaultPath = path.resolve("./tests/fixtures/vault.so");
  const sourceFileLockerPath = path.resolve("./tests/fixtures/locker.so");
  const sourceFileMetaplexPath = path.resolve("./tests/fixtures/metaplex.so");
  const sourceFileZapProgramPath = path.resolve("./tests/fixtures/zap.so");
  const sourceFileJupiterPath = path.resolve("./tests/fixtures/jupiter.so");
  svm.addProgramFromFile(DYNAMIC_BONDING_CURVE_PROGRAM_ID, sourceFileDbcPath);
  svm.addProgramFromFile(DAMM_V2_PROGRAM_ID, sourceFileDammV2Path);
  svm.addProgramFromFile(DAMM_PROGRAM_ID, sourceFileDammV1Path);
  svm.addProgramFromFile(VAULT_PROGRAM_ID, sourceFileAlphaVaultPath);
  svm.addProgramFromFile(LOCKER_PROGRAM_ID, sourceFileLockerPath);
  svm.addProgramFromFile(METAPLEX_PROGRAM_ID, sourceFileMetaplexPath);
  svm.addProgramFromFile(ZAP_PROGRAM_ID, sourceFileZapProgramPath);
  svm.addProgramFromFile(JUPITER_V6_PROGRAM_ID, sourceFileJupiterPath);

  const sourceFileHookPath = path.resolve(
    "./target/deploy/ipworld_hook.so"
  );
  svm.addProgramFromFile(IPWORLD_HOOK_PROGRAM_ID, sourceFileHookPath);

  // set wrap sol mint account
  svm.setAccount(NATIVE_MINT, {
    data: new Uint8Array([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 1, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0,
    ]),
    executable: false,
    lamports: 1390379946687,
    owner: TOKEN_PROGRAM_ID,
  });
  svm.setAccount(derivePoolAuthority(), {
    lamports: FLASH_RENT_FUND,
    data: new Uint8Array(),
    owner: SystemProgram.programId,
    executable: false,
  });

  // Initialize IpworldState PDA required for Token2022 pool creation.
  // Layout: 8 discriminator + 32 authority + 32 admin + 32 pending_authority + 32 pending_admin + 1 bump = 137 bytes
  const ipworldState = deriveIpworldStateAddress();
  const [, ipworldBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("ipworld_state")],
    DYNAMIC_BONDING_CURVE_PROGRAM_ID
  );
  const discriminator = createHash("sha256")
    .update("account:IpworldState")
    .digest()
    .subarray(0, 8);
  _svmAuthority = Keypair.generate();
  const zeroKey = PublicKey.default;
  const ipworldData = Buffer.alloc(137);
  discriminator.copy(ipworldData, 0);
  _svmAuthority.publicKey.toBuffer().copy(ipworldData, 8);    // authority
  _svmAuthority.publicKey.toBuffer().copy(ipworldData, 40);   // admin
  zeroKey.toBuffer().copy(ipworldData, 72);          // pending_authority (zero = no pending)
  zeroKey.toBuffer().copy(ipworldData, 104);         // pending_admin (zero = no pending)
  ipworldData.writeUInt8(ipworldBump, 136);          // bump
  svm.setAccount(ipworldState, {
    lamports: 1_000_000_000,
    data: ipworldData,
    owner: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    executable: false,
  });

  return svm;
}

/** Authority keypair used for Ed25519 LaunchAuth/TradeAuth signatures in LiteSVM tests. */
let _svmAuthority: Keypair;

/** Returns the authority keypair that signed the IpworldState in the current SVM instance. */
export function getSvmAuthority(): Keypair {
  if (!_svmAuthority) throw new Error("startSvm() must be called before getSvmAuthority()");
  return _svmAuthority;
}

export function generateAndFund(svm: LiteSVM): Keypair {
  const kp = Keypair.generate();
  svm.airdrop(kp.publicKey, BigInt(10000 * LAMPORTS_PER_SOL));
  return kp;
}

export function setNativeMint(svm: LiteSVM) {
  svm.setAccount(NATIVE_MINT, {
    data: new Uint8Array([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 1, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0,
    ]),
    executable: false,
    lamports: 1390379946687,
    owner: TOKEN_PROGRAM_ID,
  });
}
