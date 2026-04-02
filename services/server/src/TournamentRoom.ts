import type { ServerWebSocket } from "bun";
import { GameRoom, type SocketData } from "./GameRoom";
import { generateJoinCode, isValidBracketType, isValidMatchFormat } from "./protocol";
import type {
  BracketMatch,
  MatchSource,
  TournamentBracket,
  TournamentConfig,
  TournamentParticipant,
  BracketType,
  InputMessage,
} from "./protocol";

type GameSocket = ServerWebSocket<SocketData>;

const START_DELAY_MS = 3000;
const BETWEEN_MATCH_MS = 2000;
const MATCH_INTRO_MS = 3000; // time for bracket zoom + VS animation on client
const MAX_PLAYERS = 8;
const MAX_SPECTATORS = 5;

interface Participant {
  ws: GameSocket;
  name: string;
  role: "player" | "spectator";
}

// ── Bracket Generation ──────────────────────────────────────────

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Standard tournament seeding order for n slots (power of 2).
 * Returns pairs: [[seed1, seed2], [seed3, seed4], ...] arranged so
 * top seeds are spread across the bracket and meet latest. */
export function standardSeedOrder(n: number): [number, number][] {
  if (n === 1) return [[0, 1]];
  const prev = standardSeedOrder(n / 2);
  const pairs: [number, number][] = [];
  for (const [a, b] of prev) {
    pairs.push([a, 2 * n - 1 - a]);
    pairs.push([b, 2 * n - 1 - b]);
  }
  return pairs;
}

