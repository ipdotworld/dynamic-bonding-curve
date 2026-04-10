# ipworld DBC Fork — Developer Setup & Testing

This is ipworld's fork of Meteora's [Dynamic Bonding Curve (DBC)](https://github.com/nicedaicommunity/dynamic-bonding-curve), pinned at commit `b4f954733f0e88258f1eb3f0eff75e4314c9610c`.

## What's Added

- **`programs/ipworld-hook/`** — A Token-2022 Transfer Hook program that enforces:
  - **No P2P transfers** — tokens can only move through the bonding curve vault (no sniping/OTC)
  - **5% ownership cap** — no single wallet can hold more than 5% of supply
- **`tests/ipworld_hook_validator.tests.ts`** — Integration tests using `solana-test-validator`
- **`tests/ipworld_hook.tests.ts`** — Unit tests using LiteSVM (init-only; LiteSVM doesn't enforce hooks)

## Prerequisites

### 1. Rust + Solana Toolchain

```bash
# Rust (if not installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Solana CLI + BPF toolchain (v3.1.x)
sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.12/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Verify
solana --version        # solana-cli 3.1.12
cargo-build-sbf --version
```

### 2. Anchor CLI

```bash
# Install Anchor v0.31 (matches Cargo.toml)
cargo install --git https://github.com/coral-xyz/anchor --tag v0.31.0 anchor-cli
anchor --version        # anchor-cli 0.31.0
```

### 3. Node.js Dependencies

```bash
cd /path/to/dbc
npm install
```

## Building

### Build all programs (DBC + ipworld-hook)

```bash
anchor build
```

### Build only the hook program

```bash
cargo-build-sbf --manifest-path programs/ipworld-hook/Cargo.toml
# Output: target/deploy/ipworld_hook.so
```

### Build only DBC (no hook)

```bash
cargo-build-sbf --manifest-path programs/dynamic-bonding-curve/Cargo.toml
```

## Testing

### Step 1: ipworld-hook (Transfer Hook)

The hook tests require `solana-test-validator` because Token-2022 only enforces transfer hooks in a real runtime (LiteSVM v0.1.0's bundled Token-2022 binary is too old to execute hook CPIs).

```bash
# 1. Build the hook .so
cargo-build-sbf --manifest-path programs/ipworld-hook/Cargo.toml

# 2. Start the test validator with the hook program loaded
solana-test-validator \
  --reset \
  --bpf-program HooK1111111111111111111111111111111111111111 target/deploy/ipworld_hook.so \
  --quiet &

# 3. Wait for validator to be ready (~8 seconds)
sleep 8
curl -s http://127.0.0.1:8899 -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getVersion"}' | jq .

# 4. Run the tests
npx ts-mocha -p ./tsconfig.json -t 120000 tests/ipworld_hook_validator.tests.ts

# 5. Kill the validator when done
pkill -f solana-test-validator
```

**Expected output (7/7 passing):**
```
Step 1 — ipworld-hook (solana-test-validator)
    ✅ ExtraAccountMetaList PDA created
    ✔ initialize_extra_account_meta_list
    ✅ HookConfig PDA created, pool_vault correct
    ✔ initialize_hook_config
    ✅ Vault→buyer (1%) succeeded
    ✔ vault→buyer (1%) should PASS
    ✅ 6% transfer correctly rejected
    ✔ vault→whale (6%) should FAIL — exceeds 5% cap
    ✅ P2P transfer correctly rejected
    ✔ P2P transfer should FAIL — not through vault
    ✅ Vault→buyer (exactly 5%) succeeded
    ✔ vault→buyer exactly 5% should PASS — at boundary
    ✅ Sell back to vault succeeded
    ✔ sell back to vault should PASS

  7 passing
```

### Existing DBC tests (LiteSVM)

```bash
npx ts-mocha -p ./tsconfig.json -t 60000 tests/<test_file>.tests.ts
```

### Troubleshooting

- **Port 8899 in use**: `lsof -i :8899` to find what's listening, `kill -9 <PID>`
- **Stale validator**: `pkill -9 -f solana-test-validator` and restart with `--reset`
- **Build errors**: Make sure you're using `cargo-build-sbf` (not `cargo build`) for `.so` output

## Architecture

See the SOUL 3 implementation guide on Notion for the full step-by-step build plan. This repo implements:

| Step | What | Status |
|------|------|--------|
| 1 | ipworld-hook (transfer hook program) | ✅ Done, 7/7 tests passing |
| 2 | IpworldState PDA + verify_authority_sig | 🔜 Next |
| 3 | Attach hook at mint creation | Planned |
| 4 | Hook-aware transfers in DBC | Planned |
| 5 | Launch gating (backend auth) | Planned |
| 6 | Graduation (hook removal) | Planned |
| 7 | Trade gating (backend auth) | Planned |

Steps 8-9 are backend-only (no contract changes).

## File Map

```
programs/
  dynamic-bonding-curve/    # Meteora DBC (unmodified so far)
  ipworld-hook/             # NEW — Token-2022 Transfer Hook
    Cargo.toml
    src/
      lib.rs                # Program: 3 instructions + fallback handler (214 lines)
      state.rs              # HookConfig account struct
      errors.rs             # Custom error codes
tests/
  ipworld_hook_validator.tests.ts   # Integration tests (solana-test-validator)
  ipworld_hook.tests.ts             # Unit tests (LiteSVM, init-only)
```
