# Backend Implementation Tasklist

> Everything the Go backend + frontend needs to support the ipworld launchpad.
> On-chain programs are complete. This is the remaining work.

---

## Overview

The backend has 5 major responsibilities:

1. **Auth signing** — sign LaunchAuth + TradeAuth for every pool creation and swap
2. **Pool lifecycle management** — create configs, detect graduation, set up fee splitting
3. **Fee collection + distribution** — claim from DAMM v2, deposit to splitter, trigger distribute
4. **Owner management** — verify IP owners, call update_owner on splitter
5. **Indexing** — track prices, trades, holders, pool state for the frontend

---

## Section 1: Auth Signing Service

### Task 1.1: Store authority keypair securely
- **What:** The authority keypair (`keys/<net>/authority-keypair.json`) must be accessible to the backend for Ed25519 signing
- **Implementation:** Load from env var / AWS KMS / Vault — NOT from a file on disk in production
- **Format:** 64-byte Ed25519 secret key (first 32 bytes = private, last 32 = public)
- **Go library:** `crypto/ed25519` from stdlib — `ed25519.Sign(privateKey, message)`

### Task 1.2: `POST /api/v1/auth/launch` endpoint
- **When called:** Frontend requests to create a new IP token
- **Input:** `{ creator: string (wallet pubkey), config: string (pool config pubkey) }`
- **Backend logic:**
  1. Validate the user is authenticated and allowed to launch
  2. Derive the pool PDA: `seeds = ["pool", config, firstKey(baseMint, quoteMint), secondKey(baseMint, quoteMint)]` — but baseMint isn't known yet (it's created in the same tx). So the backend must **pre-derive** the baseMint keypair, compute the pool PDA, then return the baseMint keypair to the frontend along with the signature.
  3. Construct LaunchAuth message: `creator (32 bytes) || config (32 bytes) || pool_pda (32 bytes)` = 96 bytes
  4. Sign with `ed25519.Sign(authorityPrivateKey, launchAuthBytes)`
  5. Return: `{ signature: base64, message: base64, authorityPubkey: string, baseMintKeypair: base64 }`
- **Frontend then:** Constructs tx with Ed25519 verify ix (instruction 0) + initializeVirtualPoolWithToken2022 ix (instruction 1)
- **Security:** Rate limit this endpoint. Each launch costs the user SOL (tx fee + rent), but you should still prevent spam.

### Task 1.3: `POST /api/v1/auth/trade` endpoint
- **When called:** Frontend requests trade authorization (once per hour per user)
- **Input:** `{ wallet: string (user's wallet pubkey) }`
- **Backend logic:**
  1. Validate user is authenticated
  2. Construct TradeAuth message: `user (32 bytes) || expires_at (8 bytes, i64 LE)` = 40 bytes
  3. `expires_at` = `time.Now().Unix() + 3600` (1 hour from now)
  4. Sign with `ed25519.Sign(authorityPrivateKey, tradeAuthBytes)`
  5. Return: `{ signature: base64, message: base64, authorityPubkey: string, expiresAt: number }`
- **Frontend then:** Caches this in JS memory. Prepends Ed25519 verify ix to every swap tx. Refreshes 5 min before expiry.
- **Security:** Must verify the user owns the wallet (e.g., signed auth token, or wallet signature verification at login)

### Task 1.4: Frontend — Ed25519 instruction construction
- **What:** Frontend must prepend `Ed25519Program.createInstructionWithPublicKey(...)` before every launch/swap tx
- **Library:** `@solana/web3.js` has `Ed25519Program` built in
- **Pattern:**
  ```typescript
  import { Ed25519Program } from "@solana/web3.js";
  const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: Buffer.from(authorityPubkey, "base64"), // 32 bytes
    message: Buffer.from(message, "base64"),
    signature: Buffer.from(signature, "base64"), // 64 bytes
  });
  // Prepend this BEFORE the actual instruction in the transaction
  tx.add(ed25519Ix, swapIx);
  ```
- **Cache management:** Store TradeAuth in memory/sessionStorage. Refresh when `expiresAt - Date.now() < 300_000` (5 min buffer).

---

## Section 2: Pool Lifecycle Management

