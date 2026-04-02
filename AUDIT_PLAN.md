# Chickenz Codebase Audit Plan

## Overview

Comprehensive audit of the Chickenz real-time multiplayer platformer shooter — covering client (Phaser/TypeScript), server (Bun), game simulation (Rust/WASM), ZK proving (RISC Zero), and smart contracts (Soroban).

---

## 1. SECURITY

### 1.1 WebSocket Authentication & Authorization
- `services/server/src/index.ts` — WS upgrade, message handler
- `services/server/src/GameRoom.ts` — addPlayer, handleInput
- `services/server/src/TournamentRoom.ts` — addPlayer, handleInput, handleDisconnect
- Check: no per-connection auth, playerId server-assigned, tournament host-only ops validated, routing isolation

### 1.2 Input Validation & Injection
- `services/server/src/protocol.ts` — inputFromMessage sanitization
- `services/server/src/index.ts` — message parsing, username/wallet validation
- Check: button mask 0x1f vs Taunt bit, JSON.parse prototype pollution, profanity filter bypass (unicode, combining chars), Stellar address regex, tick validation bounds

### 1.3 Rate Limiting
- `services/server/src/index.ts` — HTTP (120/min/IP) and WS (180/sec) rate limits
- Check: memory accumulation from unique IPs, no WS connection-level rate limit, prune intervals

### 1.4 Wallet Verification (Passkey/WebAuthn)
- `services/server/src/index.ts` — passkey verification, register/revalidate endpoints
- `apps/client/src/stellar.ts` — wallet creation, auth proof caching
- Check: deriveSmartAccountAddress correctness, P-256 ECDSA verification, DER-to-raw edge cases, token randomness/TTL/pruning

### 1.5 Worker API Authentication
- `services/server/src/index.ts` — worker API endpoints
- `services/server/src/prover.ts` — proof queue
- Check: Bearer token on all worker routes, admin reprove auth, proof artifact validation regex

### 1.6 Static File Serving / Path Traversal
- `services/server/src/index.ts` — static file serving
- Check: normalize/resolve prevents ../ escapes, SPA fallback cannot serve sensitive files

### 1.7 Contract Security (Soroban)
- `contracts/chickenz/src/lib.rs` — full contract
- Check: admin require_auth on all gated functions, settle_match open to anyone (by design), TTL expiration risk, upgrade trust assumption, journal endianness, negative winner decoding

### 1.8 CORS and Origin Validation
- `services/server/src/index.ts` — CORS headers, WS origin check
- Check: default CORS=*, relayer proxy origin check when ALLOWED_ORIGIN is *

### 1.9 Environment Variable Secrets
- `.env.example`, `.gitignore`, `stellar.ts`, `prover.ts`
- Check: no committed secrets, child process env leakage, admin secret never logged

---

## 2. CORRECTNESS

### 2.1 Game Simulation Determinism
- `services/prover/core/src/step.rs`, `fp.rs`, `physics.rs`, `projectiles.rs`, `weapons.rs`, `prng.rs`
- `services/prover/wasm/src/lib.rs`
- `packages/sim/src/step.ts` (legacy)
- Check: WASM bindings faithfully expose Rust sim, fp i32 overflow in mul/div, PRNG determinism, TS sim divergence

### 2.2 Round and Match Flow
- `services/server/src/GameRoom.ts` — startMatch through endMatch
- Check: ranked bo3 vs casual bo5 constants, round transition state corruption, seed management for ZK, safety cap, AFK threshold, countdown tick separation

### 2.3 Tournament Bracket Generation
- `services/server/src/TournamentRoom.ts` — bracket generation and tournament room
- `services/server/src/TournamentRoom.test.ts`
- Check: standardSeedOrder spread, all player counts × bracket types, bye resolution infinite loops, forfeit cascading, standings completeness, odd-count consolation

### 2.4 ZK Proof Flow (End-to-End)
- `services/server/src/GameRoom.ts` — transcript generation
- `services/server/src/prover.ts` — proof orchestration
- `services/prover/host/src/main.rs`, `guest/src/main.rs`
- `services/prover/core/src/fp.rs` — run_streaming_multi
- `contracts/chickenz/src/lib.rs` — settle_match
- Check: transcript format matching, Taunt bit stripping, seed commitment consistency, journal layout consistency, dual-prover race settleOnce

### 2.5 Scoring and ELO
- `services/server/src/db.ts` — ELO calculation
- Check: standard ELO formula, anti-AFK threshold gaming, bot ELO estimation, minimum ELO 0

---

## 3. RELIABILITY

### 3.1 Error Handling & Crash Recovery
- `GameRoom.ts` — gameLoop error handling, WASM panic handling
- `stellar.ts` — transaction failures
- `prover.ts` — proof timeout cleanup
- Check: WASM panic clean termination, mid-tick state corruption, fire-and-forget semantics, timeout memory leaks

### 3.2 Reconnection & Disconnection
- `NetworkManager.ts` — reconnection logic
- `GameRoom.ts`, `TournamentRoom.ts` — disconnect handlers
- Check: exponential backoff, intentional disconnect, forfeit on disconnect, cascade behavior, spectator cleanup

