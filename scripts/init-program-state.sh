#!/usr/bin/env bash
set -euo pipefail

# ─── Post-deployment initialization ──────────────────────────────────────────
#
# Run ONCE after deploying programs. Sets up:
#   1. IpworldState PDA (authority for LaunchAuth/TradeAuth signing)
#   2. Operator account (admin permissions)
#   3. Authority keypair generation (if not exists)
#
# Usage:
#   source scripts/addresses.devnet.env
#   ./scripts/init-program-state.sh devnet

NETWORK="${1:-devnet}"

if [ "$NETWORK" = "devnet" ]; then
    RPC_URL="https://api.devnet.solana.com"
elif [ "$NETWORK" = "mainnet" ]; then
    RPC_URL="https://api.mainnet-beta.solana.com"
    echo "⚠️  MAINNET — are you sure? (Ctrl+C to abort)"
    sleep 3
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
KEYS_DIR="$ROOT_DIR/keys/$NETWORK"

# Generate authority keypair if missing
AUTHORITY_KP="$KEYS_DIR/authority-keypair.json"
if [ ! -f "$AUTHORITY_KP" ]; then
    echo "🔑 Generating authority keypair..."
    solana-keygen new --no-bip39-passphrase -o "$AUTHORITY_KP"
    echo "   Authority: $(solana-keygen pubkey "$AUTHORITY_KP")"
    echo ""
    echo "   ⚠️  BACK THIS UP! This key signs LaunchAuth + TradeAuth."
    echo "   Store it securely (e.g., AWS KMS, Vault)."
    echo ""
fi

AUTHORITY_PUBKEY="$(solana-keygen pubkey "$AUTHORITY_KP")"
ADMIN_PUBKEY="$(solana address)"

echo "═══════════════════════════════════════════════════════"
echo "  Initializing program state on $NETWORK"
echo "  Admin (deployer): $ADMIN_PUBKEY"
echo "  Authority (signer): $AUTHORITY_PUBKEY"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Next steps (run manually or via your backend):"
echo ""
echo "  1. Init IpworldState PDA:"
echo "     npx ts-node scripts/init-ipworld-state.ts \\"
echo "       --rpc $RPC_URL \\"
echo "       --authority $AUTHORITY_PUBKEY"
echo ""
echo "  2. Create operator account (for config creation):"
echo "     npx ts-node scripts/create-operator.ts \\"
echo "       --rpc $RPC_URL"
echo ""
echo "  3. Create pool config template:"
echo "     npx ts-node scripts/create-config.ts \\"
echo "       --rpc $RPC_URL \\"
echo "       --fee-claimer <TREASURY_WALLET> \\"
echo "       --migration-threshold <SOL_AMOUNT>"
echo ""
echo "  4. Init fee config per token (done automatically by backend on graduation):"
echo "     npx ts-node scripts/init-fee-config.ts \\"
echo "       --rpc $RPC_URL \\"
echo "       --mint <TOKEN_MINT> \\"
echo "       --treasury <TREASURY_WALLET> \\"
echo "       --community <COMMUNITY_WALLET>"
echo ""
