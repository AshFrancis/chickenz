import type { ServerWebSocket } from "bun";
import { GameRoom, type SocketData } from "./GameRoom";
import { generateJoinCode } from "./protocol";
import type { TournamentBracket, TournamentMatchResult } from "./protocol";

type GameSocket = ServerWebSocket<SocketData>;

const MATCH_LABELS = ["Semi-Final 1", "Semi-Final 2", "Winners Final", "Losers Final"];
// Match schedule: [slotA, slotB] — indices into this.sockets[]
// For matches 2 & 3, slots are resolved dynamically from winners/losers
const SEMI_SLOTS: [number, number][] = [[0, 1], [2, 3]];

const NUM_CHARACTERS = 4;
const START_DELAY_MS = 3000;
const BETWEEN_MATCH_MS = 5000;

export class TournamentRoom {
  readonly id: string;
  readonly joinCode: string;
  private _status: "waiting" | "playing" | "ended" = "waiting";
  private sockets: GameSocket[] = [];
  private playerNames: string[] = [];
  private bracket: TournamentMatchResult[] = [];
  private currentMatchIndex = -1;
  private activeGameRoom: GameRoom | null = null;
  private disconnected = new Set<number>(); // slot indices of disconnected players
  onEnded?: (sockets: GameSocket[]) => void;

  constructor(id: string, creator: GameSocket) {
    this.id = id;
    this.joinCode = generateJoinCode();
    this.addPlayer(creator);
  }

  get status() { return this._status; }
  get playerCount() { return this.sockets.length; }

  addPlayer(ws: GameSocket): boolean {
    if (this._status !== "waiting") return false;
    if (this.sockets.length >= 4) return false;

    // Auto-generate username if missing
    if (!ws.data.username) {
      const a = String.fromCharCode(65 + Math.floor(Math.random() * 26));
      const b = String.fromCharCode(65 + Math.floor(Math.random() * 26));
      ws.data.username = `Chk${a}${b}`;
    }

    this.sockets.push(ws);
    this.playerNames.push(ws.data.username);

    this.broadcastLobby();

    if (this.sockets.length === 4) {
      setTimeout(() => {
        if (this._status === "waiting" && this.sockets.length === 4) {
          this._status = "playing";
          this.initBracket();
          this.startNextMatch();
        }
      }, START_DELAY_MS);
    }

    return true;
  }

  handleDisconnect(ws: GameSocket) {
    const slotIndex = this.sockets.indexOf(ws);
    if (slotIndex === -1) return;

    if (this._status === "waiting") {
      this.sockets.splice(slotIndex, 1);
      this.playerNames.splice(slotIndex, 1);
      this.broadcastLobby();
      return;
    }

    // Mark as disconnected
    this.disconnected.add(slotIndex);

    // If currently fighting, forfeit
    if (this.activeGameRoom && this._status === "playing") {
      const fighters = this.getCurrentFighterSlots();
      if (fighters) {
        const fighterIdx = fighters.indexOf(slotIndex);
        if (fighterIdx !== -1) {
          // Forfeit: other fighter wins
          const winnerId = fighterIdx === 0 ? 1 : 0;
          this.activeGameRoom.handleDisconnect(fighterIdx);
        }
      }
    }
  }

  handleInput(ws: GameSocket, msg: any) {
    if (!this.activeGameRoom) return;
    // Only allow fighters (not spectators) to send input
    const fighters = this.getCurrentFighterSlots();
    if (!fighters) return;
    const slotIndex = this.sockets.indexOf(ws);
    if (!fighters.includes(slotIndex)) return;
    const playerId = ws.data.playerId;
    if (playerId !== 0 && playerId !== 1) return;
    this.activeGameRoom.handleInput(playerId, msg);
  }

  isSocketInTournament(ws: GameSocket): boolean {
    return this.sockets.includes(ws);
  }

  // ── Private ──────────────────────────────────────────────

  private initBracket() {
    this.bracket = MATCH_LABELS.map((label, i) => ({
      matchIndex: i,
      matchLabel: label,
      winnerSlot: -1,
      loserSlot: -1,
    }));
  }

  private getCurrentFighterSlots(): [number, number] | null {
    const mi = this.currentMatchIndex;
    if (mi < 0 || mi > 3) return null;
    if (mi < 2) return SEMI_SLOTS[mi]!;
    if (mi === 2) {
      const w0 = this.bracket[0]!.winnerSlot;
      const w1 = this.bracket[1]!.winnerSlot;
      if (w0 === -1 || w1 === -1) return null;
      return [w0, w1];
    }
    // mi === 3: losers final
    const l0 = this.bracket[0]!.loserSlot;
    const l1 = this.bracket[1]!.loserSlot;
    if (l0 === -1 || l1 === -1) return null;
    return [l0, l1];
  }

