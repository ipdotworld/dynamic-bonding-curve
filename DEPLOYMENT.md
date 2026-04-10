# Deployment Guide — ipworld Solana Programs

## Programs

| Program | Description | Local Test ID |
|---------|-------------|---------------|
| `dynamic_bonding_curve` | Forked Meteora DBC with hook + auth | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| `ipworld_hook` | Transfer hook (ownership cap) | `HooK1111111111111111111111111111111111111111` |
| `ipworld_splitter` | Fee distribution (3-way split) | `3DuLUcRJpiSubGnDtE7LLaJVdKxUSoUqKFHHmT6KBSqC` |

## Prerequisites

```bash
# Solana CLI
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# Anchor CLI (0.31.x)
cargo install --git https://github.com/coral-xyz/anchor avm --locked
avm install 0.31.0 && avm use 0.31.0

# Node.js 18+ (for tests)
```

## Keypair Management

### Understanding Program Keypairs

Every Solana program has a **program ID** = the public key of a keypair. The private key is needed ONLY for deployment/upgrades. After deployment, the private key controls who can upgrade the program.

### Generate Keypairs (first time only)

```bash
# Devnet
mkdir -p keys/devnet
solana-keygen new --no-bip39-passphrase -o keys/devnet/dynamic_bonding_curve-keypair.json
solana-keygen new --no-bip39-passphrase -o keys/devnet/ipworld_hook-keypair.json
solana-keygen new --no-bip39-passphrase -o keys/devnet/ipworld_splitter-keypair.json
solana-keygen new --no-bip39-passphrase -o keys/devnet/authority-keypair.json

# Mainnet (DIFFERENT keypairs — never reuse devnet keys on mainnet)
mkdir -p keys/mainnet
solana-keygen new --no-bip39-passphrase -o keys/mainnet/dynamic_bonding_curve-keypair.json
solana-keygen new --no-bip39-passphrase -o keys/mainnet/ipworld_hook-keypair.json
solana-keygen new --no-bip39-passphrase -o keys/mainnet/ipworld_splitter-keypair.json
solana-keygen new --no-bip39-passphrase -o keys/mainnet/authority-keypair.json
```

### View public keys

```bash
solana-keygen pubkey keys/devnet/dynamic_bonding_curve-keypair.json
solana-keygen pubkey keys/devnet/ipworld_hook-keypair.json
solana-keygen pubkey keys/devnet/ipworld_splitter-keypair.json
solana-keygen pubkey keys/devnet/authority-keypair.json
```

### Update env files

Copy the public keys into `scripts/addresses.devnet.env` and `scripts/addresses.mainnet.env`.

### ⚠️ Security