### Task 2.1: Database schema — pools table
```sql
CREATE TABLE sol_pools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  base_mint TEXT NOT NULL UNIQUE,         -- Token-2022 mint address
  pool_address TEXT NOT NULL UNIQUE,       -- DBC pool PDA
  config_address TEXT NOT NULL,            -- Pool config used
  creator_wallet TEXT NOT NULL,            -- Who launched it
  ip_id UUID REFERENCES ips(id),           -- Link to IP entity
  status TEXT NOT NULL DEFAULT 'active',   -- active | graduated | failed
  migration_threshold_sol NUMERIC,         -- SOL needed to graduate
  current_quote_amount NUMERIC DEFAULT 0,  -- Current SOL in curve
  graduated_at TIMESTAMPTZ,
  damm_v2_pool_address TEXT,              -- Set after graduation
  lp_position_nft TEXT,                    -- LP position NFT (for fee claiming)
  splitter_fee_config TEXT,               -- Splitter FeeConfig PDA
  splitter_vault TEXT,                     -- Splitter vault PDA
  owner_wallet TEXT,                       -- Verified IP owner (nullable until verified)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sol_pools_status ON sol_pools(status);
CREATE INDEX idx_sol_pools_base_mint ON sol_pools(base_mint);
```

### Task 2.2: Pool config creation (one-time setup)
- **When:** During deployment, create 1-2 reusable pool configs
- **How:** Run `scripts/admin/create-operator.ts` then construct a `createConfig` tx
- **Key params to store in DB/env:**
  - `config_address` — the pool config PDA
  - `fee_claimer` — treasury wallet
  - `migration_quote_threshold` — graduation threshold in lamports
  - `compounding_fee_bps` — 1250 (12.5%)
- **You probably want 1 config** for all standard launches, maybe a second for special launches with different thresholds

### Task 2.3: `POST /api/v1/pools/launch` — full launch flow
- **What:** End-to-end flow when a user launches a new IP token
- **Steps:**
  1. Receive launch request from frontend (IP metadata, creator wallet)
  2. Generate baseMint keypair on backend: `ed25519.GenerateKey(nil)` → save the keypair
  3. Derive pool PDA from config + baseMint + quoteMint(NATIVE_MINT)
  4. Sign LaunchAuth (Task 1.2)
  5. Return to frontend: LaunchAuth signature + baseMint keypair + accounts needed
  6. Frontend constructs + sends the transaction
  7. Backend listens for tx confirmation → inserts into `sol_pools` table
- **Important:** The baseMint keypair must be a signer on the transaction (it's the mint being created). The backend generates it, gives it to the frontend, and the frontend includes it as a signer.

### Task 2.4: Graduation detection service
- **What:** Background service that detects when pools graduate
- **Implementation options (pick one):**
  - **A) Poll-based:** Every 30-60 seconds, query all `status='active'` pools. For each, fetch the pool account from RPC and check `migration_progress`. If migrated, update DB.
  - **B) WebSocket:** Subscribe to the DBC program via `connection.onProgramAccountChange()` for pool accounts. Detect state changes.
  - **C) Helius webhook:** Register a webhook at `https://api.helius.xyz/v0/webhooks` for the `migrate_damm_v2` instruction on your DBC program ID.
- **Recommendation for launch:** Option A (polling) — simplest, most reliable. Move to C later for lower latency.
- **On graduation detected:**
  1. Update `sol_pools` SET `status='graduated'`, `graduated_at=NOW()`, `damm_v2_pool_address=<parsed from tx>`
  2. Call `setup-post-graduation` (init splitter fee config for this mint)
  3. Record LP position NFT address from the migration tx output
  4. Derive and store `splitter_fee_config` and `splitter_vault` PDA addresses

### Task 2.5: Graduation — set up splitter (automated)
- **What:** After detecting graduation, call `init_fee_config` on the splitter program
- **Implementation:** Use Solana Go SDK (`github.com/gagliardetto/solana-go`) or shell out to `npx ts-node scripts/admin/setup-post-graduation.ts`
- **Params:** 
  - `mint` = the graduated token's base_mint
  - `authority` = your authority pubkey
  - `treasury` = your treasury wallet
  - `community` = your community wallet
  - BPS: 5714 / 3429 / 857

