# Chickenz Comprehensive Codebase Audit Report

**Date**: 2026-04-02
**Scope**: Full codebase — client, server, contracts, Rust simulation, ZK proving, infrastructure

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 8 |
| HIGH | 22 |
| MEDIUM | 35 |
| LOW | 15 |
| INFO | 6 |
| **TOTAL** | **86** |

Findings are deduplicated across audit agents and grouped by category.

---

## Fix Status

The following items from this audit have been resolved:

**Round 1 (commit b406365):** C1, C2, C3, C4, C5, H1, H4, H5, H6, H8, H12, H15, M1, M2
**Round 2 (commit ded7b42):** C7, C8, H11, H17, H20, H21, H22, M5, M6, M12, M14, M17, M18, M19, M20, M22, M27, M28

**Confirmed safe (no change needed):** C6, H2, H3, H18, M3, M35

**Design decisions / won't fix:** H7, H9, H10, H13, H14, H16, M4, M7, M8, M9, M10, M11, M13, M15, M16, M21, M23, M24, M25, M26, M29, M30-M34, L1-L15

---

## CRITICAL (8)

### C1. Tournament Disconnect During Match Intro Ignored
- **File**: `services/server/src/TournamentRoom.ts:634-673`
- **Issue**: `startMatch()` sends `tournament_match_start` then waits `MATCH_INTRO_MS` (3s) before creating GameRoom. If a fighter disconnects during this window, `handleDisconnect()` tries to call `this.activeGameRoom.handleDisconnect()` but `activeGameRoom` is null — disconnect is silently ignored. When GameRoom is created 3s later, the player is gone but no forfeit is recorded.
- **Fix**: Check `disconnected` set before creating GameRoom; forfeit if a fighter left during intro.

### C2. Division by Zero in Fixed-Point `div()` Function
- **File**: `services/prover/core/src/fp.rs:29-30`
- **Issue**: `pub fn div(a: Fp, b: Fp) -> Fp { (((a as i64) << FRAC) / b as i64) as Fp }` — no guard for `b == 0`. Would panic and crash the WASM runtime or ZK guest.
- **Fix**: Add `if b == 0 { return 0; }` guard.

### C3. Panic on Invalid Multi-Round Input in Prover
- **File**: `services/prover/core/src/fp.rs:1780`
- **Issue**: `run_streaming_multi()` panics if `round_wins` is anything other than `[2,0]` or `[0,2]`. A malformed transcript could crash the prover.
- **Fix**: Return an error or validate input before calling `run_streaming_multi`.

### C4. Integer Overflow in Round End Calculation
- **File**: `services/prover/core/src/fp.rs:1710`
- **Issue**: `let round_end = offset + 4 + tick_count * 6;` — if `tick_count` is large, multiplication overflows `usize`, wrapping to a small value. Subsequent loop reads past buffer.
- **Fix**: Use checked arithmetic: `tick_count.checked_mul(6).and_then(|x| x.checked_add(offset + 4))`.

### C5. Out-of-Bounds Read in `replay_round()`
- **File**: `services/prover/core/src/fp.rs:1705-1714`
- **Issue**: Reads `data[offset..offset+3]` for tick_count without validating buffer length. Panics if data is truncated.
- **Fix**: Assert `offset + 4 <= data.len()` and `round_end <= data.len()` before reading.

### C6. No Bounds Validation in ZK Guest Before Parsing
- **File**: `services/prover/guest/src/main.rs:15-26`
- **Issue**: Reads `byte_len` from input without bounds check. Malformed input could cause panic.
- **Fix**: Validate `byte_len <= MAX_INPUT_WORDS * 4` before `read_slice()`.

### C7. Race Condition: `startTxHash` Lost Between Async TX and Match End
- **File**: `services/server/src/index.ts:414-432`
- **Issue**: `startMatchOnChain()` is async and may complete after match ends. The `.then()` callback checks `room.matchRecordId` which may not yet be set when the TX completes. Window exists where hash is lost.
- **Fix**: Store `startTxHash` on the room immediately; apply it to DB in `returnToLobby()` after `insertMatch()`.