export function generateBracket(playerCount: number, bracketType: BracketType): BracketMatch[] {
  const n = nextPow2(playerCount);
  const _numByes = n - playerCount;
  const matches: BracketMatch[] = [];
  let matchIdx = 0;

  // ── Winners bracket ──────────────────────────────────────
  const seedPairs = standardSeedOrder(n / 2);
  const rounds = Math.log2(n);

  // Round 0: first round (may have byes)
  const r0Matches: number[] = []; // matchIndex for each R0 match
  for (const [seedA, seedB] of seedPairs) {
    const isByeA = seedA >= playerCount;
    const isByeB = seedB >= playerCount;
    const match: BracketMatch = {
      matchIndex: matchIdx,
      round: 0,
      bracketSide: "winners",
      label:
        rounds <= 1
          ? "Final"
          : rounds === 2
            ? `SF ${r0Matches.length + 1}`
            : rounds === 3
              ? `QF ${r0Matches.length + 1}`
              : `R1-${r0Matches.length + 1}`,
      sourceA: isByeA ? { type: "bye" } : { type: "seed", seed: seedA },
      sourceB: isByeB ? { type: "bye" } : { type: "seed", seed: seedB },
      status: "pending",
    };

    // Pre-fill players for seed sources
    if (!isByeA) match.playerA = { slot: seedA, name: "" }; // names filled later
    if (!isByeB) match.playerB = { slot: seedB, name: "" };

    // Handle bye: auto-advance
    if (isByeA && isByeB) {
      match.status = "bye";
    } else if (isByeA) {
      match.status = "bye";
      match.winner = seedB;
      match.loser = undefined;
    } else if (isByeB) {
      match.status = "bye";
      match.winner = seedA;
      match.loser = undefined;
    }

    matches.push(match);
    r0Matches.push(matchIdx);
    matchIdx++;
  }

  // Subsequent winners rounds
  let prevRoundMatches = r0Matches;
  for (let r = 1; r < rounds; r++) {
    const thisRoundMatches: number[] = [];
    const matchesInRound = prevRoundMatches.length / 2;
    for (let i = 0; i < matchesInRound; i++) {
      const mA = prevRoundMatches[i * 2]!;
      const mB = prevRoundMatches[i * 2 + 1]!;
      let label: string;
      if (r === rounds - 1) label = "Final";
      else if (r === rounds - 2) label = `SF ${i + 1}`;
      else label = `R${r + 1}-${i + 1}`;

      const match: BracketMatch = {
        matchIndex: matchIdx,
        round: r,
        bracketSide: r === rounds - 1 ? "final" : "winners",
        label,
        sourceA: { type: "winner", matchIndex: mA },
        sourceB: { type: "winner", matchIndex: mB },
        status: "pending",
      };
      matches.push(match);
      thisRoundMatches.push(matchIdx);
      matchIdx++;
    }
    prevRoundMatches = thisRoundMatches;
  }

  // ── Consolation matches ──────────────────────────────────
  if (bracketType === "partial_consolation" && rounds >= 2) {
    // 3rd place match: losers of the two semifinals
    // Find the two SF matches (round = rounds-2 in winners bracket)
    const sfMatches = matches.filter((m) => m.bracketSide === "winners" && m.round === rounds - 2);
    if (sfMatches.length === 2) {
      matches.push({
        matchIndex: matchIdx,
        round: rounds - 1,
        bracketSide: "third_place",
        label: "3rd Place",
        sourceA: { type: "loser", matchIndex: sfMatches[0]!.matchIndex },
        sourceB: { type: "loser", matchIndex: sfMatches[1]!.matchIndex },
        status: "pending",
      });
    }
  } else if (bracketType === "full_consolation" && playerCount > 2) {
    // Full consolation: every round's losers play consolation matches
    // to determine complete ranking of all players.
    //
    // Structure: for each winners round r (0 to rounds-2), losers from that
    // round enter a consolation "tier". Each tier plays down to one loser, and
    // tier losers play against each other for final rankings.
    //
    // Simplified approach: collect all losers from winners bracket by round,
    // then create consolation brackets for ranking.

    // For each winners round, collect the match indices whose losers enter consolation
    const losersByRound: number[][] = [];
    for (let r = 0; r < rounds; r++) {
      const roundMatches = matches.filter(
        (m) => (m.bracketSide === "winners" || m.bracketSide === "final") && m.round === r,
      );
      // Exclude bye-only matches
      const realMatches = roundMatches.filter((m) => m.status !== "bye" || m.loser !== undefined);
      if (realMatches.length > 0) {
        losersByRound.push(realMatches.map((m) => m.matchIndex));
      }
    }

    // Build consolation matches bottom-up
    // R0 losers play each other first
    if (losersByRound.length >= 2) {
      // First consolation round: R0 losers (QF losers in 8-player)
      const r0Losers = losersByRound[0]!;
      let prevConsolationMatches: number[] = [];

      if (r0Losers.length >= 2) {
        // Pair up R0 losers
        for (let i = 0; i < r0Losers.length; i += 2) {
          if (i + 1 < r0Losers.length) {
            matches.push({
              matchIndex: matchIdx,
              round: 0,
              bracketSide: "consolation",
              label: `C-R1-${prevConsolationMatches.length + 1}`,
              sourceA: { type: "loser", matchIndex: r0Losers[i]! },
              sourceB: { type: "loser", matchIndex: r0Losers[i + 1]! },
              status: "pending",
            });
            prevConsolationMatches.push(matchIdx);
            matchIdx++;
          }
        }
      }

      // For subsequent rounds, losers from winners bracket feed into consolation
      for (let r = 1; r < losersByRound.length; r++) {
        const roundLosers = losersByRound[r]!;
        const consolationInputs: MatchSource[] = [];

        // Winners of previous consolation round
        for (const mi of prevConsolationMatches) {
          consolationInputs.push({ type: "winner", matchIndex: mi });
        }
        // Losers from this winners round
        for (const mi of roundLosers) {
          consolationInputs.push({ type: "loser", matchIndex: mi });
        }

        // Pair them up (odd player gets a bye)
        const nextConsolationMatches: number[] = [];
        for (let i = 0; i < consolationInputs.length; i += 2) {
          if (i + 1 < consolationInputs.length) {
            const isLast = r === losersByRound.length - 1 && consolationInputs.length === 2;
            matches.push({
              matchIndex: matchIdx,
              round: r,
              bracketSide: isLast ? "third_place" : "consolation",
              label: isLast ? "3rd Place" : `C-R${r + 1}-${nextConsolationMatches.length + 1}`,
              sourceA: consolationInputs[i]!,
              sourceB: consolationInputs[i + 1]!,
              status: "pending",
            });
            nextConsolationMatches.push(matchIdx);
            matchIdx++;
          } else {
            // Odd player out — give them a bye
            matches.push({
              matchIndex: matchIdx,
              round: r,
              bracketSide: "consolation",
              label: `C-R${r + 1}-${nextConsolationMatches.length + 1}`,
              sourceA: consolationInputs[i]!,
              sourceB: { type: "bye" },
              status: "bye",
            });
            nextConsolationMatches.push(matchIdx);
            matchIdx++;
          }
        }
        prevConsolationMatches = nextConsolationMatches;
      }
    }
  }

  return matches;
}