---

## Section 3: Fee Collection & Distribution

### Task 3.1: Fee claim cron job
- **What:** Periodically claim accumulated trading fees from DAMM v2 LP positions
- **Frequency:** Biweekly (or configurable — more frequent for high-volume tokens)
- **For each graduated pool:**
  1. Call `claim_position_fee` on DAMM v2 using the LP position NFT
  2. This sends claimed tokens (IP token) to the wallet that holds the NFT
  3. Transfer the claimed tokens FROM your wallet TO the splitter vault PDA
  4. Call `distribute` on the splitter to split to treasury/community/owner
- **Go implementation:** Use `solana-go` SDK to construct these transactions
- **DB tracking:**
  ```sql
  CREATE TABLE fee_claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID REFERENCES sol_pools(id),
    epoch_number INT,
    claimed_amount NUMERIC NOT NULL,
    treasury_amount NUMERIC,
    community_amount NUMERIC,
    owner_amount NUMERIC,
    claim_tx_sig TEXT,
    distribute_tx_sig TEXT,
    claimed_at TIMESTAMPTZ DEFAULT NOW()
  );
  ```

### Task 3.2: `distribute` trigger
- **What:** After depositing claimed fees to the splitter vault, call `distribute()`
- **Note:** This is permissionless — could even be a public endpoint that anyone can call
- **Implementation:** Part of the fee claim cron job (Task 3.1, step 4)

### Task 3.3: Batch airdrop — holder rewards (15% of fees)
- **What:** Distribute the holder portion from the community wallet to individual token holders
- **Frequency:** Same as fee claim (biweekly)
- **Steps:**
  1. Snapshot all holders of the token (from your indexing DB — Task 5.3)
  2. Calculate each holder's share based on balance × holding duration (your reward formula)
  3. Batch SPL transfers from community wallet to each holder's ATA
  4. Solana supports ~20-25 transfers per transaction (limited by tx size)
  5. For 1000 holders → ~40-50 transactions
- **Go implementation:** Build transactions with multiple `token::Transfer` instructions
- **DB tracking:**
  ```sql
  CREATE TABLE airdrop_distributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID REFERENCES sol_pools(id),
    epoch_number INT,
    distribution_type TEXT NOT NULL, -- 'holder' | 'ugc'
    total_amount NUMERIC NOT NULL,
    recipient_count INT,
    tx_signatures TEXT[], -- array of tx sigs
    distributed_at TIMESTAMPTZ DEFAULT NOW()
  );
  
  CREATE TABLE airdrop_recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    distribution_id UUID REFERENCES airdrop_distributions(id),
    wallet TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    tx_sig TEXT
  );
  ```

### Task 3.4: Batch airdrop — UGC rewards (15% of fees)
- **What:** Distribute the UGC portion to content creators
- **Same flow as 3.3** but share calculation is based on UGC engagement scores instead of holding duration
- **Input:** UGC scoring data from your content platform
- **Note:** Holder + UGC rewards both come from the same community wallet. The 15%/15% split is a backend accounting decision — the splitter just sends 34.29% to the community wallet as one lump.

---

## Section 4: Owner Management

### Task 4.1: Owner verification flow
- **What:** When an IP owner is verified (by your team or automated KYC), update the on-chain splitter
- **Database:**
  ```sql
  ALTER TABLE sol_pools ADD COLUMN owner_verified_at TIMESTAMPTZ;
  ALTER TABLE sol_pools ADD COLUMN owner_verification_status TEXT DEFAULT 'pending';
  -- pending | verified | rejected
  ```
- **API:** `PATCH /api/v1/pools/:id/owner` `{ wallet: string, status: "verified" }`
- **On verification:**
  1. Update DB: `owner_wallet`, `owner_verified_at`, `owner_verification_status='verified'`
  2. Call `update_owner` on the splitter program:
     - This flushes ALL accumulated vault balance (owner share goes to the NEW owner)
     - Updates the on-chain owner address
     - Future `distribute()` calls send 8.57% to this owner
  3. Notify the IP owner that they're verified and receiving fees

