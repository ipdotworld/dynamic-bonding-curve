#!/usr/bin/env bash
set -euo pipefail

# ─── Swap program IDs in source code for target network ──────────────────────
#
# Usage:
#   ./scripts/set-program-ids.sh devnet     # Set devnet program IDs
#   ./scripts/set-program-ids.sh mainnet    # Set mainnet program IDs
#   ./scripts/set-program-ids.sh local      # Restore local test IDs
#
# This updates declare_id!() in each program and cross-references
# (e.g., hook program ID used inside DBC).
# Run BEFORE building. Changes are NOT committed — they're build-time only.

NETWORK="${1:-local}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# ─── Local test IDs (defaults in source) ─────────────────────────────────────
LOCAL_DBC="dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
LOCAL_HOOK="HooK1111111111111111111111111111111111111111"
LOCAL_SPLITTER="3DuLUcRJpiSubGnDtE7LLaJVdKxUSoUqKFHHmT6KBSqC"

# ─── Read target IDs from env file ───────────────────────────────────────────
if [ "$NETWORK" = "local" ]; then
    TARGET_DBC="$LOCAL_DBC"
    TARGET_HOOK="$LOCAL_HOOK"
    TARGET_SPLITTER="$LOCAL_SPLITTER"
else
    ENV_FILE="$SCRIPT_DIR/addresses.${NETWORK}.env"
    if [ ! -f "$ENV_FILE" ]; then
        echo "❌ Env file not found: $ENV_FILE"
        exit 1
    fi
    TARGET_DBC="$(grep '^DBC_PROGRAM_ID=' "$ENV_FILE" | cut -d= -f2)"
    TARGET_HOOK="$(grep '^HOOK_PROGRAM_ID=' "$ENV_FILE" | cut -d= -f2)"
    TARGET_SPLITTER="$(grep '^SPLITTER_PROGRAM_ID=' "$ENV_FILE" | cut -d= -f2)"
fi

echo "Setting program IDs for: $NETWORK"
echo "  DBC:      $TARGET_DBC"
echo "  Hook:     $TARGET_HOOK"
echo "  Splitter: $TARGET_SPLITTER"
echo ""

# ─── Helper: find current ID in a file and replace ───────────────────────────
swap_id() {
    local file="$1"
    local old_id="$2"
    local new_id="$3"
    local label="$4"

    if [ "$old_id" = "$new_id" ]; then
        echo "  ⏭  $label: already set ($file)"
        return
    fi

    if grep -q "$old_id" "$file" 2>/dev/null; then
        sed -i '' "s|$old_id|$new_id|g" "$file"
        echo "  ✅ $label: $old_id → $new_id ($file)"
    elif grep -q "$new_id" "$file" 2>/dev/null; then
        echo "  ⏭  $label: already set ($file)"
    else
        echo "  ⚠️  $label: ID not found in $file — may need manual update"
    fi
}

# ─── DBC program ID ─────────────────────────────────────────────────────────
# Used in: DBC declare_id, Anchor.toml, test files
DBC_LIB="$ROOT_DIR/programs/dynamic-bonding-curve/src/lib.rs"

# First figure out what's currently in source
CURRENT_DBC=$(grep 'declare_id!' "$DBC_LIB" | head -1 | sed 's/.*"\(.*\)".*/\1/')
swap_id "$DBC_LIB" "$CURRENT_DBC" "$TARGET_DBC" "DBC declare_id"

# Anchor.toml
swap_id "$ROOT_DIR/Anchor.toml" "$CURRENT_DBC" "$TARGET_DBC" "DBC Anchor.toml"

# ─── Hook program ID ────────────────────────────────────────────────────────
HOOK_LIB="$ROOT_DIR/programs/ipworld-hook/src/lib.rs"
CURRENT_HOOK=$(grep 'declare_id!' "$HOOK_LIB" | head -1 | sed 's/.*"\(.*\)".*/\1/')
swap_id "$HOOK_LIB" "$CURRENT_HOOK" "$TARGET_HOOK" "Hook declare_id"
swap_id "$ROOT_DIR/Anchor.toml" "$CURRENT_HOOK" "$TARGET_HOOK" "Hook Anchor.toml"

# Hook ID is also referenced inside DBC (as a static Pubkey constant)
DBC_HOOK_REF="$ROOT_DIR/programs/dynamic-bonding-curve/src/instructions/initialize_pool/ix_initialize_virtual_pool_with_token2022.rs"
swap_id "$DBC_HOOK_REF" "$CURRENT_HOOK" "$TARGET_HOOK" "Hook ref in DBC"

# And in test files
for testfile in "$ROOT_DIR"/tests/*.ts; do
    if grep -q "$CURRENT_HOOK" "$testfile" 2>/dev/null; then
        swap_id "$testfile" "$CURRENT_HOOK" "$TARGET_HOOK" "Hook in $(basename "$testfile")"
    fi
done

# ─── Splitter program ID ────────────────────────────────────────────────────
SPLITTER_LIB="$ROOT_DIR/programs/ipworld-splitter/src/lib.rs"
CURRENT_SPLITTER=$(grep 'declare_id!' "$SPLITTER_LIB" | head -1 | sed 's/.*"\(.*\)".*/\1/')
swap_id "$SPLITTER_LIB" "$CURRENT_SPLITTER" "$TARGET_SPLITTER" "Splitter declare_id"
swap_id "$ROOT_DIR/Anchor.toml" "$CURRENT_SPLITTER" "$TARGET_SPLITTER" "Splitter Anchor.toml"

# Test files
for testfile in "$ROOT_DIR"/tests/*.ts; do
    if grep -q "$CURRENT_SPLITTER" "$testfile" 2>/dev/null; then
        swap_id "$testfile" "$CURRENT_SPLITTER" "$TARGET_SPLITTER" "Splitter in $(basename "$testfile")"
    fi
done

echo ""
echo "✅ Done. Now run: cargo build-sbf && ./scripts/deploy-programs.sh $NETWORK"
echo ""
echo "To restore local IDs: ./scripts/set-program-ids.sh local"