  private startNextMatch() {
    this.currentMatchIndex++;
    if (this.currentMatchIndex >= 4) {
      this.endTournament();
      return;
    }

    const fighters = this.getCurrentFighterSlots();
    if (!fighters) {
      // Shouldn't happen, but skip
      this.startNextMatch();
      return;
    }

    const [slotA, slotB] = fighters;

    // Check for auto-forfeit (disconnected player)
    const aDisconnected = this.disconnected.has(slotA);
    const bDisconnected = this.disconnected.has(slotB);
    if (aDisconnected || bDisconnected) {
      const winnerSlot = aDisconnected ? slotB : slotA;
      const loserSlot = aDisconnected ? slotA : slotB;
      if (aDisconnected && bDisconnected) {
        // Both disconnected — pick slotA as arbitrary winner
        this.recordMatchResult(slotA, slotB);
      } else {
        this.recordMatchResult(winnerSlot, loserSlot);
      }
      this.broadcastMatchEnd();
      setTimeout(() => this.startNextMatch(), BETWEEN_MATCH_MS);
      return;
    }

    const wsA = this.sockets[slotA]!;
    const wsB = this.sockets[slotB]!;

    const usernames: [string, string] = [
      this.playerNames[slotA] || "",
      this.playerNames[slotB] || "",
    ];
    const matchLabel = MATCH_LABELS[this.currentMatchIndex]!;

    // Create a GameRoom for the two fighters
    // GameRoom generates its own seed, map, and characters internally
    const roomId = `tourney-${this.id}-m${this.currentMatchIndex}`;
    wsA.data.roomId = roomId;
    wsA.data.playerId = 0;
    wsB.data.roomId = roomId;
    wsB.data.playerId = 1;

    const room = new GameRoom(roomId, matchLabel, wsA, true, "casual");
    room.addPlayer(wsB);

    // Read back the actual values GameRoom chose
    const seed = room.currentSeed;
    const mapIndex = room.currentMapIndex;
    const characters = room.characters;

    // Set spectators
    const spectators: GameSocket[] = [];
    for (let i = 0; i < this.sockets.length; i++) {
      if (i !== slotA && i !== slotB && !this.disconnected.has(i)) {
        spectators.push(this.sockets[i]!);
      }
    }
    room.spectatorSockets = spectators;

    // Hook into match end
    room.onEnded = (_sockets, winner, _roomId) => {
      const winnerSlot = winner === 0 ? slotA : slotB;
      const loserSlot = winner === 0 ? slotB : slotA;
      this.recordMatchResult(winnerSlot, loserSlot);
      this.activeGameRoom = null;

      // Clear fighter room associations
      wsA.data.roomId = null;
      wsA.data.playerId = -1;
      wsB.data.roomId = null;
      wsB.data.playerId = -1;

      this.broadcastMatchEnd();
      setTimeout(() => this.startNextMatch(), BETWEEN_MATCH_MS);
    };

    this.activeGameRoom = room;

    // Send tournament_match_start to all 4 players
    for (let i = 0; i < this.sockets.length; i++) {
      if (this.disconnected.has(i)) continue;
      const ws = this.sockets[i]!;
      const isFighter = i === slotA || i === slotB;
      const msg = {
        type: "tournament_match_start",
        matchLabel,
        matchIndex: this.currentMatchIndex,
        role: isFighter ? "fighter" : "spectator",
        playerId: isFighter ? (i === slotA ? 0 : 1) : undefined,
        seed,
        usernames,
        mapIndex,
        totalRounds: 3,
        characters,
      };
      this.send(ws, msg);
    }
  }

  private recordMatchResult(winnerSlot: number, loserSlot: number) {
    const result = this.bracket[this.currentMatchIndex];
    if (result) {
      result.winnerSlot = winnerSlot;
      result.loserSlot = loserSlot;
    }
  }

  private broadcastMatchEnd() {
    const result = this.bracket[this.currentMatchIndex];
    if (!result) return;
    const winnerName = this.playerNames[result.winnerSlot] || "???";
    const msg = {
      type: "tournament_match_end",
      matchIndex: this.currentMatchIndex,
      matchLabel: result.matchLabel,
      winnerName,
      bracket: this.getBracket(),
    };
    this.broadcastAll(msg);
  }

  private endTournament() {
    this._status = "ended";

    // Compute standings: 1st = winner of match 2, 2nd = loser of match 2,
    // 3rd = winner of match 3, 4th = loser of match 3
    const standings: string[] = [];
    const m2 = this.bracket[2];
    const m3 = this.bracket[3];
    standings.push(this.playerNames[m2?.winnerSlot ?? 0] || "???"); // 1st
    standings.push(this.playerNames[m2?.loserSlot ?? 0] || "???");  // 2nd
    standings.push(this.playerNames[m3?.winnerSlot ?? 0] || "???"); // 3rd
    standings.push(this.playerNames[m3?.loserSlot ?? 0] || "???");  // 4th

    const msg = {
      type: "tournament_end",
      standings,
      bracket: this.getBracket(),
    };
    this.broadcastAll(msg);

    // Return sockets to lobby after a delay
    setTimeout(() => {
      const activeSockets = this.sockets.filter((_, i) => !this.disconnected.has(i));
      for (const ws of activeSockets) {
        ws.data.roomId = null;
        ws.data.playerId = -1;
      }
      this.onEnded?.(activeSockets);
    }, 2000);
  }

  private getBracket(): TournamentBracket {
    return {
      matches: [...this.bracket],
      playerNames: [...this.playerNames],
    };
  }

  private broadcastLobby() {
    const msg = {
      type: "tournament_lobby",
      tournamentId: this.id,
      joinCode: this.joinCode,
      players: this.playerNames,
      status: this._status,
    };
    this.broadcastAll(msg);
  }

  private broadcastAll(msg: object) {
    const json = JSON.stringify(msg);
    for (let i = 0; i < this.sockets.length; i++) {
      if (this.disconnected.has(i)) continue;
      try {
        this.sockets[i]!.send(json);
      } catch {
        // socket already closed
      }
    }
  }

  private send(ws: GameSocket, msg: object) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket already closed
    }
  }
}