### Task 4.2: Owner address change
- **What:** An existing verified owner changes their wallet
- **API:** `PATCH /api/v1/pools/:id/owner` `{ wallet: string (new wallet) }`
- **Same flow as 4.1** — calls `update_owner` again with the new address

---

## Section 5: Indexing & Data

### Task 5.1: Trade indexing
- **What:** Record every swap on the bonding curve (pre-graduation) and DAMM v2 (post-graduation)
- **Pre-graduation:** Parse DBC `Swap` / `Swap2` events from program logs
- **Post-graduation:** Parse DAMM v2 swap events
- **Database:**
  ```sql
  CREATE TABLE sol_trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID REFERENCES sol_pools(id),
    base_mint TEXT NOT NULL,
    trader_wallet TEXT NOT NULL,
    direction TEXT NOT NULL, -- 'buy' | 'sell'
    input_amount NUMERIC NOT NULL,
    output_amount NUMERIC NOT NULL,
    input_mint TEXT NOT NULL,
    output_mint TEXT NOT NULL,
    price_sol NUMERIC, -- computed: sol_amount / token_amount
    tx_signature TEXT NOT NULL UNIQUE,
    block_time TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  
  CREATE INDEX idx_sol_trades_base_mint ON sol_trades(base_mint);
  CREATE INDEX idx_sol_trades_trader ON sol_trades(trader_wallet);
  CREATE INDEX idx_sol_trades_block_time ON sol_trades(block_time);
  ```
- **Implementation options:**
  - **Helius Enhanced Transactions API** — easiest, returns parsed instructions
  - **geyser plugin** — most performant for high volume
  - **RPC polling** — `getSignaturesForAddress` on the pool account, then `getTransaction` for each

### Task 5.2: Price tracking (OHLCV)
- **What:** Real-time and historical price data for charts
- **Pre-graduation:** Price derived from the bonding curve math: `price = f(current_supply)`. Or simpler: use the last trade price.
- **Post-graduation:** Price from DAMM v2 pool state: `sqrt_price^2 * 10^(decimals_diff)`
- **Database:**
  ```sql
  CREATE TABLE sol_price_candles (
    base_mint TEXT NOT NULL,
    interval TEXT NOT NULL, -- '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
    open_time TIMESTAMPTZ NOT NULL,
    open NUMERIC NOT NULL,
    high NUMERIC NOT NULL,
    low NUMERIC NOT NULL,
    close NUMERIC NOT NULL,
    volume_sol NUMERIC NOT NULL,
    volume_tokens NUMERIC NOT NULL,
    trade_count INT NOT NULL,
    PRIMARY KEY (base_mint, interval, open_time)
  );
  ```
- **Build from trades:** Aggregate `sol_trades` into candles on each new trade. Use materialized views or application-level bucketing.
- **API:** `GET /api/v1/pools/:mint/candles?interval=1h&from=...&to=...`

### Task 5.3: Holder balance tracking
- **What:** Track who holds how many tokens and for how long (needed for holder airdrops)
- **Implementation:**
  - Subscribe to token account changes for each token mint (via Helius or geyser)
  - Or: periodically call `getTokenLargestAccounts` + `getProgramAccounts` filtered by mint
- **Database:**
  ```sql
  CREATE TABLE sol_holder_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    base_mint TEXT NOT NULL,
    wallet TEXT NOT NULL,
    balance NUMERIC NOT NULL,
    first_held_at TIMESTAMPTZ NOT NULL,
    snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  
  CREATE INDEX idx_holder_snapshots_mint ON sol_holder_snapshots(base_mint);
  ```
- **For airdrop calculation:** Query latest snapshot, compute `balance × holding_duration` weighted score per holder

### Task 5.4: Pool state indexing
- **What:** Track current state of each pool for the frontend (market cap, progress to graduation, volume)
- **Fields to track:**
  - `current_quote_amount` — SOL in the curve (progress bar: `current / threshold`)
  - `total_supply` — tokens in circulation
  - `current_price` — latest trade price
  - `market_cap` — `current_price × total_supply`
  - `24h_volume` — from trade aggregation
  - `holder_count` — unique wallets holding > 0
- **API:** `GET /api/v1/pools` (list with summary) and `GET /api/v1/pools/:mint` (detail)

