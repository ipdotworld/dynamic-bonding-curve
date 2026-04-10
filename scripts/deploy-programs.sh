#!/usr/bin/env bash
set -euo pipefail

# ─── ipworld Solana Program Deployment ───────────────────────────────────────
#
# Usage:
#   ./scripts/deploy.sh devnet    # Deploy to devnet
#   ./scripts/deploy.sh mainnet   # Deploy to mainnet-beta (requires confirmation)
#
# Prerequisites:
#   - solana CLI installed
#   - Anchor CLI installed
#   - Keypairs in keys/<network>/
#   - Deployer wallet funded with SOL
#
# Programs:
#   1. dynamic_bonding_curve (DBC fork)
#   2. ipworld_hook (transfer hook)
#   3. ipworld_splitter (fee distribution)

NETWORK="${1:-devnet}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
KEYS_DIR="$ROOT_DIR/keys/$NETWORK"

# ─── Config ──────────────────────────────────────────────────────────────────

if [ "$NETWORK" = "mainnet" ]; then
    RPC_URL="https://api.mainnet-beta.solana.com"
    echo "⚠️  MAINNET DEPLOYMENT"
    echo "This will deploy to Solana mainnet-beta. Programs are IMMUTABLE once deployed."
    read -p "Type 'DEPLOY' to confirm: " confirm
    if [ "$confirm" != "DEPLOY" ]; then
        echo "Aborted."
        exit 1
    fi
elif [ "$NETWORK" = "devnet" ]; then
    RPC_URL="https://api.devnet.solana.com"
else
    echo "Usage: $0 [devnet|mainnet]"
    exit 1
fi

echo "═══════════════════════════════════════════════════════"
echo "  Deploying to: $NETWORK ($RPC_URL)"
echo "  Keys dir: $KEYS_DIR"
echo "═══════════════════════════════════════════════════════"

# ─── Check prerequisites ─────────────────────────────────────────────────────

if [ ! -d "$KEYS_DIR" ]; then
    echo "❌ Keys directory not found: $KEYS_DIR"
    echo "   Run: mkdir -p $KEYS_DIR && solana-keygen new -o $KEYS_DIR/<program>-keypair.json"
    exit 1
fi

for prog in dynamic_bonding_curve ipworld_hook ipworld_splitter; do
    if [ ! -f "$KEYS_DIR/${prog}-keypair.json" ]; then
        echo "❌ Missing keypair: $KEYS_DIR/${prog}-keypair.json"
        exit 1
    fi
done

# Show program addresses
echo ""
echo "Program addresses for $NETWORK:"
for prog in dynamic_bonding_curve ipworld_hook ipworld_splitter; do
    ADDR=$(solana-keygen pubkey "$KEYS_DIR/${prog}-keypair.json")
    echo "  $prog: $ADDR"
done
echo ""

# ─── Build ───────────────────────────────────────────────────────────────────

echo "🔨 Building programs..."
cd "$ROOT_DIR"

# DBC — no skip flags for production!
echo "  Building dynamic_bonding_curve..."
cargo build-sbf -- --features "" 2>&1 | tail -1

echo "  Building ipworld_hook..."
(cd programs/ipworld-hook && cargo build-sbf 2>&1 | tail -1)

echo "  Building ipworld_splitter..."
(cd programs/ipworld-splitter && cargo build-sbf 2>&1 | tail -1)

echo "✅ All programs built"
echo ""

# ─── Deploy ──────────────────────────────────────────────────────────────────

DEPLOYER_WALLET="$(solana config get keypair | awk '{print $3}')"
DEPLOYER_ADDR="$(solana-keygen pubkey "$DEPLOYER_WALLET")"
BALANCE="$(solana balance "$DEPLOYER_ADDR" --url "$RPC_URL" 2>/dev/null || echo "0 SOL")"

echo "Deployer: $DEPLOYER_ADDR"
echo "Balance: $BALANCE"
echo ""

deploy_program() {
    local name="$1"
    local so_path="$2"
    local keypair_path="$3"
    local addr
    addr="$(solana-keygen pubkey "$keypair_path")"

    echo "📦 Deploying $name → $addr"

    # Check if already deployed
    if solana program show "$addr" --url "$RPC_URL" &>/dev/null; then
        echo "  ⚡ Program exists — upgrading..."
        solana program deploy "$so_path" \
            --program-id "$keypair_path" \
            --url "$RPC_URL" \
            --with-compute-unit-price 50000
    else
        echo "  🆕 First deployment..."
        solana program deploy "$so_path" \
            --program-id "$keypair_path" \
            --url "$RPC_URL" \
            --with-compute-unit-price 50000
    fi

    echo "  ✅ $name deployed: $addr"
    echo ""
}

deploy_program "dynamic_bonding_curve" \
    "target/deploy/dynamic_bonding_curve.so" \
    "$KEYS_DIR/dynamic_bonding_curve-keypair.json"

deploy_program "ipworld_hook" \
    "target/deploy/ipworld_hook.so" \
    "$KEYS_DIR/ipworld_hook-keypair.json"

deploy_program "ipworld_splitter" \
    "target/deploy/ipworld_splitter.so" \
    "$KEYS_DIR/ipworld_splitter-keypair.json"

# ─── Summary ─────────────────────────────────────────────────────────────────

echo "═══════════════════════════════════════════════════════"
echo "  ✅ All programs deployed to $NETWORK!"
echo ""
echo "  Program IDs:"
for prog in dynamic_bonding_curve ipworld_hook ipworld_splitter; do
    ADDR=$(solana-keygen pubkey "$KEYS_DIR/${prog}-keypair.json")
    echo "    $prog: $ADDR"
done
echo ""
echo "  Next steps:"
echo "    1. Initialize IpworldState PDA (set authority pubkey)"
echo "    2. Create operator account"
echo "    3. Create pool config with correct fee params"
echo "    4. Fund deployer for splitter init_fee_config calls"
echo ""
echo "  Save these addresses in your backend .env!"
echo "═══════════════════════════════════════════════════════"