### C8. Event Listener Memory Leak in Tournament/Match History Rendering
- **File**: `apps/client/src/main.ts:2200-2230, 1485-1553`
- **Issue**: Tournament player slots and match history items get `addEventListener("click")` on every render. Elements are recreated via `innerHTML` but listeners on child elements that survive (or closures that capture state) accumulate.
- **Fix**: Use event delegation (single listener on parent, match via `event.target`).

---

## HIGH (22)

### H1. playerId Not Validated Before `room.handleInput()`
- **File**: `services/server/src/index.ts:1540-1545`
- **Issue**: No check that `ws.data.playerId` is 0 or 1 before forwarding to GameRoom.
- **Fix**: Add `if (ws.data.playerId !== 0 && ws.data.playerId !== 1) return;`.

### H2. Tournament Input Not Validated Against Active Fighters
- **File**: `services/server/src/TournamentRoom.ts:417-426`
- **Issue**: `handleInput()` passes WebSocket to `activeGameRoom` without verifying the caller is a fighter in the current match. A spectator could inject input.
- **Fix**: Check that the participant's slot matches a current fighter slot.

### H3. Wallet Address Regex Allows Contract Addresses
- **File**: `services/server/src/index.ts:917, 1143`
- **Issue**: `/^[CG][A-Z2-7]{55}$/` matches both `G` (account) and `C` (contract) addresses. Contract addresses shouldn't be used for ranked play.
- **Fix**: Use `/^G[A-Z2-7]{55}$/` for account addresses only.

### H4. No Message Size Limit Before `JSON.parse` on WebSocket Data
- **File**: `services/server/src/index.ts:1110`
- **Issue**: Unbounded message size passed to `JSON.parse`. A 100MB message could cause parsing delays.
- **Fix**: Add `if (message.length > 10000) return;` before parsing.

### H5. DER Signature Parsing Doesn't Validate Length Bounds
- **File**: `services/server/src/index.ts:76-100`
- **Issue**: `derToRaw()` reads offsets without checking they don't exceed `derSig.length`. Truncated signatures could cause out-of-bounds access.
- **Fix**: Add bounds validation for `rStart + rLen` and `sStart + sLen`.

### H6. Token Expiry Not Checked at Revalidation Time
- **File**: `services/server/src/index.ts:570-582`
- **Issue**: Verified tokens have 24h TTL but expiry is only checked during periodic pruning (every 10 min). Expired tokens accepted for up to 10 minutes past expiry.
- **Fix**: Check `now - stored.issuedAt > TTL` at revalidation time.

### H7. Taunt Bit Inconsistency Between WASM and Transcript
- **File**: `services/server/src/GameRoom.ts:536-554`
- **Issue**: WASM `step()` receives full buttons (with Taunt), but transcript strips the Taunt bit. If Taunt ever affects game state, proof will diverge from server sim.
- **Risk**: Currently safe (Rust sim ignores Taunt), but fragile. Document clearly.

### H8. Odd Consolation Player Count Silently Drops Player
- **File**: `services/server/src/TournamentRoom.ts:214-231`
- **Issue**: `full_consolation` pairs consolation inputs with `for (i += 2)`. Odd count = last player silently dropped.
- **Fix**: Give odd player a bye instead of dropping them.

### H9. WASM JSON Serialization Precision Loss
- **File**: `services/prover/wasm/src/lib.rs:347-358`
- **Issue**: `import_state()` round-trips through JSON (JsValue -> String -> serde_json). JS f64 has 53-bit mantissa; large i32 fixed-point values could lose precision.
- **Fix**: Use typed arrays or base64-encoded bytes for state transfer.

### H10. No Reconnection Window for In-Game Players
- **File**: `apps/client/src/net/NetworkManager.ts:346-356`, `services/server/src/GameRoom.ts:262-271`
- **Issue**: Server immediately forfeits on disconnect. Client retries for ~30s but server has already ended the match. No grace period.
- **Fix**: Add 10-30s server-side reconnection window before forfeiting.

### H11. Tournament Spectator Sockets Not Cleaned on Disconnect
- **File**: `services/server/src/TournamentRoom.ts:405-414`
- **Issue**: Fighter disconnect during match doesn't clean spectator arrays on `activeGameRoom`. Disconnected spectators receive wasted broadcasts.