### Task 5.5: Frontend — pool discovery page
- **What:** Display all active pools, graduated pools, trending, etc.
- **Data from:** Task 5.4 API
- **Features:** Sort by volume, market cap, creation time, graduation progress

---

## Section 6: Infrastructure

### Task 6.1: Solana RPC provider
- **What:** You need a reliable RPC endpoint for both reads and writes
- **Options:**
  - **Helius** ($0 free tier, $50-500/mo paid) — best DX, enhanced APIs, webhooks
  - **Triton/QuickNode** — similar pricing
  - **Self-hosted** — only if you need extreme throughput
- **Recommendation:** Helius — their Enhanced Transactions API and webhooks save significant indexing work
- **Config:** Store RPC URL in env: `SOLANA_RPC_URL`

### Task 6.2: Transaction sending strategy
- **What:** Reliable tx submission (Solana txs can fail/drop)
- **Pattern:**
  1. Build tx → simulate first (`simulateTransaction`)
  2. Send with `skipPreflight: false`
  3. Poll for confirmation with timeout (30s)
  4. Retry up to 3x with fresh blockhash if expired
- **Priority fees:** Include `ComputeBudgetProgram.setComputeUnitPrice(50000)` in all txs for faster inclusion
- **Go library:** `github.com/gagliardetto/solana-go`

### Task 6.3: Monitoring & alerting
- **What:** Know when things go wrong
- **Monitor:**
  - Authority wallet SOL balance (needs enough for tx fees)
  - Community wallet token balances (should drain after airdrops)
  - Vault balances (should drain after distribute)
  - Fee claim cron job health
  - RPC endpoint latency/errors
- **Alert on:**
  - Authority wallet < 0.5 SOL
  - Fee claim cron missed a cycle
  - Any tx failure in the fee pipeline
  - Graduation detected but setup-post-graduation failed

---

## Section 7: Go Dependencies

```go
// go.mod additions
require (
    github.com/gagliardetto/solana-go v1.10.0  // Solana SDK
    github.com/gagliardetto/binary v0.8.0       // Borsh encoding
    crypto/ed25519                               // stdlib — auth signing
)
```

---

## Task Priority & Timeline

### Week 1: Core auth + launch
- [ ] Task 1.1: Authority key setup
- [ ] Task 1.2: `/auth/launch` endpoint
- [ ] Task 1.3: `/auth/trade` endpoint
- [ ] Task 1.4: Frontend Ed25519 ix construction
- [ ] Task 2.1: Database schema
- [ ] Task 2.2: Pool config creation (one-time)
- [ ] Task 2.3: Full launch flow
- [ ] Task 6.1: RPC provider setup

### Week 2: Trading + indexing
- [ ] Task 5.1: Trade indexing
- [ ] Task 5.2: Price tracking (OHLCV)
- [ ] Task 5.4: Pool state indexing
- [ ] Task 5.5: Frontend pool page
- [ ] Task 6.2: Transaction reliability

### Week 3: Graduation + fees
- [ ] Task 2.4: Graduation detection
- [ ] Task 2.5: Post-graduation splitter setup
- [ ] Task 3.1: Fee claim cron
- [ ] Task 3.2: Distribute trigger
- [ ] Task 5.3: Holder balance tracking

### Week 4: Airdrops + owner + polish
- [ ] Task 3.3: Holder reward airdrops
- [ ] Task 3.4: UGC reward airdrops
- [ ] Task 4.1: Owner verification flow
- [ ] Task 4.2: Owner address change
- [ ] Task 6.3: Monitoring & alerting

---

## Notes

- **All on-chain programs are deployed and tested.** This tasklist is purely backend + frontend + infra.
- **The Solana Go SDK** (`solana-go`) can construct and send all the transactions referenced above. Alternatively, you can shell out to `npx ts-node` scripts for less frequent operations (graduation setup, owner updates).
- **For indexing, Helius is strongly recommended** — their Enhanced Transactions API returns parsed instruction data, saving you from writing Borsh deserialization for every event type.
- **The frontend wallet adapter** (`@solana/wallet-adapter-react`) handles wallet connection. Use `@solana/web3.js` for transaction construction.