- **Program keypairs**: Control who can upgrade your programs. Store securely. After final deployment, consider transferring upgrade authority to a multisig or revoking it entirely.
- **Authority keypair**: Signs LaunchAuth + TradeAuth + update_owner. This is your backend's hot key. In production, use AWS KMS / HashiCorp Vault / similar — NOT a file on disk.
- **NEVER commit keypair JSON files to git** (they're in .gitignore).
- **NEVER reuse keypairs across devnet/mainnet.**

## Deploy to Devnet

```bash
# 1. Set your Solana CLI to devnet
solana config set --url devnet

# 2. Create/fund a deployer wallet
solana-keygen new -o ~/.config/solana/deployer.json  # or use existing
solana config set --keypair ~/.config/solana/deployer.json
solana airdrop 5  # repeat as needed, ~15 SOL total for 3 programs

# 3. Swap program IDs in source to devnet addresses
./scripts/set-program-ids.sh devnet

# 4. Deploy
./scripts/deploy-programs.sh devnet

# 5. Restore local IDs (for continued development)
./scripts/set-program-ids.sh local
```

## Deploy to Mainnet

```bash
# 1. Set your Solana CLI to mainnet
solana config set --url https://api.mainnet-beta.solana.com

# 2. Use a funded deployer wallet (~20 SOL needed)
solana config set --keypair /path/to/funded-deployer.json
solana balance  # verify

# 3. Swap program IDs to mainnet addresses
./scripts/set-program-ids.sh mainnet

# 4. Deploy (will prompt for confirmation)
./scripts/deploy-programs.sh mainnet

# 5. Restore local IDs
./scripts/set-program-ids.sh local
```

## Post-Deployment Initialization

After programs are deployed, you need to set up on-chain state:

### 1. Initialize IpworldState PDA

This creates the global config that stores the authority public key (used to verify LaunchAuth/TradeAuth signatures).

```bash
# Using the test script pattern:
npx ts-node scripts/init-ipworld-state.ts \
  --rpc https://api.devnet.solana.com \
  --authority $(solana-keygen pubkey keys/devnet/authority-keypair.json)
```

Or via CLI (the admin who calls this = whoever's wallet is active in `solana config`):

### 2. Create Operator Account

Grants admin permissions (required for creating pool configs).

### 3. Create Pool Config

Sets fee parameters, migration threshold, curve shape.

Key parameters:
- `fee_claimer`: Your treasury wallet (receives 80% of pre-graduation fees)
- `creator_trading_fee_percentage`: 0 (owner not known at launch)
- `migration_quote_threshold`: SOL amount to trigger graduation (e.g., 500 SOL)
- `migration_option`: 1 (DAMM v2)
- `token_type`: 1 (Token-2022)
- `compounding_fee_bps`: 1250 (12.5% auto-compound post-graduation)

### 4. Init Fee Config (per token, on graduation)

Backend calls `init_fee_config` on the splitter program when a token graduates:

```
treasury_bps: 5714   (57.14% of claimable = 50% of total)
community_bps: 3429  (34.29% = 30% of total)
owner_bps: 857       (8.57% = 7.5% of total)
```

## Program Upgrades

```bash
# Upgrade a specific program (e.g., after bug fix)
solana program deploy target/deploy/ipworld_splitter.so \
  --program-id keys/devnet/ipworld_splitter-keypair.json \
  --url devnet

# Transfer upgrade authority to multisig (recommended for mainnet)
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority <MULTISIG_ADDRESS> \
  --url mainnet-beta

# Make program immutable (IRREVERSIBLE — do this after audit + stability)
solana program set-upgrade-authority <PROGRAM_ID> \
  --final \
  --url mainnet-beta
```

## Testing

```bash
# Local tests (all features disabled for LiteSVM)
cargo build-sbf -- --features local,skip-launch-auth,skip-trade-auth
npx ts-mocha -t 120000 tests/create_pool_with_token2022.tests.ts  # 9 tests
npx ts-mocha -t 120000 tests/graduation_hook_removal.tests.ts      # 8 tests

# Validator tests (auth enforcement ON)
cargo build-sbf -- --features local,skip-launch-auth  # trade auth ON
solana-test-validator \
  --bpf-program <DBC_ID> target/deploy/dynamic_bonding_curve.so \
  --bpf-program <HOOK_ID> target/deploy/ipworld_hook.so \
  --reset
npx ts-mocha -t 120000 tests/trade_auth.tests.ts      # 3 tests

cargo build-sbf -- --features local                    # both auth ON
# restart validator...
npx ts-mocha -t 120000 tests/launch_auth.tests.ts     # 3 tests

# Splitter tests
cd programs/ipworld-splitter && cargo build-sbf && cd ../..
solana-test-validator \
  --bpf-program <SPLITTER_ID> target/deploy/ipworld_splitter.so \
  --reset
npx ts-mocha -t 120000 tests/splitter.tests.ts         # 6 tests

# Hook standalone tests
solana-test-validator \
  --bpf-program <HOOK_ID> target/deploy/ipworld_hook.so \
  --reset
npx ts-mocha -t 120000 tests/ipworld_hook_validator.tests.ts  # 7 tests
npx ts-mocha -t 120000 tests/ipworld_state.tests.ts           # 5 tests
```

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────┐
│                    PRE-GRADUATION                            │
│                                                              │
│  User ──LaunchAuth──→ DBC (creates Token-2022 + hook)       │
│  User ──TradeAuth───→ DBC (swap on bonding curve)           │
│  Hook enforces: 5% ownership cap, vault-only transfers       │
│  Fees: 20% Meteora │ 80% → fee_claimer (treasury)           │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                    GRADUATION                                │
│                                                              │
│  Anyone cranks migration → hook nulled → DAMM v2 pool       │
│  Backend calls init_fee_config on splitter                   │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                    POST-GRADUATION                           │
│                                                              │
│  Trades on DAMM v2 (permissionless, no hook)                │
│  12.5% auto-compounds (DAMM v2 native)                      │
│  Backend claims LP fees → deposits to splitter vault         │
│  Anyone calls distribute() → treasury/community/owner        │
│  Backend batch-transfers from community → holders + UGC      │
│  update_owner() flushes + sets verified owner                │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```