### 3.3 Race Conditions
- `GameRoom.ts` — endRound setTimeout
- `TournamentRoom.ts` — startMatch delay
- `index.ts` — startTxHash async
- Check: disconnect during timeout, status guards, double endMatch, catchup batch matchOver

### 3.4 State Consistency
- `GameRoom.ts` — startRound state reset
- `NetworkManager.ts` — resetThrottle
- Check: per-round state fully reset, WASM freed before new alloc, client throttle reset

---

## 4. PERFORMANCE

### 4.1 Memory Management
- `GameRoom.ts`, `index.ts`, `prover.ts`, `BotLobbyManager.ts`
- Check: room cleanup accumulation, proof queue eviction, inputQueue clearing, JSON broadcast allocation, bot state GC, WASM export_state retention

### 4.2 Network Efficiency
- `GameRoom.ts` — state broadcast
- `NetworkManager.ts` — input throttling
- Check: 60Hz JSON broadcast bandwidth, input throttle correctness, spectator re-serialization, lobby WS overhead

### 4.3 Render Performance
- `GameScene.ts`, `main.ts`
- Check: WASM lifecycle between matches, DOM layout thrashing, innerHTML updates, sprite cleanup, object pooling

---

## 5. CODE QUALITY

### 5.1 Dead Code & Unused Imports
- All TS files, legacy `packages/sim/`
- Check: which sim exports are actually used, dead simulation code in bundles, unused variables, TODOs

### 5.2 Type Safety
- `stellar.ts` — any types from dynamic import
- `GameRoom.ts` — unchecked WASM cast
- `NetworkManager.ts` — message parsing
- Check: disabled type checking for on-chain ops, silent WASM API changes, no runtime message validation

### 5.3 File Organization
- `index.ts` (1672 lines), `main.ts` (~2800 lines), `GameScene.ts` (~2400 lines)
- Check: monolithic files that should be split

---

## 6. INFRASTRUCTURE

### 6.1 Docker & Deployment
- `Dockerfile`, `scripts/deploy.sh`, `scripts/worker.sh`
- Check: non-root user, WASM build reproducibility, no health check, SQLite volume mounting

### 6.2 Multi-Region Configuration
- `apps/client/src/net/regions.ts` — hardcoded URLs
- Check: region URLs correct, TTL extension gated to US, per-region SQLite independence

### 6.3 Monitoring & Logging
- Check: no structured logging, no metrics, no alerting, /api/status endpoint limited

---

## 7. CLIENT UX

### 7.1 Error States & Edge Cases
- `main.ts`, `NetworkManager.ts`
- Check: error message display, wallet operation loading states, tournament disconnect UI, region switching mid-game

### 7.2 Responsive Design & Touch
- `index.html`, `TouchControls.ts`, `InputManager.ts`
- Check: mobile breakpoints, touch/keyboard conflict, input rebinding

### 7.3 Tutorial System
- `apps/client/src/tutorial/Tutorial.ts`
- Check: flow completeness, localStorage persistence

---

## 8. DATA INTEGRITY

### 8.1 Database Schema & Migrations
- `services/server/src/db.ts`
- Check: idempotent migrations with no versioning, no foreign keys, transcript TEXT size, WAL mode, no backups

### 8.2 Data Loss Scenarios
- Check: mid-match crash loses in-memory state, proof timeout recovery, bot transcript pruning safety, room cleanup timing

---

## 9. TESTING COVERAGE

### 9.1 Existing Tests (444 total)
- `services/server/src/` — 311 server tests (GameRoom 98, TournamentRoom 71, DB 56, Protocol 44, Prover 42)
- `packages/sim/__tests__/` — 64 TS sim tests (PRNG, replay, step, physics)
- `services/prover/core/src/` — 49 Rust core tests (fp, step, weapons, physics, prng, projectiles, hash, init)
- `contracts/chickenz/src/test.rs` — 20 contract tests

### 9.2 Missing Tests
- Client NetworkManager, RegionManager
- Proof flow end-to-end integration

---

## 10. DEPENDENCIES & SUPPLY CHAIN

### 10.1 Client
- phaser, @stellar/stellar-sdk, smart-account-kit, vite
- Check: known vulns, SAK source audit

### 10.2 Server
- Bun runtime, @stellar/stellar-sdk (dynamic), @chickenz/sim (workspace)
- Check: minimal deps, dynamic import version

### 10.3 Rust
- RISC Zero SDK, Soroban SDK, sha2, boundless-market
- Check: version compatibility, cargo audit

### 10.4 Lock Files
- pnpm-lock.yaml, Cargo.lock
- Check: committed and up to date, pnpm audit, cargo audit

---

## Execution Priority

1. **Security** (1.1-1.9) — highest priority
2. **Correctness** (2.1-2.5) — especially ZK proof flow
3. **Reliability** (3.1-3.4) — race conditions, disconnects
4. **Data Integrity** (8.1-8.2)
5. **Testing Coverage** (9.1-9.2)
6. **Performance** (4.1-4.3)
7. **Infrastructure** (6.1-6.3)
8. **Dependencies** (10.1-10.4)
9. **Code Quality** (5.1-5.3)
10. **Client UX** (7.1-7.3)
