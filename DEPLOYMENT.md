# Deployment & Operations Guide — ipworld Solana Programs

> **Audience:** Anyone deploying and operating ipworld's Solana programs.
> Assumes basic CLI comfort but NOT deep Solana knowledge.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Prerequisites](#2-prerequisites)
3. [Concepts: Wallets, Keypairs, and PDAs](#3-concepts-wallets-keypairs-and-pdas)
4. [Wallet & Keypair Setup](#4-wallet--keypair-setup)
5. [Build Programs](#5-build-programs)
6. [Deploy to Devnet](#6-deploy-to-devnet)
7. [Deploy to Mainnet](#7-deploy-to-mainnet)
8. [Post-Deployment: Initialize On-Chain State](#8-post-deployment-initialize-on-chain-state)
9. [Administrative Operations](#9-administrative-operations)
10. [Meteora Revenue Share](#10-meteora-revenue-share)
11. [Program Upgrades & Security](#11-program-upgrades--security)
12. [Testing](#12-testing)
13. [Architecture Summary](#13-architecture-summary)
14. [Checklist](#14-checklist)

---

## 1. Overview

ipworld deploys **3 Solana programs**:

| Program | What it does | Lines |
|---------|-------------|-------|
| `dynamic_bonding_curve` | Forked Meteora DBC — bonding curve with hook + auth gating | ~500 lines added |
| `ipworld_hook` | Token-2022 Transfer Hook — 5% ownership cap, vault-only transfers | 232 lines |
| `ipworld_splitter` | Fee distribution — 3-way split (treasury / community / owner) | 421 lines |

Plus **unmodified** Meteora DAMM v2 (already deployed on mainnet — we don't deploy this).

---

## 2. Prerequisites

### Install Solana CLI

```bash
# Install Solana CLI (includes solana, solana-keygen, solana-test-validator)
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# Verify
solana --version   # Should show 2.x or 1.18+
```

### Install Rust + Anchor

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# Anchor Version Manager
cargo install --git https://github.com/coral-xyz/anchor avm --locked
avm install 0.31.0
avm use 0.31.0

# Verify
anchor --version   # Should show 0.31.x
```

### Install Node.js

```bash
# Node.js 18+ (for tests and admin scripts)
# Use nvm, brew, or download from nodejs.org
node --version  # Should show v18+
npm --version

# Install project dependencies
cd /path/to/dynamic-bonding-curve
yarn install  # or npm install
```

---

## 3. Concepts: Wallets, Keypairs, and PDAs

> Skip this section if you already know Solana basics.

### What is a keypair?

A keypair is a file containing a **private key** (secret) and **public key** (address). The public key is your address on Solana — like a bank account number. The private key is what lets you sign transactions — like your PIN.

A keypair file looks like: `[45,12,200,...,88]` — it's a JSON array of 64 bytes.

### Types of keypairs you'll manage

| Keypair | What it controls | How sensitive |
|---------|-----------------|---------------|
| **Deployer wallet** | Pays for deployments, funds other wallets | Medium — needs SOL, but can be rotated |
| **Program keypairs** (×3) | The program's on-chain address + who can upgrade it | HIGH — if lost, you can't upgrade; if leaked, someone else can |
| **Authority keypair** | Signs LaunchAuth + TradeAuth (backend hot key) | CRITICAL — this key approves every launch and trade |
| **Admin wallet** | Initializes IpworldState, creates configs | Medium — one-time setup, can be the deployer |
| **Treasury wallet** | Receives protocol revenue (50% of post-grad fees) | HIGH — should be a multisig |
| **Community wallet** | Backend-controlled; distributes holder + UGC rewards | HIGH — backend needs this private key for batch transfers |

### What is a PDA?

A Program Derived Address (PDA) is an address with **no private key**. Only the program that created it can sign for it. PDAs are used for:
- `IpworldState` — stores the authority public key
- Splitter `vault` — holds fees before distribution
- Splitter `fee_config` — stores split ratios per token
- Pool authority — controls the bonding curve pool

You never create keypairs for PDAs — the program derives them deterministically from seeds.

---

## 4. Wallet & Keypair Setup

### Step 4.1: Create a deployer wallet

This wallet pays for deployments (~15-20 SOL on mainnet).

```bash
# Generate a new deployer wallet
solana-keygen new -o ~/.config/solana/deployer.json

# It will print something like:
#   pubkey: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
# SAVE THIS ADDRESS. You'll need to fund it.

# Set it as your default wallet
solana config set --keypair ~/.config/solana/deployer.json

# Verify
solana address  # Should print your deployer address
```

### Step 4.2: Generate program keypairs

Each program needs its own keypair. The public key becomes the program's permanent on-chain ID.

```bash
# ─── For Devnet ───
mkdir -p keys/devnet

solana-keygen new --no-bip39-passphrase -o keys/devnet/dynamic_bonding_curve-keypair.json
solana-keygen new --no-bip39-passphrase -o keys/devnet/ipworld_hook-keypair.json
solana-keygen new --no-bip39-passphrase -o keys/devnet/ipworld_splitter-keypair.json

# View the program IDs you just generated:
echo "DBC:      $(solana-keygen pubkey keys/devnet/dynamic_bonding_curve-keypair.json)"
echo "Hook:     $(solana-keygen pubkey keys/devnet/ipworld_hook-keypair.json)"
echo "Splitter: $(solana-keygen pubkey keys/devnet/ipworld_splitter-keypair.json)"

# ─── For Mainnet (DIFFERENT keypairs — never reuse devnet keys) ───
mkdir -p keys/mainnet

solana-keygen new --no-bip39-passphrase -o keys/mainnet/dynamic_bonding_curve-keypair.json
solana-keygen new --no-bip39-passphrase -o keys/mainnet/ipworld_hook-keypair.json
solana-keygen new --no-bip39-passphrase -o keys/mainnet/ipworld_splitter-keypair.json
```

### Step 4.3: Generate the authority keypair

This is the key your backend uses to sign LaunchAuth and TradeAuth. It's the most security-critical key.

```bash
# Devnet
solana-keygen new --no-bip39-passphrase -o keys/devnet/authority-keypair.json
echo "Authority: $(solana-keygen pubkey keys/devnet/authority-keypair.json)"

# Mainnet
solana-keygen new --no-bip39-passphrase -o keys/mainnet/authority-keypair.json
echo "Authority: $(solana-keygen pubkey keys/mainnet/authority-keypair.json)"
```

> ⚠️ **Production:** The authority keypair should NOT live as a file on your server. Use AWS KMS, HashiCorp Vault, or a similar HSM/key management service. The file-based approach is fine for devnet testing.

### Step 4.4: Prepare treasury and community wallets

**Treasury wallet** — receives 50% of post-graduation fees. Should be a multisig (e.g., Squads Protocol on Solana).

```bash
# Option A: Simple wallet (OK for devnet)
solana-keygen new --no-bip39-passphrase -o keys/devnet/treasury-keypair.json
echo "Treasury: $(solana-keygen pubkey keys/devnet/treasury-keypair.json)"

# Option B: Multisig (RECOMMENDED for mainnet)
# Create a Squads multisig at https://squads.so
# Use the multisig vault address as your treasury
```

**Community wallet** — backend-controlled, used for holder + UGC airdrops. Backend needs the private key to batch-transfer from this wallet.

```bash
solana-keygen new --no-bip39-passphrase -o keys/devnet/community-keypair.json
echo "Community: $(solana-keygen pubkey keys/devnet/community-keypair.json)"

# Mainnet
solana-keygen new --no-bip39-passphrase -o keys/mainnet/community-keypair.json
echo "Community: $(solana-keygen pubkey keys/mainnet/community-keypair.json)"
```

### Step 4.5: Update env files

Open `scripts/addresses.devnet.env` and fill in your generated public keys:

```bash
DBC_PROGRAM_ID=<paste DBC pubkey>
HOOK_PROGRAM_ID=<paste Hook pubkey>
SPLITTER_PROGRAM_ID=<paste Splitter pubkey>
AUTHORITY_PUBKEY=<paste Authority pubkey>
TREASURY_WALLET=<paste Treasury pubkey>
COMMUNITY_WALLET=<paste Community pubkey>
```

Do the same for `scripts/addresses.mainnet.env`.

### Step 4.6: Back up all keypairs

```bash
# Create encrypted backup
tar czf ipworld-keys-backup.tar.gz keys/
gpg --symmetric --cipher-algo AES256 ipworld-keys-backup.tar.gz
# Enter a strong passphrase. Store the .gpg file in a secure location.
rm ipworld-keys-backup.tar.gz  # Remove unencrypted version

# Or use your org's secret management (1Password, Vault, etc.)
```

> ⚠️ **If you lose a program keypair, you CANNOT upgrade that program.** Back them up.
>
> ⚠️ **If someone gets your program keypair, they can push a malicious upgrade.** Keep them secret.

---

## 5. Build Programs

### Build for local testing

```bash
# Builds all 3 programs with auth bypasses for LiteSVM testing
cargo build-sbf -- --features local,skip-launch-auth,skip-trade-auth
```

### Build for deployment (NO feature flags)

```bash
# Swap IDs to target network first
./scripts/set-program-ids.sh devnet   # or mainnet

# Build ALL programs — no feature flags = all auth enforced
cargo build-sbf

# Build individual programs
(cd programs/ipworld-hook && cargo build-sbf)
(cd programs/ipworld-splitter && cargo build-sbf)

# Restore local test IDs when done
./scripts/set-program-ids.sh local
```

> ⚠️ **NEVER deploy with `--features local,skip-launch-auth,skip-trade-auth`**. Those flags bypass ALL auth. A production build MUST have zero feature flags.

---

## 6. Deploy to Devnet

```bash
# 1. Point CLI at devnet
solana config set --url https://api.devnet.solana.com
solana config set --keypair ~/.config/solana/deployer.json

# 2. Fund your deployer (need ~15 SOL — each program deploy costs ~3-5 SOL)
solana airdrop 5    # devnet faucet, run 3x
solana balance      # verify you have enough

# 3. Swap source code to devnet program IDs
./scripts/set-program-ids.sh devnet

# 4. Build (NO feature flags)
cargo build-sbf
(cd programs/ipworld-hook && cargo build-sbf)
(cd programs/ipworld-splitter && cargo build-sbf)

# 5. Deploy
./scripts/deploy-programs.sh devnet

# 6. Restore local IDs for continued development
./scripts/set-program-ids.sh local

# 7. Proceed to Section 8 (Post-Deployment Initialization)
```

---

## 7. Deploy to Mainnet

```bash
# 1. Point CLI at mainnet
solana config set --url https://api.mainnet-beta.solana.com
solana config set --keypair /path/to/funded-deployer.json

# 2. Verify you have enough SOL (~20 SOL recommended)
solana balance

# 3. Swap source code to mainnet program IDs
./scripts/set-program-ids.sh mainnet

# 4. Build (NO feature flags — critical!)
cargo build-sbf
(cd programs/ipworld-hook && cargo build-sbf)
(cd programs/ipworld-splitter && cargo build-sbf)

# 5. Deploy (will ask you to type "DEPLOY" to confirm)
./scripts/deploy-programs.sh mainnet

# 6. Restore local IDs
./scripts/set-program-ids.sh local

# 7. Proceed to Section 8 (Post-Deployment Initialization)
```

---

## 8. Post-Deployment: Initialize On-Chain State

After deploying the programs, you need to create the on-chain state they depend on. These are one-time operations per network.

> **Keys needed for this section:**
> - Deployer wallet (pays for transactions) — already set in `solana config`
> - Authority keypair public key (stored on-chain in IpworldState)

### Step 8.1: Initialize IpworldState PDA

**What:** Creates the global `IpworldState` account that stores the authority public key. All LaunchAuth and TradeAuth signatures are verified against this key.

**Who can call:** Anyone (first caller becomes admin). The admin can later update the authority.

**Keys needed:** Deployer wallet (signer + payer), authority public key (stored, not signed).

```bash
npx ts-node scripts/admin/init-ipworld-state.ts \
  --rpc <RPC_URL> \
  --authority <AUTHORITY_PUBKEY>

# Example:
npx ts-node scripts/admin/init-ipworld-state.ts \
  --rpc https://api.devnet.solana.com \
  --authority $(solana-keygen pubkey keys/devnet/authority-keypair.json)
```

**Verify it worked:**
```bash
npx ts-node scripts/admin/show-ipworld-state.ts --rpc <RPC_URL>
# Should print: authority=<your authority pubkey>, admin=<your deployer pubkey>
```

### Step 8.2: Create Operator Account

**What:** Registers the deployer wallet as an operator with config-creation permissions. Required before creating pool configs.

**Who can call:** The admin (whoever initialized IpworldState in 8.1).

**Keys needed:** Deployer wallet (set in `solana config`).

```bash
# Example (devnet):
npx ts-node scripts/admin/create-operator.ts \
  --rpc https://api.devnet.solana.com

# Example (mainnet):
npx ts-node scripts/admin/create-operator.ts \
  --rpc https://api.mainnet-beta.solana.com
```

### Step 8.3: Create Pool Config

**What:** Creates a reusable pool config template that defines fee structure, curve shape, migration threshold, and token type. Every pool launched will reference one of these configs.

**Who can call:** An operator (created in 8.2).

**Keys needed:** Deployer wallet, treasury wallet address (for `fee_claimer`).

```bash
npx ts-node scripts/admin/create-pool-config.ts \
  --rpc <RPC_URL> \
  --fee-claimer <TREASURY_WALLET> \
  --migration-threshold 500 \
  --compounding-fee-bps 1250
```

**Key parameters explained:**

| Parameter | Value | Meaning |
|-----------|-------|---------|
| `fee_claimer` | Treasury wallet address | Who receives the 80% pre-graduation trading fees |
| `creator_trading_fee_percentage` | 0 | Owner's cut pre-graduation (0 because owner unknown at launch) |
| `migration_quote_threshold` | 500 SOL (adjust) | How much SOL fills the curve before graduation triggers |
| `migration_option` | 1 (DAMM v2) | Where the pool graduates to |
| `token_type` | 1 (Token-2022) | Enables transfer hook support |
| `compounding_fee_bps` | 1250 | 12.5% of post-grad fees auto-reinvest into liquidity |
| `partner_permanent_locked_liquidity_percentage` | 100 | All protocol liquidity is permanently locked |

### Step 8.4: Verify everything

```bash
npx ts-node scripts/admin/status.ts --rpc <RPC_URL>
# Should print:
#   ✅ IpworldState: initialized (authority=..., admin=...)
#   ✅ Operator: created (address=...)
#   ✅ Pool Config: created (address=..., fee_claimer=..., threshold=500 SOL)
#   ✅ Programs deployed: DBC=..., Hook=..., Splitter=...
```

---

## 9. Administrative Operations

These are operations you'll perform during normal operation of the platform.

### Quick Reference

| Script | When | Who | Per-token? |
|--------|------|-----|------------|
| `init-ipworld-state.ts` | Once after deploy | Admin | No (global) |
| `show-ipworld-state.ts` | Anytime | Anyone | No (global) |
| `status.ts` | Anytime | Anyone | No (global) |
| `create-operator.ts` | Once after deploy | Admin | No (global) |
| `update-authority.ts` | Key rotation | Admin | No (global) |
| `update-admin.ts` | Transfer admin | Admin | No (global) |
| `init-fee-config.ts` | On graduation | Backend (auto) | **Yes** — `--mint` |
| `distribute.ts` | Biweekly / anytime | Anyone | **Yes** — `--mint` |
| `update-owner.ts` | Owner verified | Authority | **Yes** — `--mint` |

> All scripts: `npx ts-node scripts/admin/<script>.ts --rpc <URL> [args]`

### 9.1: Launch a New Token (Backend)

**When:** User requests to create a new IP token.

**Who:** Backend (needs authority private key to sign LaunchAuth).

**Flow:**
1. Backend generates `LaunchAuth { creator, config, pool_pda }` message
2. Backend signs it with the authority private key (Ed25519)
3. Frontend/backend constructs a transaction:
   - Instruction 0: `Ed25519Program.createInstructionWithPublicKey(...)` (verify signature)
   - Instruction 1: `initializeVirtualPoolWithToken2022(...)` (create pool)
4. User (or backend) sends the transaction

```typescript
// Backend pseudocode
const launchAuth = Buffer.concat([
  creatorPubkey.toBuffer(),     // 32 bytes
  configPubkey.toBuffer(),      // 32 bytes
  poolPdaPubkey.toBuffer(),     // 32 bytes
]);
const signature = ed25519Sign(launchAuth, authorityPrivateKey);
// Return { signature, message: launchAuth, authorityPubkey } to frontend
```

### 9.2: Authorize a Trade (Backend)

**When:** User wants to swap on a bonding curve.

**Who:** Backend (needs authority private key).

**Flow:**
1. User calls `POST /auth/trade { wallet }` on your API
2. Backend creates `TradeAuth { user: wallet, expires_at: now + 1 hour }`
3. Backend signs with authority key, returns to frontend
4. Frontend caches for 1 hour
5. Frontend prepends Ed25519 verify ix to every swap transaction

```typescript
// Backend pseudocode
const tradeAuth = Buffer.alloc(40);
userPubkey.toBuffer().copy(tradeAuth, 0);     // 32 bytes
tradeAuth.writeBigInt64LE(BigInt(expiresAt), 32); // 8 bytes
const signature = ed25519Sign(tradeAuth, authorityPrivateKey);
// Return { signature, message: tradeAuth, authorityPubkey, expiresAt }
```

### 9.3: Initialize Fee Splitter for a Token (Backend — automatic on graduation)

**When:** A token graduates to DAMM v2. Your backend should call this automatically when it detects a graduation event on-chain. The script below is for manual/fallback use.

**Who:** Backend (automatic) or admin (manual).

**Keys needed:** Deployer wallet (payer), authority public key.

**Per-token:** Yes — each token gets its own fee config + vault PDA. You specify `--mint` for which token.

```bash
# Example: init fee config for token mint "AbC123..."
npx ts-node scripts/admin/init-fee-config.ts \
  --rpc https://api.devnet.solana.com \
  --mint AbC123xyzTokenMintAddress111111111111111111 \
  --authority $(solana-keygen pubkey keys/devnet/authority-keypair.json) \
  --treasury $(solana-keygen pubkey keys/devnet/treasury-keypair.json) \
  --community $(solana-keygen pubkey keys/devnet/community-keypair.json) \
  --treasury-bps 5714 \
  --community-bps 3429 \
  --owner-bps 857

# BPS breakdown (of claimable amount after 12.5% DAMM v2 compounding):
#   5714 bps = 57.14% → treasury  (= 50% of total fees)
#   3429 bps = 34.29% → community (= 30% of total → holder + UGC airdrops)
#    857 bps =  8.57% → owner     (= 7.5% of total → IP creator)
#   Must sum to 10000
```

### 9.4: Distribute Fees (Permissionless)

**When:** Anytime there are fees in a splitter vault. Can be called by anyone — a cron job, a user, a bot.

**Who:** ANYONE. No special keys needed — just a funded wallet to pay the tx fee (~0.000005 SOL).

**Per-token:** Yes — specify which token's vault to distribute from.

```bash
# Example: distribute fees for token "AbC123..."
npx ts-node scripts/admin/distribute.ts \
  --rpc https://api.devnet.solana.com \
  --mint AbC123xyzTokenMintAddress111111111111111111

# Output:
#   Vault: 8xK...vault (1,000,000 tokens)
#   Treasury:  571,400 tokens → 7xK...treasury
#   Community: 342,900 tokens → 9xL...community
#   Owner:      85,700 tokens → 3mN...owner
```

In production, your backend runs this on a schedule (e.g., biweekly) for all graduated tokens.

### 9.5: Update IP Owner Address

**When:** An IP owner has been verified by your team and should start receiving their 7.5% fee share.

**Who:** Authority signer only.

**Keys needed:** Authority private key (signer), payer wallet.

**Per-token:** Yes — each token has its own owner. Specify `--mint` for which token.

**What happens:**
1. All accumulated fees in the vault are distributed first (treasury/community/owner shares)
2. The owner's share from this flush goes to the NEW owner's token account
3. The owner address is updated on-chain
4. All future `distribute()` calls send owner share to the new address
5. If the new owner doesn't have a token account, the script creates one

```bash
# Example: set owner of token "AbC123..." to wallet "OwnerWa11et..."
npx ts-node scripts/admin/update-owner.ts \
  --rpc https://api.devnet.solana.com \
  --mint AbC123xyzTokenMintAddress111111111111111111 \
  --new-owner OwnerWa11etAddress1111111111111111111111 \
  --authority keys/devnet/authority-keypair.json

# Output:
#   Old owner:  community wallet (default before verification)
#   New owner:  OwnerWa11etAddress...
#   Vault flushed: 50,000 tokens distributed (owner share → new owner)
```

> Before the owner is verified, their 7.5% share goes to the community wallet (same as holder+UGC pool). Once verified, it routes directly to their personal wallet.

### 9.6: Claim Fees from DAMM v2 (Backend Cron)

**When:** Periodically (e.g., biweekly). Fees accumulate on the LP position NFT in DAMM v2.

**Who:** Backend (needs the wallet that holds the LP position NFT).

**Flow:**
1. Call DAMM v2 `claim_position_fee` for the LP position
2. Transfer claimed tokens to the splitter vault PDA
3. Call `distribute` on the splitter

```bash
npx ts-node scripts/admin/claim-and-distribute.ts \
  --rpc <RPC_URL> \
  --mint <TOKEN_MINT_ADDRESS> \
  --position <LP_POSITION_NFT_ADDRESS>
```

### 9.7: Batch Airdrop (Holders + UGC)

**When:** After distributing fees, the community wallet holds tokens earmarked for holders and UGC creators.

**Who:** Backend (needs community wallet private key).

**Flow:**
1. Query holder snapshot from your DB (who held how much, for how long)
2. Calculate each holder's share of the 15% holder allocation
3. Calculate each UGC creator's share of the 15% UGC allocation
4. Batch-transfer from community wallet to each recipient

```bash
npx ts-node scripts/admin/batch-airdrop.ts \
  --rpc <RPC_URL> \
  --mint <TOKEN_MINT_ADDRESS> \
  --type holders \
  --snapshot-file /path/to/holder-snapshot.json \
  --community-keypair keys/devnet/community-keypair.json
```

> Solana supports ~20-30 transfers per transaction. For large holder bases, the script batches automatically.

### 9.8: Update Authority (Key Rotation)

**When:** Rotating the authority key (security best practice — do periodically, or if compromised).

**Who:** Current admin of IpworldState.

**Keys needed:** Admin wallet (set in `solana config`). Only needs the NEW authority's **public** key (not private).

**What changes:** The authority public key stored in IpworldState. After this, all LaunchAuth and TradeAuth must be signed by the new authority key.

```bash
# Example: rotate to a new authority key
solana-keygen new --no-bip39-passphrase -o keys/devnet/authority-v2-keypair.json
npx ts-node scripts/admin/update-authority.ts \
  --rpc https://api.devnet.solana.com \
  --new-authority $(solana-keygen pubkey keys/devnet/authority-v2-keypair.json)

# Output:
#   Old authority: 7xK...oldAuthority
#   New authority: 9mN...newAuthority
#
# ⚠️  Update your backend to use the new authority key immediately!
#     Old key can NO LONGER sign LaunchAuth/TradeAuth.
```

### 9.9: Update Admin (Transfer Admin Rights)

**When:** Transferring platform admin to a new wallet (e.g., moving to multisig for governance).

**Who:** Current admin only.

**Keys needed:** Current admin wallet (set in `solana config`).

**⚠️ IRREVERSIBLE** — once transferred, only the new admin can update authority/admin.

```bash
# Example: transfer admin to a Squads multisig
npx ts-node scripts/admin/update-admin.ts \
  --rpc https://api.devnet.solana.com \
  --new-admin SquadsMultisigVaultAddress1111111111111111

# Output:
#   Old admin: 7xK...deployer
#   New admin: SquadsMultisigVaultAddress...
#   ⚠️  You can no longer update authority/admin. Only the new admin can.
```

---

## 10. Meteora Revenue Share

Meteora requires a **20% protocol fee** on all DBC trading activity. This is **hardcoded** in the DBC source code:

```rust
// programs/dynamic-bonding-curve/src/constants.rs
pub const PROTOCOL_FEE_PERCENT: u8 = 20; // 20% — DO NOT CHANGE
```

**How it works:**
- On every swap, 20% of the trading fee goes to Meteora's protocol fee account
- The remaining 80% goes to `fee_claimer` (your treasury)
- Meteora collects their fee through their own claim mechanism
- You do NOT need to send anything to Meteora manually — it happens automatically on-chain

**Your obligation:**
- Do NOT modify `PROTOCOL_FEE_PERCENT` — this is part of the fork license agreement
- This only applies pre-graduation (on the bonding curve)
- Post-graduation on DAMM v2, Meteora has their own fee structure on that program

---

## 11. Program Upgrades & Security

### Upgrade a program

```bash
# Build the updated program
./scripts/set-program-ids.sh devnet  # or mainnet
cargo build-sbf

# Deploy the upgrade
solana program deploy target/deploy/ipworld_splitter.so \
  --program-id keys/devnet/ipworld_splitter-keypair.json \
  --url devnet
```

> Only the original deployer (upgrade authority) can upgrade. If you've transferred authority, the new authority must sign.

### Transfer upgrade authority to multisig

```bash
# Recommended for mainnet after stabilization
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority <SQUADS_MULTISIG_VAULT> \
  --url mainnet-beta
```

### Make a program immutable (IRREVERSIBLE)

```bash
# Do this ONLY after audit + extended stability period
# This means NO ONE can ever upgrade the program again
solana program set-upgrade-authority <PROGRAM_ID> \
  --final \
  --url mainnet-beta
```

### Audit options (~968 lines of custom Rust)

| Option | Cost | Timeline | Notes |
|--------|------|----------|-------|
| Tier 1 (Ottersec, Neodyme) | $30-60K | 2-4 weeks | Gold standard, recognized by VCs/exchanges |
| Tier 2 (Sec3, Mad Shield, Halborn) | $15-35K | 1-3 weeks | Solid, well-known |
| Audit competition (Sherlock, Code4rena) | $10-20K | 1-2 weeks | Multiple reviewers, crowdsourced |
| Solo auditor (Immunefi network) | $5-15K | 1-2 weeks | Good for small scope like ours |
| Peer review + bug bounty | $2-5K bounty pool | Ongoing | Cheapest, less formal |

Recommendation: Start with a solo auditor or Tier 2 firm ($10-20K). Add a bug bounty on Immunefi for ongoing coverage.

### Security checklist

- [ ] Program keypairs backed up and stored securely
- [ ] Authority keypair in KMS/Vault (not on disk) for mainnet
- [ ] Treasury is a multisig (Squads Protocol recommended)
- [ ] Community wallet private key only on backend server (not in git)
- [ ] Program upgrade authority transferred to multisig on mainnet
- [ ] All `.env` files with addresses are NOT in git
- [ ] Deployer wallet drained after deployment (remove leftover SOL)

---

## 12. Testing

### Run all tests locally

```bash
# ─── LiteSVM tests (fast, no validator needed) ───
cargo build-sbf -- --features local,skip-launch-auth,skip-trade-auth
npx ts-mocha -t 120000 tests/create_pool_with_token2022.tests.ts  # 9 tests
npx ts-mocha -t 120000 tests/graduation_hook_removal.tests.ts      # 8 tests

# ─── Validator tests (auth enforcement) ───
# Trade auth test
cargo build-sbf -- --features local,skip-launch-auth
solana-test-validator \
  --bpf-program <DBC_ID> target/deploy/dynamic_bonding_curve.so \
  --bpf-program <HOOK_ID> target/deploy/ipworld_hook.so \
  --reset &
sleep 8
npx ts-mocha -t 120000 tests/trade_auth.tests.ts               # 3 tests
pkill solana-test-validator

# Launch auth test
cargo build-sbf -- --features local
solana-test-validator \
  --bpf-program <DBC_ID> target/deploy/dynamic_bonding_curve.so \
  --bpf-program <HOOK_ID> target/deploy/ipworld_hook.so \
  --reset &
sleep 8
npx ts-mocha -t 120000 tests/launch_auth.tests.ts              # 3 tests
pkill solana-test-validator

# Splitter test
(cd programs/ipworld-splitter && cargo build-sbf)
solana-test-validator \
  --bpf-program <SPLITTER_ID> target/deploy/ipworld_splitter.so \
  --reset &
sleep 8
npx ts-mocha -t 120000 tests/splitter.tests.ts                 # 6 tests
pkill solana-test-validator

# Hook standalone tests
solana-test-validator \
  --bpf-program <HOOK_ID> target/deploy/ipworld_hook.so \
  --reset &
sleep 8
npx ts-mocha -t 120000 tests/ipworld_hook_validator.tests.ts   # 7 tests
npx ts-mocha -t 120000 tests/ipworld_state.tests.ts            # 5 tests
pkill solana-test-validator
```

**Total: 41 tests across 7 test files.**

---

## 13. Architecture Summary

```
┌───────────────────────────────────────────────────────────────────┐
│                        PRE-GRADUATION                             │
│                                                                   │
│  Backend signs LaunchAuth ─→ User sends tx ─→ DBC creates pool   │
│    - Token-2022 mint with transfer hook attached                  │
│    - Hook config: pool vault, 5% ownership cap                   │
│                                                                   │
│  Backend signs TradeAuth ──→ User sends tx ─→ DBC swap           │
│    - Hook enforces: transfers only through pool vault             │
│    - Hook enforces: no wallet > 5% of supply                     │
│    - Fees: 20% Meteora (hardcoded) │ 80% treasury (fee_claimer)  │
│                                                                   │
├───────────────────────────────────────────────────────────────────┤
│                        GRADUATION                                 │
│                                                                   │
│  Curve fills to threshold ─→ Anyone cranks migration              │
│    - Hook program_id nulled (TransferHook update → None)          │
│    - Hook authority nulled (SetAuthority → None)                  │
│    - DAMM v2 pool created with token badge                        │
│    - Backend calls init_fee_config on splitter                    │
│                                                                   │
├───────────────────────────────────────────────────────────────────┤
│                        POST-GRADUATION                            │
│                                                                   │
│  Trades on DAMM v2 (permissionless, no hook, no auth)            │
│    - 12.5% auto-compounds into liquidity (DAMM v2 native)        │
│                                                                   │
│  Fee claim cycle (biweekly):                                      │
│    1. Backend claims LP fees from DAMM v2 position                │
│    2. Backend deposits claimed tokens to splitter vault PDA       │
│    3. Anyone calls distribute() ─→ split to:                      │
│       • Treasury:  57.14% (= 50% of total)                       │
│       • Community: 34.29% (= 30% of total → holder + UGC)        │
│       • Owner:      8.57% (= 7.5% of total)                      │
│    4. Backend batch-transfers from community → individual holders  │
│    5. Backend batch-transfers from community → UGC creators        │
│                                                                   │
│  Owner verification:                                              │
│    Backend calls update_owner() → flushes + sets new owner        │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### Key addresses per deployment

| Address | Source | Used by |
|---------|--------|---------|
| DBC Program ID | `keys/<net>/dynamic_bonding_curve-keypair.json` | Frontend, backend |
| Hook Program ID | `keys/<net>/ipworld_hook-keypair.json` | DBC (cross-reference) |
| Splitter Program ID | `keys/<net>/ipworld_splitter-keypair.json` | Backend |
| Authority Pubkey | `keys/<net>/authority-keypair.json` | Stored in IpworldState PDA |
| Treasury Wallet | Multisig or generated | Splitter config, DBC config (fee_claimer) |
| Community Wallet | Generated, backend holds key | Splitter config |
| IpworldState PDA | Derived: `seeds=["ipworld_state"]` | DBC (auth verification) |
| Fee Config PDA | Derived: `seeds=["fee_config", mint]` | Splitter |
| Vault PDA | Derived: `seeds=["vault", mint]` | Splitter |

---

## 14. Checklist

### Before first deployment

- [ ] All keypairs generated (`keys/devnet/` and `keys/mainnet/`)
- [ ] Keypairs backed up securely (encrypted, off-machine)
- [ ] Treasury wallet created (multisig for mainnet)
- [ ] Community wallet created (backend needs private key)
- [ ] `addresses.devnet.env` filled in with all pubkeys
- [ ] `addresses.mainnet.env` filled in with all pubkeys
- [ ] Deployer wallet funded (~15 SOL devnet, ~20 SOL mainnet)
- [ ] Audit completed (for mainnet)

### After deployment

- [ ] IpworldState initialized (Section 8.1)
- [ ] Operator created (Section 8.2)
- [ ] Pool config created (Section 8.3)
- [ ] Verification: `scripts/admin/status.ts` shows all green
- [ ] Backend configured with: RPC URL, authority key path, program IDs, wallet addresses
- [ ] Frontend configured with: RPC URL, program IDs
- [ ] Test: create a pool on devnet end-to-end
- [ ] Test: swap on devnet
- [ ] Test: graduate a pool on devnet
- [ ] Test: distribute fees on devnet
- [ ] Test: update owner on devnet

### Before mainnet launch

- [ ] All devnet tests passing
- [ ] Audit report clean (no critical/high findings)
- [ ] Program upgrade authority transferred to multisig
- [ ] Authority keypair moved to KMS/Vault
- [ ] Monitoring set up (program logs, balance alerts)
- [ ] Runbook for incident response (key rotation, pause trading via authority rotation)