### H12. Spectator Array Unbounded — DoS Vector
- **File**: `services/server/src/GameRoom.ts:643-652`
- **Issue**: `spectatorSockets` has no max size. Thousands of spectators = O(n) broadcast per tick.
- **Fix**: Cap at 20 spectators per room.

### H13. Verifier Contract Compromise = Total Game Integrity Loss
- **File**: `contracts/chickenz/src/lib.rs:273-281`
- **Issue**: If verifier contract is upgraded to malicious code, all proofs pass/fail at attacker's discretion.
- **Mitigation**: Document this trust assumption. Consider timelock on verifier address changes.

### H14. `settle_match()` Has No Access Control
- **File**: `contracts/chickenz/src/lib.rs:239`
- **Issue**: Anyone can call `settle_match()` with a valid proof. This is by design (permissionless settlement), but means a front-runner could settle before the intended party.
- **Note**: The ZK proof is the authorization. This is acceptable but should be documented.

### H15. Untracked setTimeout Callbacks in Tournament Animation
- **File**: `apps/client/src/main.ts:2528-2582`
- **Issue**: 3 setTimeout calls during bracket animation have no stored references. If user leaves tournament during animation, callbacks fire on destroyed scene.
- **Fix**: Store timeout IDs and clear them in `hideAllTournamentOverlays()`.

### H16. Race Condition in Wallet Verification During Region Switch
- **File**: `apps/client/src/main.ts:556-627`
- **Issue**: If user switches regions during wallet verification, `lastVerifiedAddr` is invalidated while verification is still in flight. Ranked match could start with inconsistent wallet state.

### H17. Empty Catch Blocks Hide Wallet Errors
- **File**: `apps/client/src/main.ts:449, 585, 1393-1414`
- **Issue**: Multiple `.catch(() => {})` patterns with no logging. Wallet operations fail silently with no user feedback.
- **Fix**: At minimum log errors; show user-facing error messages for critical wallet failures.

### H18. Lobby Buttons Stay Disabled After Failed Join
- **File**: `apps/client/src/main.ts:1347-1371`
- **Issue**: `setLobbyButtons(false)` called on join, but if join fails (room full/closed), buttons are never re-enabled. User must refresh.
- **Fix**: Add `finally(() => setLobbyButtons(true))` or re-enable on error response.

### H19. Missing Test for `settle_match()` Authorization
- **File**: `contracts/chickenz/src/test.rs`
- **Issue**: All tests use `mock_all_auths()`. No test verifies that settle_match is truly permissionless or that unauthorized admin operations fail.

### H20. Match Round Safety Cap Too Loose
- **File**: `services/server/src/GameRoom.ts:680`
- **Issue**: Safety cap is `currentRound >= totalRounds * 2` (e.g., 6 rounds for BO3). Could allow runaway matches.
- **Fix**: Tighten to `currentRound >= totalRounds + 2` or similar.

### H21. Proof Callback Double-Fire on Exception
- **File**: `services/server/src/prover.ts:310-324`
- **Issue**: If `onResult` callback throws in the first prover's success path, the `.catch()` block calls `onResult(null)` again. The `settled` flag prevents this in normal flow, but exception path bypasses it.

### H22. Transcript Data Parse Failure Silent
- **File**: `services/server/src/db.ts:392-416`
- **Issue**: `getTranscriptByMatchId()` returns null on JSON parse failure with no logging. Corrupted transcripts disappear silently.

---

## MEDIUM (35)

### M1. Profanity Filter Bypassable with Unicode
- `services/server/src/index.ts:543-565` — No Unicode normalization (NFKD) before checking. Combining characters bypass filter.

### M2. HTTP Rate Limiter Map Grows Unbounded
- `services/server/src/index.ts:595-619` — No max entries limit. Randomized IPs cause unbounded growth.

### M3. Input Tick Queue Saturation — Silent Drop
- `services/server/src/GameRoom.ts:230-235` — Cap of 120, but no client feedback when inputs are dropped. No validation that tick is within reasonable window of current tick.

### M4. Seed Commit Verification After Proof Verification
- `contracts/chickenz/src/lib.rs:290-293` — Seed commit checked AFTER verifier call. Should be before (defense in depth).