// ── TournamentRoom ──────────────────────────────────────────────

export class TournamentRoom {
  readonly id: string;
  joinCode: string;
  private _status: "waiting" | "playing" | "ended" = "waiting";
  private participants: Participant[] = []; // index = slot
  private config: TournamentConfig;
  private hostSlot = 0; // slot index of host (creator)
  private bracket: BracketMatch[] = [];
  private seeds: number[] = []; // maps seed index → participant slot (after shuffle)
  private currentMatchIndex = -1;
  private activeGameRoom: GameRoom | null = null;
  private disconnected = new Set<number>(); // slot indices of disconnected participants
  private forfeitedSlots = new Set<number>(); // slots that forfeited (disconnected before their match)
  onEnded?: (sockets: GameSocket[]) => void;

  constructor(id: string, creator: GameSocket, config?: TournamentConfig) {
    this.id = id;
    this.joinCode = generateJoinCode();
    this.config = config ?? { bracketType: "partial_consolation", matchFormat: "bo5" };
    this.addParticipant(creator, "player");
    this.broadcastLobby();
  }

  get status() {
    return this._status;
  }
  /** Number of participants (players + spectators) still connected */
  get connectedCount() {
    return this.participants.filter((_, i) => !this.disconnected.has(i)).length;
  }
  get participantCount() {
    return this.participants.length;
  }

  // ── Public API ───────────────────────────────────────────────

  addPlayer(ws: GameSocket): boolean {
    if (this._status !== "waiting") return false;

    const playerRoleCount = this.participants.filter((p) => p.role === "player").length;
    const spectatorRoleCount = this.participants.filter((p) => p.role === "spectator").length;

    // Try to join as player, fall back to spectator
    let role: "player" | "spectator" = "player";
    if (playerRoleCount >= MAX_PLAYERS) {
      if (spectatorRoleCount >= MAX_SPECTATORS) return false;
      role = "spectator";
    }

    // Auto-generate username if missing
    if (!ws.data.username) {
      const a = String.fromCharCode(65 + Math.floor(Math.random() * 26));
      const b = String.fromCharCode(65 + Math.floor(Math.random() * 26));
      ws.data.username = `Chk${a}${b}`;
    }

    this.addParticipant(ws, role);
    this.broadcastLobby();
    return true;
  }

  toggleRole(ws: GameSocket): boolean {
    if (this._status !== "waiting") return false;
    const slot = this.findSlot(ws);
    if (slot === -1) return false;

    const p = this.participants[slot]!;
    if (p.role === "player") {
      // Switch to spectator
      const spectatorCount = this.participants.filter((pp) => pp.role === "spectator").length;
      if (spectatorCount >= MAX_SPECTATORS) return false;
      p.role = "spectator";
    } else {
      // Switch to player
      const playerCount = this.participants.filter((pp) => pp.role === "player").length;
      if (playerCount >= MAX_PLAYERS) return false;
      p.role = "player";
    }

    this.broadcastLobby();
    return true;
  }

  updateConfig(ws: GameSocket, partial: Partial<TournamentConfig>): boolean {
    if (this._status !== "waiting") return false;
    const slot = this.findSlot(ws);
    if (slot !== this.hostSlot) return false;

    let changed = false;
    if (partial.bracketType && isValidBracketType(partial.bracketType)) {
      this.config.bracketType = partial.bracketType;
      changed = true;
    }
    if (partial.matchFormat && isValidMatchFormat(partial.matchFormat)) {
      this.config.matchFormat = partial.matchFormat;
      changed = true;
    }

    if (changed) this.broadcastLobby();
    return changed;
  }

  startTournament(ws: GameSocket): boolean {
    if (this._status !== "waiting") return false;
    const slot = this.findSlot(ws);
    if (slot !== this.hostSlot) return false;

    const players = this.getPlayerSlots();
    if (players.length < 2) return false;

    this._status = "playing";

    // Shuffle seeds randomly
    this.seeds = [...players];
    for (let i = this.seeds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.seeds[i], this.seeds[j]] = [this.seeds[j]!, this.seeds[i]!];
    }

