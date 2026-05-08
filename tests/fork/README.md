# SPEC-DBC-004 Phase 8 — Solana Mainnet Fork Test Infrastructure

This directory contains the 12 fork-test scenarios mandated by SPEC-DBC-004
REQ-V-003 + REQ-F-001..003. Fork tests exercise IPWorld's on-chain behavior
against cloned mainnet account state, providing a higher-fidelity validation
than pure LiteSVM unit tests.

---

## Directory layout

```
tests/fork/
├── README.md                                 # this file
├── fixtures/                                 # mainnet account dumps (JSON)
├── utils/
│   ├── litesvm-harness.ts                    # bootForkSvm + requireForkRpc + populateFixtureAccounts
│   ├── clone-mainnet-account.ts              # solana account JSON capture (offline operator-only)
│   └── diff-account-state.ts                 # before/after snapshot + delta helper
├── scenario-01-pool-create.tests.ts          # boot smoke (non-mutating)
├── scenario-02-buy-quote-distribution.tests.ts          # mutating
├── scenario-03-sell-base-distribution.tests.ts          # mutating
├── scenario-04-graduation-damm-v2-onlyb.tests.ts        # mutating
├── scenario-05-harvest-cpi.tests.ts                     # mutating
├── scenario-06-ip-owner-vault-flow.tests.ts             # mutating
├── scenario-07-ed25519-attack-rejection.tests.ts        # non-mutating
├── scenario-08-admin-two-step.tests.ts                  # mutating
├── scenario-09-ip-owner-two-step.tests.ts               # mutating
├── scenario-10-referral-immediate.tests.ts              # mutating
├── scenario-11-hook-p2p-blocking.tests.ts               # Path B / non-mutating
└── scenario-12-rate-limiter.tests.ts                    # non-mutating
```

---

## Path A vs Path B

| # | Scenario | Path | Reason |
|---|---|---|---|
| 01 | Pool create boot smoke | A | Pure LiteSVM boot; no Token-2022 hook CPI required |
| 02 | Buy quote distribution | A | Standard DBC swap path |
| 03 | Sell base distribution + referral | A | Standard DBC swap path with remaining_accounts |
| 04 | Graduation → DAMM v2 OnlyB | A | DAMM v2 .so is loaded into LiteSVM |
| 05 | Harvest CPI redistribution | A | Cross-program CPI to DAMM v2 (loaded in svm.ts) |
| 06 | IP-owner vault end-to-end | A | ip-owner-vault .so is loaded by startSvm() |
| 07 | Ed25519 attack rejection | A | Pure ix-level pre-instruction validation |
| 08 | Admin two-step transfer | A | IpworldState mutation via DBC ix |
| 09 | IP owner two-step transfer | A | TokenVerification mutation via DBC ix |
| 10 | Referral immediacy | A | Same-tx lamport movement on swap |
| 11 | Hook P2P blocking | **B** | Token-2022 transfer-hook CPI is not faithfully modeled in LiteSVM; requires a live Token-2022 program clone |
| 12 | Rate-limiter sniper defense | A | RateLimiter retained per REQ-S-001 — pure DBC swap path |

**Path A (LiteSVM)** runs the program in-process via the `litesvm` Node binding.
Programs are pre-loaded by `tests/utils/svm.ts::startSvm()`. Scenarios then
populate mainnet account dumps from `fixtures/` on top of the empty LiteSVM
state, and exercise the DBC + ip-owner-vault programs directly.

**Path B (`solana-test-validator --reset --clone-account`)** spawns a local
validator process with the listed account(s) cloned from mainnet on startup.
Required by scenario 11 only — Token-2022 transfer-hook CPI semantics are
faithful only against a live Token-2022 program. The operator must run the
validator manually before invoking the scenario:

```bash
solana-test-validator \
    --reset \
    --clone-account TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
    --url "${SOLANA_MAINNET_RPC_URL}" &
```

Scenario 11's harness connects to the validator via a `Connection` (not
LiteSVM) and asserts the hook callback rejects the forbidden P2P transfer.

---

## RPC requirement

All scenarios honor a single environment variable:

```bash
export SOLANA_MAINNET_RPC_URL="https://api.mainnet-beta.solana.com"
# or any commercial RPC: helius / triton / quicknode
```