### M5. Journal Size Not Strictly Validated
- `services/prover/core/src/types.rs:245-259` — `from_journal_bytes()` checks `>=` instead of `==`. Extra bytes silently ignored.

### M6. PRNG Range Not Validated
- `services/prover/core/src/prng.rs:22` — No assertion that `max >= min`. Negative range produces invalid results.

### M7. AFK Detection Threshold Gameable
- `services/server/src/GameRoom.ts:604` — Only 5 input changes required. Never reset between rounds. Easily exceeded by scripted input.

### M8. ELO Floor at 0 Creates Rating Compression
- `services/server/src/db.ts:319` — Players who fall to 0 can't lose more. Creates rating floor that rewards heavy losing.

### M9. WASM State Free Not Atomic with Allocation
- `services/server/src/GameRoom.ts:436-443` — Old WASM freed before new allocation. If allocation fails, no recovery.

### M10. Splash Damage Division by Zero (Indirect)
- `services/prover/core/src/fp.rs:1052` — `max_dmg * dist / radius` — if `radius` is 0, panic. Currently hardcoded safe but fragile.

### M11. WASM Fixed-Point Round-Trip Precision Loss
- `services/prover/wasm/src/lib.rs:19-26` — `f64_to_fp()` uses `.round()` introducing +-0.5 unit errors per conversion.

### M12. Proof Timeout Closures Held 20 Minutes
- `services/server/src/prover.ts:286-298` — 20-minute timeout holds closure even after proof completes. Not cleaned up early.

### M13. Room Cleanup Holds Objects 2 Minutes After End
- `services/server/src/index.ts:433-441` — Room + WASM + transcripts held in memory for 120s. 100 concurrent games = ~100MB tail.

### M14. UUID Slicing Creates Collision Risk
- `services/server/src/db.ts:244-245`, `index.ts:176-182` — Match/room/tournament IDs use `UUID.slice(0,8)` (32 bits). Cross-region collision possible.

### M15. GameScene Event Listeners Never Cleaned Up
- `apps/client/src/scenes/GameScene.ts:642-647` — `visibilitychange`, `blur`, `focus` listeners added but never removed on scene transition. Stack on repeated enter/exit.

### M16. Keyboard Listeners Stack on Replay Mode Entry
- `apps/client/src/scenes/GameScene.ts:1308-1322` — Re-adds listeners without checking if already attached.

### M17. Missing Error State After Wallet Registration Failure
- `apps/client/src/main.ts:2694` — User sees "Registering wallet..." indefinitely if registration fails. No timeout or error display.

### M18. Leaderboard/History Fetch Race
- `apps/client/src/main.ts:1388-1431` — Double-clicking tab causes two fetches that overwrite each other.

### M19. Bot-vs-Bot Transcript Pruning Race
- `services/server/src/db.ts:465-476` — Pruning could run between `insertMatch()` and `markBotVsBot()`.

### M20. Settle Button Not Disabled During Settlement
- `apps/client/src/main.ts:2839-2884` — User can click "Settle" multiple times; no disabled state.

### M21. Tournament Bracket Bye + Disconnect Stall
- `services/server/src/TournamentRoom.ts:549-574` — If bye winner then disconnects, tournament can stall.

### M22. Dual Player Disconnect Winner Determination
- `services/server/src/GameRoom.ts:262-271` — If both disconnect simultaneously, first processed gets the loss. Ordering is arbitrary.

### M23. CORS Wallet Endpoints Missing Origin Check
- `services/server/src/index.ts:862, 914` — POST endpoints don't check Origin header. Possible CSRF.

### M24. Reconnect Logic Socket State Overlap
- `apps/client/src/net/NetworkManager.ts:102-110` — Old socket onclose could fire after new socket opens, suppressing reconnect notification.

### M25. Client Throttle Reset Race on Round Start
- `services/server/src/GameRoom.ts:429` — Server doesn't send explicit throttle reset. Client resets on `round_start` callback; network delay could cause first input to be throttled.

### M26. StartTxHash and SettleTxHash Update Order
- `services/server/src/index.ts:374, 424-427` — Multiple code paths can update these fields; no mutual exclusion.