    // Generate bracket
    this.bracket = generateBracket(this.seeds.length, this.config.bracketType);

    // Fill in player names for seed sources
    for (const match of this.bracket) {
      this.resolveMatchPlayers(match);
    }

    // Resolve any byes that create chain reactions
    this.resolveByes();

    // Broadcast starting state then start first match
    this.broadcastLobby();
    setTimeout(() => {
      if (this._status === "playing") {
        this.advanceBracket();
      }
    }, START_DELAY_MS);

    return true;
  }

  handleDisconnect(ws: GameSocket) {
    const slot = this.findSlot(ws);
    if (slot === -1) return;

    if (this._status === "waiting") {
      // Remove participant and compact
      this.participants.splice(slot, 1);
      // Update host slot if needed
      if (slot < this.hostSlot) this.hostSlot--;
      else if (slot === this.hostSlot) this.hostSlot = 0;
      this.broadcastLobby();
      return;
    }

    // Mark as disconnected
    this.disconnected.add(slot);

    // Clean up spectator socket if present in active game
    if (this.activeGameRoom) {
      this.activeGameRoom.removeSpectator(ws);
    }

    // If this is a player (not spectator), mark as forfeited
    const p = this.participants[slot];
    if (p && p.role === "player") {
      this.forfeitedSlots.add(slot);
    }

    // If currently fighting, forfeit the active match
    if (this.activeGameRoom && this._status === "playing") {
      const fighters = this.getCurrentFighterSlots();
      if (fighters) {
        const fighterIdx = fighters.indexOf(slot);
        if (fighterIdx !== -1) {
          this.activeGameRoom.handleDisconnect(fighterIdx);
        }
      }
    }
  }

  handleInput(ws: GameSocket, msg: InputMessage) {
    if (!this.activeGameRoom) return;
    const fighters = this.getCurrentFighterSlots();
    if (!fighters) return;
    const slot = this.findSlot(ws);
    if (!fighters.includes(slot)) return;
    const playerId = ws.data.playerId;
    if (playerId !== 0 && playerId !== 1) return;
    this.activeGameRoom.handleInput(playerId, msg);
  }

  isSocketInTournament(ws: GameSocket): boolean {
    return this.findSlot(ws) !== -1;
  }

  getConfig(): TournamentConfig {
    return { ...this.config };
  }

  // ── Private helpers ────────────────────────────────────────

  private addParticipant(ws: GameSocket, role: "player" | "spectator") {
    if (!ws.data.username) {
      const a = String.fromCharCode(65 + Math.floor(Math.random() * 26));
      const b = String.fromCharCode(65 + Math.floor(Math.random() * 26));
      ws.data.username = `Chk${a}${b}`;
    }
    this.participants.push({ ws, name: ws.data.username, role });
  }

  private findSlot(ws: GameSocket): number {
    return this.participants.findIndex((p) => p.ws === ws);
  }

  private getPlayerSlots(): number[] {
    return this.participants
      .map((p, i) => ({ ...p, slot: i }))
      .filter((p) => p.role === "player")
      .map((p) => p.slot);
  }

  /** Map a seed index to the actual participant slot */
  private seedToSlot(seed: number): number {
    return this.seeds[seed] ?? -1;
  }

  private resolveMatchPlayers(match: BracketMatch) {
    match.playerA = this.resolveSource(match.sourceA);
    match.playerB = this.resolveSource(match.sourceB);

    // Check if both players are resolved and match can be made ready
    if (match.status === "pending" && match.playerA && match.playerB) {
      match.status = "ready";
    }
  }

  private resolveSource(source: MatchSource): { slot: number; name: string } | null {
    if (source.type === "seed") {
      const slot = this.seedToSlot(source.seed);
      if (slot === -1) return null;
      return { slot, name: this.participants[slot]?.name || "???" };
    }
    if (source.type === "bye") return null;
    // Winner/loser of another match
    const srcMatch = this.bracket.find((m) => m.matchIndex === source.matchIndex);
    if (!srcMatch || (srcMatch.status !== "done" && srcMatch.status !== "bye")) return null;
    const resultSlot = source.type === "winner" ? srcMatch.winner : srcMatch.loser;
    if (resultSlot === undefined || resultSlot === -1) return null;
    return { slot: resultSlot, name: this.participants[resultSlot]?.name || "???" };
  }

  private resolveByes() {
    // Iterate until no more auto-advances happen
    let changed = true;
    while (changed) {
      changed = false;
      for (const match of this.bracket) {
        if (match.status !== "pending") continue;
        this.resolveMatchPlayers(match);

        // Check if one or both sources are from a bye match with no loser (single bye)
        const srcA = this.resolveSource(match.sourceA);
        const srcB = this.resolveSource(match.sourceB);

        if (srcA && !srcB && this.isSourceResolved(match.sourceB)) {
          // B source is resolved but null (came from bye with no opponent) → A auto-advances
          match.playerA = srcA;
          match.status = "bye";
          match.winner = srcA.slot;
          changed = true;
        } else if (!srcA && srcB && this.isSourceResolved(match.sourceA)) {
          match.playerB = srcB;
          match.status = "bye";
          match.winner = srcB.slot;
          changed = true;
        } else if (srcA && srcB) {
          match.playerA = srcA;
          match.playerB = srcB;
          match.status = "ready";
        }
      }
    }
  }

  /** Check if a source's prerequisite match is done (or is a bye/seed) */
  private isSourceResolved(source: MatchSource): boolean {
    if (source.type === "seed" || source.type === "bye") return true;
    const srcMatch = this.bracket.find((m) => m.matchIndex === source.matchIndex);
    return srcMatch?.status === "done" || srcMatch?.status === "bye";
  }

  private getCurrentFighterSlots(): [number, number] | null {
    if (this.currentMatchIndex < 0) return null;
    const match = this.bracket.find((m) => m.matchIndex === this.currentMatchIndex);
    if (!match?.playerA || !match?.playerB) return null;
    return [match.playerA.slot, match.playerB.slot];
  }

  private getRoundsConfig(): { totalRounds: number; winsNeeded: number } {
    return this.config.matchFormat === "bo3" ? { totalRounds: 3, winsNeeded: 2 } : { totalRounds: 5, winsNeeded: 3 };
  }

  /** Find the next ready match and start it */
  private advanceBracket() {
    // Re-resolve all pending matches
    this.resolveByes();
    for (const match of this.bracket) {
      if (match.status === "pending") {
        this.resolveMatchPlayers(match);
      }
    }

    // Handle forfeit resolution: if a ready match has a forfeited player, auto-advance
    for (const match of this.bracket) {
      if (match.status !== "ready") continue;
      const slotA = match.playerA!.slot;
      const slotB = match.playerB!.slot;
      const aForfeited = this.forfeitedSlots.has(slotA);
      const bForfeited = this.forfeitedSlots.has(slotB);

      if (aForfeited || bForfeited) {
        if (aForfeited && bForfeited) {
          match.winner = slotA; // arbitrary
          match.loser = slotB;
          // Both forfeited — loser is also forfeited, cascades
          this.forfeitedSlots.add(slotB);
        } else if (aForfeited) {
          match.winner = slotB;
          match.loser = slotA;
        } else {
          match.winner = slotA;
          match.loser = slotB;
        }
        match.status = "done";
        match.scores = [0, 0];
        this.broadcastMatchEnd(match);
      }
    }

    // Find next ready match
    const nextMatch = this.bracket.find((m) => m.status === "ready");
    if (!nextMatch) {
      // Check if all matches are done
      const allDone = this.bracket.every((m) => m.status === "done" || m.status === "bye");
      if (allDone) {
        this.endTournament();
      }
      return;
    }

    this.startMatch(nextMatch);
  }

  private startMatch(match: BracketMatch) {
    this.currentMatchIndex = match.matchIndex;
    match.status = "playing";

    const slotA = match.playerA!.slot;
    const slotB = match.playerB!.slot;
    const wsA = this.participants[slotA]!.ws;
    const wsB = this.participants[slotB]!.ws;
    const usernames: [string, string] = [this.participants[slotA]!.name, this.participants[slotB]!.name];

    const roundsCfg = this.getRoundsConfig();
    const roomId = `tourney-${this.id}-m${match.matchIndex}`;

    // Pre-generate game params so client and server use the same values
    const seed = Date.now() >>> 0;
    const mapIndex = Math.floor(Math.random() * 4);
    const NUM_CHARS = 4;
    const c1 = Math.floor(Math.random() * NUM_CHARS);
    let c2 = Math.floor(Math.random() * (NUM_CHARS - 1));
    if (c2 >= c1) c2++;
    const characters: [number, number] = [c1, c2];

    // Send tournament_match_start to all participants FIRST (client plays intro animation)
    const bracketState = this.getBracketState();
    for (let i = 0; i < this.participants.length; i++) {
      if (this.disconnected.has(i)) continue;
      const ws = this.participants[i]!.ws;
      const isFighter = i === slotA || i === slotB;
      this.send(ws, {
        type: "tournament_match_start",
        matchLabel: match.label,
        matchIndex: match.matchIndex,
        role: isFighter ? "fighter" : "spectator",
        playerId: isFighter ? (i === slotA ? 0 : 1) : undefined,
        seed,
        usernames,
        mapIndex,
        totalRounds: roundsCfg.totalRounds,
        characters,
        bracket: bracketState,
      });
    }

    // Delay GameRoom creation so client intro animation plays first
    setTimeout(() => {
      if (this._status !== "playing") return;

      // If either fighter disconnected during intro animation, forfeit
      const aDisconnected = this.disconnected.has(slotA);
      const bDisconnected = this.disconnected.has(slotB);
      if (aDisconnected || bDisconnected) {
        const winnerSlot = aDisconnected ? slotB : slotA;
        const loserSlot = aDisconnected ? slotA : slotB;
        match.winner = winnerSlot;
        match.loser = loserSlot;
        match.status = "done";
        this.broadcastMatchEnd(match);
        setTimeout(() => this.advanceBracket(), BETWEEN_MATCH_MS);
        return;
      }

      wsA.data.roomId = roomId;
      wsA.data.playerId = 0;
      wsB.data.roomId = roomId;
      wsB.data.playerId = 1;

      const gameParams = { seed, mapIndex, characters };
      const room = new GameRoom(roomId, match.label, wsA, true, "casual", true, roundsCfg, gameParams);
      room.addPlayer(wsB);

      // Spectators: everyone except the two fighters
      for (let i = 0; i < this.participants.length; i++) {
        if (i !== slotA && i !== slotB && !this.disconnected.has(i)) {
          room.addSpectator(this.participants[i]!.ws);
        }
      }

      room.onEnded = (_sockets, winner) => {
        const winnerSlot = winner === 0 ? slotA : slotB;
        const loserSlot = winner === 0 ? slotB : slotA;
        match.winner = winnerSlot;
        match.loser = loserSlot;
        match.status = "done";
        this.activeGameRoom = null;

        wsA.data.roomId = null;
        wsA.data.playerId = -1;
        wsB.data.roomId = null;
        wsB.data.playerId = -1;

        this.broadcastMatchEnd(match);
        setTimeout(() => this.advanceBracket(), BETWEEN_MATCH_MS);
      };

      this.activeGameRoom = room;
    }, MATCH_INTRO_MS);
  }

  private broadcastMatchEnd(match: BracketMatch) {
    const winnerName = match.winner !== undefined ? this.participants[match.winner]?.name || "???" : "???";
    this.broadcastAll({
      type: "tournament_match_end",
      matchIndex: match.matchIndex,
      matchLabel: match.label,
      winnerName,
      bracket: this.getBracketState(),
    });
  }

  private endTournament() {
    this._status = "ended";
    const standings = this.computeStandings();
    this.broadcastAll({
      type: "tournament_end",
      standings,
      bracket: this.getBracketState(),
    });

    setTimeout(() => {
      const activeSockets = this.participants.filter((_, i) => !this.disconnected.has(i)).map((p) => p.ws);
      for (const ws of activeSockets) {
        ws.data.roomId = null;
        ws.data.playerId = -1;
      }
      this.onEnded?.(activeSockets);
    }, 2000);
  }

  private computeStandings(): { place: number; name: string }[] {
    const finalMatch =
      this.bracket.find((m) => m.bracketSide === "final") ??
      this.bracket.filter((m) => m.bracketSide === "winners").sort((a, b) => b.round - a.round)[0];

    const standings: { place: number; name: string }[] = [];
    const placed = new Set<number>();

    const add = (place: number, slot: number | undefined) => {
      if (slot === undefined || placed.has(slot)) return;
      standings.push({ place, name: this.participants[slot]?.name || "???" });
      placed.add(slot);
    };

    // 1st & 2nd: final match
    add(1, finalMatch?.winner);
    add(2, finalMatch?.loser);

    if (this.config.bracketType === "full_consolation") {
      // Full consolation: 3rd place match determines 3rd/4th, then consolation
      // results determine all remaining positions
      const thirdPlaceMatch = this.bracket.find((m) => m.bracketSide === "third_place");
      add(3, thirdPlaceMatch?.winner);
      add(4, thirdPlaceMatch?.loser);

      // Rank remaining by consolation results (highest round = eliminated later = better rank)
      const consolationMatches = this.bracket
        .filter((m) => m.bracketSide === "consolation")
        .sort((a, b) => b.round - a.round);
      for (const m of consolationMatches) {
        add(standings.length + 1, m.loser);
      }
      for (const m of consolationMatches) {
        add(standings.length + 1, m.winner);
      }
    } else if (this.config.bracketType === "partial_consolation") {
      // 3rd place match determines 3rd/4th; QF losers are joint 5th
      const thirdPlaceMatch = this.bracket.find((m) => m.bracketSide === "third_place");
      add(3, thirdPlaceMatch?.winner);
      add(4, thirdPlaceMatch?.loser);

      // Remaining players (QF losers etc.) are all joint 5th
      const playerSlots = this.getPlayerSlots();
      for (const slot of playerSlots) {
        add(5, slot);
      }
    } else {
      // Winners only: SF losers are joint 3rd, QF losers are joint 5th
      // Group unplaced players by the round they lost in (higher round = better rank)
      const winnersMatches = this.bracket
        .filter((m) => m.bracketSide === "winners" && m.status === "done")
        .sort((a, b) => b.round - a.round);

      // SF losers → joint 3rd
      const maxRound = finalMatch?.round ?? 0;
      for (const m of winnersMatches) {
        if (m.round === maxRound - 1 && m.loser !== undefined && !placed.has(m.loser)) {
          add(3, m.loser);
        }
      }
      // Earlier round losers → joint 5th, 7th, etc.
      let nextPlace = standings.length + 1;
      for (let r = maxRound - 2; r >= 0; r--) {
        const roundLosers = winnersMatches.filter((m) => m.round === r);
        for (const m of roundLosers) {
          add(nextPlace, m.loser);
        }
        if (roundLosers.length > 0) nextPlace = standings.length + 1;
      }
    }

    // Catch any remaining unplaced players
    const playerSlots = this.getPlayerSlots();
    for (const slot of playerSlots) {
      add(standings.length + 1, slot);
    }

    return standings;
  }

  private getBracketState(): TournamentBracket {
    return {
      matches: this.bracket.map((m) => ({ ...m })),
      playerNames: this.participants.map((p) => p.name),
      config: { ...this.config },
    };
  }

  private broadcastLobby() {
    const participants: TournamentParticipant[] = this.participants.map((p, i) => ({
      slot: i,
      name: p.name,
      role: p.role,
      connected: !this.disconnected.has(i),
    }));

    const bracket = this._status !== "waiting" ? this.getBracketState() : undefined;

    for (let i = 0; i < this.participants.length; i++) {
      if (this.disconnected.has(i)) continue;
      const msg: Record<string, unknown> = {
        type: "tournament_lobby",
        tournamentId: this.id,
        joinCode: this.joinCode,
        participants,
        config: this.config,
        hostSlot: this.hostSlot,
        mySlot: i,
        status: this._status,
      };
      if (bracket) {
        msg.bracket = bracket;
      }
      this.send(this.participants[i]!.ws, msg);
    }
  }

  private broadcastAll(msg: object) {
    const json = JSON.stringify(msg);
    for (let i = 0; i < this.participants.length; i++) {
      if (this.disconnected.has(i)) continue;
      try {
        this.participants[i]!.ws.send(json);
      } catch {
        // socket closed
      }
    }
  }

  private send(ws: GameSocket, msg: object) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket closed
    }
  }
}