When `SOLANA_MAINNET_RPC_URL` is **unset**, the harness skips all 12 scenarios
gracefully via Mocha `this.skip()` in `before(function () { ... })`. The
suite exits with code 0 (no failures, all tests marked pending).

When **set**, scenario 01 boots LiteSVM and the remaining scenarios exercise
the cloned-account or live-validator paths described above.

---

## Refresh policy (mainnet account dumps)

Mainnet PDAs (config, pool, token-verification) evolve over time as IPWorld
operators update parameters. Each fixture file in `fixtures/` carries a
`capturedAt` ISO-8601 timestamp. The recommended refresh cadence is:

- **30 days** for high-traffic pools (config + pool fixtures)
- **90 days** for slower-moving accounts (TokenVerification, admin state)

To refresh, run from a node session:

```ts
import { cloneMainnetAccounts } from "./utils/clone-mainnet-account";
import { PublicKey } from "@solana/web3.js";

await cloneMainnetAccounts([
  { slug: "dbc-config-mainnet-A", pubkey: new PublicKey("...") },
  { slug: "dbc-pool-mainnet-A", pubkey: new PublicKey("...") },
  { slug: "token-verification-mainnet-A", pubkey: new PublicKey("...") },
  // …
]);
```

`cloneMainnetAccounts()` produces files in the
`solana account --output json <pubkey>` format, directly reusable by Path B's
`solana-test-validator --clone-account`.

Fixtures are **not committed** if they exceed 1 MB or contain proprietary
data; the per-account size for DBC config / pool / TokenVerification is
≤ 1500 bytes each, well under the limit.

---

## Run command

```bash
yarn test:fork
```

Runs all 12 scenarios via `ts-mocha`. The script is defined in
`package.json` as:

```json
"test:fork": "yarn run ts-mocha --runInBand -p ./tsconfig.json -t 1000000 tests/fork/scenario-*.tests.ts"
```

Note: fork tests are **opt-in** and are NOT included in the default `yarn test`
command. CI pipelines that wish to run them must configure the env var and
explicitly invoke `yarn test:fork`.

---

## Strict-assertion contract (REQ-F-002 + REQ-T-003)

Every scenario file MUST contain at least one strict assertion of the form:

- chai: `expect(x).to.equal(y)` — preferred (this project uses chai v4)
- jest-style: `expect(x).toEqual(y)` / `expect(x).toBe(y)` — also accepted by ast-grep
- node: `assert.deepStrictEqual(x, y)` — also accepted

Weak assertions are **forbidden** in fork tests:

- `expect(x).to.exist` — too permissive
- `expect(x).to.be.true` — borderline; prefer `expect(x).to.equal(true)`
- jest-style `toBeDefined` / `toBeTruthy` — explicitly forbidden by REQ-T-003

The verification script in `acceptance.md` checks both the presence of
strict assertions (≥ 1 per file) and the absence of weak assertions (= 0 over
all files).

---

## Mutating scenario contract (REQ-F-002 canonical list)

Mutating scenarios — `02, 03, 04, 05, 06, 08, 09, 10` — MUST import
`utils/diff-account-state.ts` and capture the on-chain account state before
AND after the swap or claim. The helper produces a structured `DiffResult`
containing `before`, `after`, and per-pubkey `deltas`.

Non-mutating scenarios — `01, 07, 11, 12` — exercise rejection or boot
behavior; the chain state is unchanged on revert, so the diff helper is
optional.

---

## Failure reporting (REQ-F-003)

When a fork scenario fails, the harness MUST surface a structured
before/after diff. `utils/diff-account-state.ts::formatDiff()` produces a
single-line-per-account record suitable for inclusion in the Mocha failure
trace.

---

## Cross-references

- `tests/utils/svm.ts` — provides `startSvm()` reused by `bootForkSvm()`
- `tests/utils/constants.ts` — program ID constants imported by all scenarios
- `tests/utils/accounts.ts` — PDA derivation helpers reused by scenarios 08-09
- `programs/ip-owner-vault/` — Phase-6 program crate exercised by scenario 06
- `.moai/specs/SPEC-DBC-004/` — SPEC, plan, acceptance, and cleanup-log

---

Authored: SPEC-DBC-004 Phase 8 (REQ-V-003 + REQ-F-001..003)
Last updated: 2026-05-06