### M27. Match Record Insert-Update Gap
- `services/server/src/index.ts:313-375` — Match inserted with initial values, then fields updated in subsequent statements. Crash between = incomplete record.

### M28. Unsafe `innerHTML +=` Pattern
- `apps/client/src/main.ts:2194` — While `escapeHtml()` is applied, the `+=` pattern on innerHTML is error-prone. One missed escape = XSS.

### M29. Upgrade Function Has No Timelock
- `contracts/chickenz/src/lib.rs:168-177` — Admin can upgrade contract WASM instantly. No multi-sig or delay.

### M30. Missing Test — Verifier Contract Failure
- `contracts/chickenz/src/test.rs` — No test for what happens if verifier panics or is unavailable.

### M31. Missing Test — Invalid Winner Boundary Values
- `contracts/chickenz/src/test.rs` — Only tests winner values 0, 1, 5, -1. Missing -2, 2, large values.

### M32. Missing Test — Game Hub Failure
- `contracts/chickenz/src/test.rs` — No test for `game_hub.end_game()` panic scenario.

### M33. Soroban SDK Version Not Pinned Exactly
- `contracts/chickenz/Cargo.toml` — Uses `"22.0.6"` (semver compatible) not `"=22.0.6"`.

### M34. RISC Zero SDK Version Loose
- `services/prover/host/Cargo.toml` — `risc0-zkvm = "3.0"` could pull breaking patch releases.

### M35. Serialized Data Missing Bounds Check
- `services/prover/core/src/fp.rs:1648-1687` — `run_streaming()` assumes minimum data size without asserting.

---

## LOW (15)

### L1. MatchId Uses Only 8 Hex Chars (32-bit collision space)
### L2. Wallet Token Uses UUID Instead of CSPRNG Bytes
### L3. Input aimX/aimY Type Not Strictly Validated
### L4. Bot Name Reuse Race (cosmetic)
### L5. Projectile ID Overflow (theoretical — i32 wrapping after 2^31 projectiles)
### L6. Console.warn for Missing HUD Camera
### L7. Magic Number 160ms Ping Threshold Not Imported from Constant
### L8. Settings Username Error Color State Corruption
### L9. ResizeObserver in buildTiledFrame Never Unobserved
### L10. Global Mutable State (26 mutable globals in main.ts)
### L11. Stale Closure in Region Dropdown Rendering
### L12. No Structured Logging (console.log throughout)
### L13. No Health Metrics on /api/status Endpoint
### L14. No Database Backup Configuration
### L15. Missing Version Field in Journal Format

---

## INFO (6)

### I1. Button Mask 0x1f Is Correct (covers all 5 buttons including Taunt)
### I2. Ranked Mode Properly Gates on walletVerified
### I3. ELO Farming Prevention (MIN_INPUT_CHANGES = 30) Working
### I4. Passkey WebAuthn Verification Implementation Sound
### I5. Mulberry32 PRNG Implementation Verified Correct
### I6. Fixed-Point Multiply Overflow Safe (uses i64 intermediate)

---

## Recommended Fix Priority

### Immediate (blocks production safety)
1. **C1** — Tournament disconnect during intro
2. **C2** — Division by zero in fp::div()
3. **C3** — Panic on invalid multi-round input
4. **C4/C5** — Integer overflow and bounds checks in prover
5. **H1/H2** — playerId validation on game/tournament input

### This Week
6. **H4** — Message size limit before JSON.parse
7. **H5** — DER signature bounds validation
8. **H6** — Token expiry check at use time
9. **H8** — Odd consolation player dropping
10. **H12** — Spectator cap
11. **H15** — Clear tournament animation timeouts
12. **H18** — Re-enable lobby buttons on join failure
13. **M1** — Unicode normalization in profanity filter
14. **M2** — Rate limiter max entries

### Next Sprint
15. **H10** — Server-side reconnection grace period
16. **H17** — Wallet error feedback
17. **M3** — Input tick window validation
18. **M14** — Use full UUIDs for IDs
19. **M15** — Clean up GameScene event listeners
20. **M20** — Disable settle button during settlement

### Backlog
- Test coverage improvements (H19, M30-M32)
- Dependency pinning (M33-M34)
- Structured logging (L12)
- Infrastructure monitoring (L13)
- Database backups (L14)
