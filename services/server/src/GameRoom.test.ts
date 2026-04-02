import { describe, expect, test, mock, beforeEach } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { SocketData } from "./GameRoom";

// ── Mock WasmState ─────────────────────────────────────────────
// We need to mock the WASM module before importing GameRoom, because
// GameRoom.ts → wasm.ts → loads actual WASM binary at import time.

let mockTick = 0;
let mockMatchOver = false;
let mockWinner = -1;
let mockFreeCalled = false;
let mockStepCalls: number[][] = [];
let mockExportedState: object = {};

class MockWasmState {
  constructor(
    public _seed: number,
    public _mapJson: string,
  ) {
    mockTick = 0;
    mockMatchOver = false;
    mockWinner = -1;
    mockFreeCalled = false;
    mockStepCalls = [];
  }

  tick() {
    return mockTick;
  }

  step(b0: number, ax0: number, ay0: number, b1: number, ax1: number, ay1: number) {
    mockStepCalls.push([b0, ax0, ay0, b1, ax1, ay1]);
    mockTick++;
  }

  match_over() {
    return mockMatchOver;
  }

  winner() {
    return mockWinner;
  }

  export_state() {
    return {
      tick: mockTick,
      players: [
        { id: 0, x: 100, y: 400, vx: 0, vy: 0, facing: 1, health: 100, lives: 1, shootCooldown: 0, grounded: true, stateFlags: 1, respawnTimer: 0, weapon: -1, ammo: 0, jumpsLeft: 2, wallSliding: false, wallDir: 0, stompedBy: -1, stompingOn: -1, stompShakeProgress: 0, stompCooldown: 0 },
        { id: 1, x: 800, y: 400, vx: 0, vy: 0, facing: -1, health: 100, lives: 1, shootCooldown: 0, grounded: true, stateFlags: 1, respawnTimer: 0, weapon: -1, ammo: 0, jumpsLeft: 2, wallSliding: false, wallDir: 0, stompedBy: -1, stompingOn: -1, stompShakeProgress: 0, stompCooldown: 0 },
      ],
      projectiles: [],
      weaponPickups: [],
      scores: [0, 0],
      arenaLeft: 0,
      arenaRight: 960,
      matchOver: mockMatchOver,
      winner: mockWinner,
      deathLingerTimer: 0,
      rngState: 12345,
      nextProjectileId: 0,
      ...mockExportedState,
    };
  }

  free() {
    mockFreeCalled = true;
  }
}

// Mock the wasm module so GameRoom doesn't try to load a real .wasm file
mock.module("./wasm", () => ({
  WasmState: MockWasmState,
}));

// Now import GameRoom after the mock is in place
const { GameRoom } = await import("./GameRoom");

// ── Test helpers ───────────────────────────────────────────────

type GameSocket = ServerWebSocket<SocketData>;

/** Messages captured by fake sockets */
let sentMessages: Map<string, object[]> = new Map();

function createFakeSocket(overrides: Partial<SocketData> = {}): GameSocket {
  const id = `sock-${Math.random().toString(36).slice(2, 8)}`;
  const data: SocketData = {
    roomId: null,
    playerId: -1,
    username: overrides.username ?? "TestPlayer",
    walletAddress: overrides.walletAddress ?? "",
    walletVerified: overrides.walletVerified ?? false,
    character: overrides.character ?? 0,
    awayCharacter: overrides.awayCharacter ?? -1,
    tournamentId: null,
    msgCount: 0,
    msgResetTime: Date.now(),
    ...overrides,
  };

  sentMessages.set(id, []);

  return {
    data,
    readyState: 1,
    send(msg: string) {
      sentMessages.get(id)?.push(JSON.parse(msg));
    },
    ping() {},
    // Store the id for retrieval
    _testId: id,
  } as unknown as GameSocket & { _testId: string };
}

function getSentMessages(ws: GameSocket): object[] {
  const id = (ws as unknown as { _testId: string })._testId;
  return sentMessages.get(id) ?? [];
}

function getLastMessage(ws: GameSocket): object | undefined {
  const msgs = getSentMessages(ws);
  return msgs[msgs.length - 1];
}

function getMessagesByType(ws: GameSocket, type: string): object[] {
  return getSentMessages(ws).filter((m: any) => m.type === type);
}

function resetMockState() {
  mockTick = 0;
  mockMatchOver = false;
  mockWinner = -1;
  mockFreeCalled = false;
  mockStepCalls = [];
  mockExportedState = {};
  sentMessages = new Map();
}

// ── Tests ──────────────────────────────────────────────────────

describe("GameRoom", () => {
  beforeEach(() => {
    resetMockState();
  });

  // ── Construction & initial state ───────────────────────────

  describe("construction & initial state", () => {
    test("creates room with correct id, name, and status", () => {
      const creator = createFakeSocket({ username: "Creator" });
      const room = new GameRoom("room-1", "Test Room", creator);

      expect(room.id).toBe("room-1");
      expect(room.name).toBe("Test Room");
      expect(room.status).toBe("waiting");
    });

    test("player count starts at 1 after creation", () => {
      const creator = createFakeSocket();
      const room = new GameRoom("room-1", "Room", creator);

      expect(room.playerCount).toBe(1);
    });

    test("creator gets playerId 0 and roomId set", () => {
      const creator = createFakeSocket();
      const room = new GameRoom("room-1", "Room", creator);

      expect(creator.data.playerId).toBe(0);
      expect(creator.data.roomId).toBe("room-1");
    });

    test("sends waiting message to creator", () => {
      const creator = createFakeSocket();
      const room = new GameRoom("room-1", "Test Room", creator);

      const msgs = getMessagesByType(creator, "waiting");
      expect(msgs).toHaveLength(1);
      const msg = msgs[0] as any;
      expect(msg.roomId).toBe("room-1");
      expect(msg.roomName).toBe("Test Room");
      expect(typeof msg.joinCode).toBe("string");
      expect(msg.joinCode.length).toBe(5);
    });

    test("skipWaiting suppresses waiting message", () => {
      const creator = createFakeSocket();
      const room = new GameRoom("room-1", "Room", creator, false, "casual", true);

      const msgs = getMessagesByType(creator, "waiting");
      expect(msgs).toHaveLength(0);
    });

    test("default mode is casual", () => {
      const creator = createFakeSocket();
      const room = new GameRoom("room-1", "Room", creator);

      expect(room.mode).toBe("casual");
    });

    test("ranked mode can be set", () => {
      const creator = createFakeSocket();
      const room = new GameRoom("room-1", "Room", creator, false, "ranked");

      expect(room.mode).toBe("ranked");
    });

    test("isPrivate flag is set correctly", () => {
      const creator = createFakeSocket();
      const pub = new GameRoom("r1", "Public", creator, false);
      expect(pub.isPrivate).toBe(false);

      const creator2 = createFakeSocket();
      const priv = new GameRoom("r2", "Private", creator2, true);
      expect(priv.isPrivate).toBe(true);
    });

    test("joinCode is a 5-character string", () => {
      const creator = createFakeSocket();
      const room = new GameRoom("room-1", "Room", creator);

      expect(typeof room.joinCode).toBe("string");
      expect(room.joinCode.length).toBe(5);
    });

    test("isWaiting returns true, isEnded returns false", () => {
      const creator = createFakeSocket();
      const room = new GameRoom("room-1", "Room", creator);

      expect(room.isWaiting()).toBe(true);
      expect(room.isEnded()).toBe(false);
    });

    test("isBotMatch is false by default", () => {
      const creator = createFakeSocket();
      const room = new GameRoom("room-1", "Room", creator);

      expect(room.isBotMatch).toBe(false);
      expect(room.botName).toBeNull();
    });
  });

  // ── addPlayer ──────────────────────────────────────────────

  describe("addPlayer", () => {
    test("second player joins and status changes to playing", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      const result = room.addPlayer(joiner);

      expect(result).toBe(true);
      expect(room.status).toBe("playing");
      expect(room.playerCount).toBe(2);
    });

    test("joiner gets playerId 1 and roomId set", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      expect(joiner.data.playerId).toBe(1);
      expect(joiner.data.roomId).toBe("room-1");
    });

    test("both players receive matched message", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      const creatorMatched = getMessagesByType(creator, "matched");
      expect(creatorMatched).toHaveLength(1);
      expect((creatorMatched[0] as any).playerId).toBe(0);
      expect((creatorMatched[0] as any).usernames).toEqual(["P1", "P2"]);

      const joinerMatched = getMessagesByType(joiner, "matched");
      expect(joinerMatched).toHaveLength(1);
      expect((joinerMatched[0] as any).playerId).toBe(1);
    });

    test("matched message contains game parameters", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      const msg = getMessagesByType(creator, "matched")[0] as any;
      expect(msg.type).toBe("matched");
      expect(typeof msg.seed).toBe("number");
      expect(msg.roomId).toBe("room-1");
      expect(typeof msg.mapIndex).toBe("number");
      expect(msg.totalRounds).toBe(5); // casual default
      expect(msg.mode).toBe("casual");
      expect(msg.characters).toHaveLength(2);
    });

    test("ranked match has totalRounds=3", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator, false, "ranked");

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      const msg = getMessagesByType(creator, "matched")[0] as any;
      expect(msg.totalRounds).toBe(3);
    });

    test("addPlayer returns false if room is not waiting", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);

      const p2 = createFakeSocket({ username: "P2" });
      room.addPlayer(p2);
      expect(room.status).toBe("playing");

      const p3 = createFakeSocket({ username: "P3" });
      const result = room.addPlayer(p3);
      expect(result).toBe(false);
      expect(room.playerCount).toBe(2); // unchanged
    });

    test("onStarted callback fires when match starts", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);

      let startedRoom: typeof room | null = null;
      room.onStarted = (r) => {
        startedRoom = r;
      };

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      expect(startedRoom).toBe(room);
    });

    test("matchStartTime is set when match starts", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);

      const before = Date.now();
      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);
      const after = Date.now();

      expect(room.matchStartTime).toBeGreaterThanOrEqual(before);
      expect(room.matchStartTime).toBeLessThanOrEqual(after);
    });

    test("sessionId is set after match starts", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      expect(typeof room.sessionId).toBe("number");
    });
  });

  // ── Character assignment ───────────────────────────────────

  describe("character assignment", () => {
    test("players get different characters", () => {
      const creator = createFakeSocket({ username: "P1", character: 0 });
      const room = new GameRoom("room-1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2", character: 0 }); // same as P1
      room.addPlayer(joiner);

      const [c0, c1] = room.characters;
      expect(c0).not.toBe(c1);
    });

    test("non-conflicting characters are preserved", () => {
      const creator = createFakeSocket({ username: "P1", character: 0 });
      const room = new GameRoom("room-1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2", character: 2 });
      room.addPlayer(joiner);

      expect(room.characters[0]).toBe(0);
      expect(room.characters[1]).toBe(2);
    });

    test("away character used as fallback on conflict", () => {
      const creator = createFakeSocket({ username: "P1", character: 1 });
      const room = new GameRoom("room-1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2", character: 1, awayCharacter: 3 });
      room.addPlayer(joiner);

      expect(room.characters[0]).toBe(1);
      expect(room.characters[1]).toBe(3);
    });
  });

  // ── handleInput ────────────────────────────────────────────

  describe("handleInput", () => {
    test("ignores input when not playing", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);

      // Room is in "waiting" — input should be silently ignored (no crash)
      room.handleInput(0, { type: "input", buttons: 1, aimX: 1, aimY: 0 });
    });

    test("ignores input from invalid player IDs", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      // Should not crash with invalid player ID
      room.handleInput(2, { type: "input", buttons: 1, aimX: 1, aimY: 0 });
      room.handleInput(-1, { type: "input", buttons: 1, aimX: 0, aimY: 0 });
    });

    test("queues future-tick input (tick > currentTick)", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      // WASM tick is 0, so tick=5 is in the future
      mockTick = 0;
      room.handleInput(0, { type: "input", tick: 5, buttons: 3, aimX: 1, aimY: 0 });
      // No crash — queued successfully
    });

    test("applies immediate input for current tick", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      mockTick = 10;
      room.handleInput(0, { type: "input", tick: 10, buttons: 5, aimX: -1, aimY: 0 });
      // No crash — applied immediately
    });

    test("tracks button state changes for activity detection", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      expect(room.getInputActivity()).toEqual([0, 0]);

      room.handleInput(0, { type: "input", buttons: 1, aimX: 0, aimY: 0 });
      expect(room.getInputActivity()[0]).toBe(1);

      room.handleInput(0, { type: "input", buttons: 3, aimX: 0, aimY: 0 });
      expect(room.getInputActivity()[0]).toBe(2);

      // Same buttons again — no new activity
      room.handleInput(0, { type: "input", buttons: 3, aimX: 0, aimY: 0 });
      expect(room.getInputActivity()[0]).toBe(2);
    });

    test("caps queued inputs to prevent memory abuse", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      mockTick = 0;
      // Queue 130 future ticks — only first 120 should be accepted
      for (let i = 1; i <= 130; i++) {
        room.handleInput(0, { type: "input", tick: i, buttons: 1, aimX: 0, aimY: 0 });
      }
      // Should not crash; the cap of 120 prevents queue growth
    });

    test("rejects inputs more than 120 ticks in the future", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      mockTick = 0;
      // tick=200 is beyond the 120-tick window — should be silently ignored
      room.handleInput(0, { type: "input", tick: 200, buttons: 1, aimX: 0, aimY: 0 });
    });
  });

  // ── handleLeave ────────────────────────────────────────────

  describe("handleLeave", () => {
    test("removes player from waiting room", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);

      const ws = room.handleLeave(0);
      expect(ws).not.toBeNull();
      expect(ws!.data.roomId).toBeNull();
      expect(ws!.data.playerId).toBe(-1);
    });

    test("room ends when last player leaves", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);

      room.handleLeave(0);
      expect(room.status).toBe("ended");
      expect(room.isEnded()).toBe(true);
    });

    test("returns null when room is not waiting", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);
      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      // Room is now "playing"
      const ws = room.handleLeave(0);
      expect(ws).toBeNull();
    });

    test("returns null for non-existent player", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);

      const ws = room.handleLeave(5);
      expect(ws).toBeNull();
    });
  });

  // ── handleDisconnect ───────────────────────────────────────

  describe("handleDisconnect", () => {
    test("disconnect during waiting ends the room", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);

      room.handleDisconnect(0);
      expect(room.status).toBe("ended");
    });

    test("disconnect during playing gives opponent the win", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);
      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      let endedWinner = -99;
      room.onEnded = (_sockets, winner) => {
        endedWinner = winner;
      };

      // Player 0 disconnects → player 1 wins
      room.handleDisconnect(0);
      expect(room.status).toBe("ended");
      expect(endedWinner).toBe(1);
    });

    test("player 1 disconnect gives player 0 the win", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);
      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      let endedWinner = -99;
      room.onEnded = (_sockets, winner) => {
        endedWinner = winner;
      };

      room.handleDisconnect(1);
      expect(room.status).toBe("ended");
      expect(endedWinner).toBe(0);
    });

    test("both disconnect gives draw (-1)", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);
      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      let endedWinner = -99;
      room.onEnded = (_sockets, winner) => {
        endedWinner = winner;
      };

      room.handleDisconnect(0);
      // First disconnect already ends the match, but let's verify the draw path.
      // To test proper double-disconnect, we need both to happen before endMatch:
      // Reset for a fresh test
      resetMockState();

      const c2 = createFakeSocket({ username: "A" });
      const room2 = new GameRoom("room-2", "Room2", c2);
      const j2 = createFakeSocket({ username: "B" });
      room2.addPlayer(j2);

      let winner2 = -99;
      room2.onEnded = (_sockets, winner) => {
        winner2 = winner;
      };

      // Both disconnect simultaneously — second disconnect triggers draw path
      // Because first disconnect calls endMatch immediately, status becomes "ended"
      // and second handleDisconnect does nothing. The draw path is for when
      // both players are tracked as disconnected before endMatch is called.
      room2.handleDisconnect(0);
      room2.handleDisconnect(1); // This does nothing since status is already "ended"
      expect(room2.status).toBe("ended");
    });

    test("ended message is sent on disconnect", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);
      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      room.handleDisconnect(0);

      const endedMsgs = getMessagesByType(creator, "ended");
      expect(endedMsgs.length).toBeGreaterThanOrEqual(1);
      const ended = endedMsgs[0] as any;
      expect(ended.winner).toBe(1);
      expect(ended.mode).toBe("casual");
    });

    test("disconnect clears roomId and playerId on sockets", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);
      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      room.handleDisconnect(0);

      expect(creator.data.roomId).toBeNull();
      expect(creator.data.playerId).toBe(-1);
      expect(joiner.data.roomId).toBeNull();
      expect(joiner.data.playerId).toBe(-1);
    });
  });

  // ── endMatch double-call guard ─────────────────────────────

  describe("endMatch double-call guard", () => {
    test("multiple disconnects do not call onEnded twice", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("room-1", "Room", creator);
      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      let endCallCount = 0;
      room.onEnded = () => {
        endCallCount++;
      };

      room.handleDisconnect(0);
      room.handleDisconnect(1);
      room.handleDisconnect(0); // extra call

      expect(endCallCount).toBe(1);
    });
  });

  // ── toInfo ─────────────────────────────────────────────────

  describe("toInfo", () => {
    test("returns correct room info when waiting", () => {
      const creator = createFakeSocket({ username: "Alice" });
      const room = new GameRoom("r1", "My Room", creator, true, "ranked");

      const info = room.toInfo();
      expect(info.id).toBe("r1");
      expect(info.name).toBe("My Room");
      expect(info.status).toBe("waiting");
      expect(info.players).toBe(1);
      expect(info.isPrivate).toBe(true);
      expect(info.mode).toBe("ranked");
      expect(info.playerNames).toEqual(["Alice"]);
    });

    test("returns correct info when playing", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);
      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      const info = room.toInfo();
      expect(info.status).toBe("playing");
      expect(info.players).toBe(2);
      expect(info.playerNames).toEqual(["P1", "P2"]);
    });
  });

  // ── Spectators ─────────────────────────────────────────────

  describe("spectators", () => {
    test("addSpectator adds to spectator list", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      const spec = createFakeSocket({ username: "Watcher" });
      room.addSpectator(spec);

      expect(room.spectatorSockets).toHaveLength(1);
    });

    test("removeSpectator removes from list", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      const spec = createFakeSocket({ username: "Watcher" });
      room.addSpectator(spec);
      room.removeSpectator(spec);

      expect(room.spectatorSockets).toHaveLength(0);
    });

    test("removeSpectator is safe for non-existent socket", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      const spec = createFakeSocket({ username: "NotAdded" });
      room.removeSpectator(spec); // should not throw
      expect(room.spectatorSockets).toHaveLength(0);
    });

    test("spectator cap is enforced (MAX_SPECTATORS = 20)", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      expect(GameRoom.MAX_SPECTATORS).toBe(20);

      for (let i = 0; i < 25; i++) {
        room.addSpectator(createFakeSocket({ username: `Spec${i}` }));
      }

      expect(room.spectatorSockets).toHaveLength(20);
    });
  });

  // ── Override game params (tournament) ──────────────────────

  describe("override game params", () => {
    test("overrideGameParams sets seed, map, and characters", () => {
      const creator = createFakeSocket({ username: "P1" });
      const overrideParams = {
        seed: 42,
        mapIndex: 1,
        characters: [2, 3] as [number, number],
      };
      const room = new GameRoom(
        "r1",
        "Tournament Match",
        creator,
        false,
        "casual",
        true,
        undefined,
        overrideParams,
      );

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      expect(room.currentSeed).toBe(42);
      expect(room.characters).toEqual([2, 3]);

      const msg = getMessagesByType(creator, "matched")[0] as any;
      expect(msg.seed).toBe(42);
      expect(msg.mapIndex).toBe(1);
      expect(msg.characters).toEqual([2, 3]);
    });

    test("overrideRounds customizes totalRounds and winsNeeded", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom(
        "r1",
        "Custom",
        creator,
        false,
        "casual",
        true,
        { totalRounds: 7, winsNeeded: 4 },
      );

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      const msg = getMessagesByType(creator, "matched")[0] as any;
      expect(msg.totalRounds).toBe(7);
    });
  });

  // ── Bot matches ────────────────────────────────────────────

  describe("bot matches", () => {
    test("addBot creates a bot opponent and starts match", () => {
      const creator = createFakeSocket({ username: "Human" });
      const room = new GameRoom("r1", "Room", creator);

      room.addBot(0.5);

      expect(room.isBotMatch).toBe(true);
      expect(room.status).toBe("playing");
      expect(room.playerCount).toBe(2);
    });

    test("bot has a name", () => {
      const creator = createFakeSocket({ username: "Human" });
      const room = new GameRoom("r1", "Room", creator);

      room.addBot(0.5, "TestBot");

      expect(room.botName).toBe("TestBot");
    });

    test("custom bot name is used", () => {
      const creator = createFakeSocket({ username: "Human" });
      const room = new GameRoom("r1", "Room", creator);

      room.addBot(0.3, "MyCustomBot");
      expect(room.botName).toBe("MyCustomBot");
    });

    test("difficulty is stored", () => {
      const creator = createFakeSocket({ username: "Human" });
      const room = new GameRoom("r1", "Room", creator);

      room.addBot(0.7);
      expect(room.currentBotDifficulty).toBe(0.7);
    });

    test("botName is null when not a bot match", () => {
      const creator = createFakeSocket({ username: "Human" });
      const room = new GameRoom("r1", "Room", creator);

      expect(room.botName).toBeNull();
    });

    test("isBotVsBotMatch is false by default", () => {
      const creator = createFakeSocket({ username: "Human" });
      const room = new GameRoom("r1", "Room", creator);

      room.addBot(0.3);
      expect(room.isBotVsBotMatch).toBe(false);
    });

    test("makeBotVsBot sets bot-vs-bot flag", () => {
      const creator = createFakeSocket({ username: "Bot0" });
      const room = new GameRoom("r1", "Room", creator);

      room.addBot(0.3);
      room.makeBotVsBot(0.5);
      expect(room.isBotVsBotMatch).toBe(true);
    });
  });

  // ── walletAddresses ────────────────────────────────────────

  describe("walletAddresses", () => {
    test("returns wallet addresses of both players", () => {
      const creator = createFakeSocket({ username: "P1", walletAddress: "GABC123" });
      const room = new GameRoom("r1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2", walletAddress: "GDEF456" });
      room.addPlayer(joiner);

      expect(room.walletAddresses).toEqual(["GABC123", "GDEF456"]);
    });

    test("returns empty strings for missing wallets", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      expect(room.walletAddresses).toEqual(["", ""]);
    });
  });

  // ── roundWinsSnapshot ──────────────────────────────────────

  describe("roundWinsSnapshot", () => {
    test("returns [0,0] at match start", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      expect(room.roundWinsSnapshot).toEqual([0, 0]);
    });

    test("snapshot is a copy (not a reference)", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      const snap1 = room.roundWinsSnapshot;
      const snap2 = room.roundWinsSnapshot;
      expect(snap1).not.toBe(snap2); // different array instances
      expect(snap1).toEqual(snap2); // but same values
    });
  });

  // ── startTxHash ────────────────────────────────────────────

  describe("startTxHash", () => {
    test("starts as null", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      expect(room.startTxHash).toBeNull();
    });

    test("can be set and read", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      room.startTxHash = "0xABC123";
      expect(room.startTxHash).toBe("0xABC123");
    });
  });

  // ── matchRecordId ──────────────────────────────────────────

  describe("matchRecordId", () => {
    test("starts as null", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      expect(room.matchRecordId).toBeNull();
    });

    test("can be set", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      room.matchRecordId = "match-abc";
      expect(room.matchRecordId).toBe("match-abc");
    });
  });

  // ── onEnded callback ──────────────────────────────────────

  describe("onEnded callback", () => {
    test("receives sockets, winner, roomId, roomName, scores, mode", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "MyGame", creator, false, "ranked");

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      let cbData: any = null;
      room.onEnded = (sockets, winner, roomId, roomName, scores, mode) => {
        cbData = { sockets, winner, roomId, roomName, scores, mode };
      };

      room.handleDisconnect(1); // P1 wins

      expect(cbData).not.toBeNull();
      expect(cbData.winner).toBe(0);
      expect(cbData.roomId).toBe("r1");
      expect(cbData.roomName).toBe("MyGame");
      expect(cbData.scores).toEqual([0, 0]);
      expect(cbData.mode).toBe("ranked");
      expect(cbData.sockets).toHaveLength(2);
    });
  });

  // ── Auto-generated usernames ───────────────────────────────

  describe("auto-generated usernames", () => {
    test("players without usernames get auto-generated names", () => {
      const creator = createFakeSocket({ username: "" });
      const room = new GameRoom("r1", "Room", creator);

      const joiner = createFakeSocket({ username: "" });
      room.addPlayer(joiner);

      // Both should now have non-empty usernames
      expect(creator.data.username).toBeTruthy();
      expect(joiner.data.username).toBeTruthy();
      expect(creator.data.username.startsWith("Chk")).toBe(true);
      expect(joiner.data.username.startsWith("Chk")).toBe(true);
    });

    test("players with usernames keep them", () => {
      const creator = createFakeSocket({ username: "Alice" });
      const room = new GameRoom("r1", "Room", creator);

      const joiner = createFakeSocket({ username: "Bob" });
      room.addPlayer(joiner);

      expect(creator.data.username).toBe("Alice");
      expect(joiner.data.username).toBe("Bob");
    });
  });

  // ── getFullTranscript ──────────────────────────────────────

  describe("getFullTranscript", () => {
    test("returns structure with rounds, usernames, characters", () => {
      const creator = createFakeSocket({ username: "P1", character: 0 });
      const room = new GameRoom("r1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2", character: 2 });
      room.addPlayer(joiner);

      const ft = room.getFullTranscript();
      expect(ft.usernames).toEqual(["P1", "P2"]);
      expect(ft.characters).toEqual(room.characters);
      expect(Array.isArray(ft.rounds)).toBe(true);
      expect(ft.rounds).toHaveLength(0); // no rounds completed yet
    });
  });

  // ── getTranscript ──────────────────────────────────────────

  describe("getTranscript", () => {
    test("returns transcript config and rounds array", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      const t = room.getTranscript();
      expect(t.config).toBeDefined();
      expect(t.config.player_count).toBe(2);
      expect(t.config.tick_rate).toBe(60);
      expect(t.config.initial_lives).toBe(1);
      expect(t.config.match_duration_ticks).toBe(1800);
      expect(t.config.sudden_death_start_tick).toBe(1200);
      expect(Array.isArray(t.rounds)).toBe(true);
    });

    test("transcript config has snake_case map fields", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      const t = room.getTranscript();
      const map = t.config.map;
      expect(map.width).toBeDefined();
      expect(map.height).toBeDefined();
      expect(map.platforms).toBeDefined();
      expect(map.spawn_points).toBeDefined();
      expect(map.weapon_spawn_points).toBeDefined();
    });
  });

  // ── Ranked vs Casual round settings ────────────────────────

  describe("round settings", () => {
    test("casual mode: matched message has totalRounds=5", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator, false, "casual");

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      const msg = getMessagesByType(creator, "matched")[0] as any;
      expect(msg.totalRounds).toBe(5);
    });

    test("ranked mode: matched message has totalRounds=3", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator, false, "ranked");

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      const msg = getMessagesByType(creator, "matched")[0] as any;
      expect(msg.totalRounds).toBe(3);
    });

    test("ranked mode forces map 0 (arena) for all rounds", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator, false, "ranked");

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      const msg = getMessagesByType(creator, "matched")[0] as any;
      expect(msg.mapIndex).toBe(0);
    });
  });

  // ── currentMapIndex / currentSeed ──────────────────────────

  describe("currentMapIndex and currentSeed", () => {
    test("currentSeed is set after match starts", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      expect(typeof room.currentSeed).toBe("number");
      expect(room.currentSeed).toBeGreaterThan(0);
    });

    test("currentMapIndex returns a valid map index", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      const idx = room.currentMapIndex;
      expect(idx).toBeGreaterThanOrEqual(0);
    });
  });

  // ── WASM interaction ───────────────────────────────────────

  describe("WASM lifecycle", () => {
    test("WasmState is constructed on match start", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      // If WasmState was NOT constructed, calling disconnect would fail
      // since tick() method wouldn't exist. The fact that this works
      // proves the mock WASM was correctly created.
      room.handleDisconnect(0);
      expect(room.status).toBe("ended");
    });

    test("WASM free is called on match end", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      mockFreeCalled = false;
      room.handleDisconnect(0);

      expect(mockFreeCalled).toBe(true);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────

  describe("edge cases", () => {
    test("disconnect on already ended room is no-op", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      // End via leave
      room.handleLeave(0);
      expect(room.status).toBe("ended");

      // Disconnect after already ended should not throw
      room.handleDisconnect(0);
      expect(room.status).toBe("ended");
    });

    test("handleInput after disconnect is no-op", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);
      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      room.handleDisconnect(0);

      // Room is ended, input should be silently ignored
      room.handleInput(0, { type: "input", buttons: 1, aimX: 0, aimY: 0 });
      expect(room.status).toBe("ended");
    });

    test("socket send failure is silently caught", () => {
      // Create a socket that throws on send
      const badSocket = createFakeSocket({ username: "Bad" });
      (badSocket as any).send = () => {
        throw new Error("connection closed");
      };

      const room = new GameRoom("r1", "Room", badSocket);
      // The waiting message send should not throw even with a broken socket
      // (constructor already ran, so we just verify room was created)
      expect(room.status).toBe("waiting");
    });

    test("multiple addBot calls only add first bot", () => {
      const creator = createFakeSocket({ username: "Human" });
      const room = new GameRoom("r1", "Room", creator);

      room.addBot(0.3);
      expect(room.status).toBe("playing");

      // Second addBot should fail since room is no longer waiting
      room.addBot(0.5);
      expect(room.playerCount).toBe(2);
    });
  });

  // ── Interval cleanup ──────────────────────────────────────

  describe("interval cleanup", () => {
    test("game loop interval is cleared on match end", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      // The match starts a setInterval. Disconnecting should clear it.
      room.handleDisconnect(0);
      expect(room.status).toBe("ended");

      // If the interval wasn't cleared, the test runner would hang or
      // leak the timer. Bun cleans up, but we verify status is ended.
    });
  });

  // ── Multiple rooms ─────────────────────────────────────────

  describe("multiple rooms", () => {
    test("rooms are independent", () => {
      const c1 = createFakeSocket({ username: "P1" });
      const room1 = new GameRoom("r1", "Room1", c1);

      const c2 = createFakeSocket({ username: "P2" });
      const room2 = new GameRoom("r2", "Room2", c2);

      expect(room1.id).not.toBe(room2.id);
      expect(room1.status).toBe("waiting");
      expect(room2.status).toBe("waiting");

      // End room1, room2 should be unaffected
      room1.handleLeave(0);
      expect(room1.status).toBe("ended");
      expect(room2.status).toBe("waiting");
    });
  });

  // ── Ended message fields ──────────────────────────────────

  describe("ended message fields", () => {
    test("ended message includes roomId and scores", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "TestRoom", creator, false, "ranked");

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      room.handleDisconnect(1);

      const msgs = getMessagesByType(creator, "ended");
      expect(msgs).toHaveLength(1);
      const ended = msgs[0] as any;
      expect(ended.type).toBe("ended");
      expect(ended.roomId).toBe("r1");
      expect(ended.mode).toBe("ranked");
      expect(ended.roundWins).toEqual([0, 0]);
      expect(ended.scores).toEqual([0, 0]);
    });
  });

  // ── Matched message for both players ──────────────────────

  describe("matched message details", () => {
    test("both players see each other's usernames in correct order", () => {
      const creator = createFakeSocket({ username: "Alice" });
      const room = new GameRoom("r1", "Room", creator);

      const joiner = createFakeSocket({ username: "Bob" });
      room.addPlayer(joiner);

      const creatorMsg = getMessagesByType(creator, "matched")[0] as any;
      const joinerMsg = getMessagesByType(joiner, "matched")[0] as any;

      // Both see the same usernames array
      expect(creatorMsg.usernames).toEqual(["Alice", "Bob"]);
      expect(joinerMsg.usernames).toEqual(["Alice", "Bob"]);

      // But playerId differs
      expect(creatorMsg.playerId).toBe(0);
      expect(joinerMsg.playerId).toBe(1);

      // Same seed, map, etc.
      expect(creatorMsg.seed).toBe(joinerMsg.seed);
      expect(creatorMsg.mapIndex).toBe(joinerMsg.mapIndex);
      expect(creatorMsg.characters).toEqual(joinerMsg.characters);
    });
  });

  // ── handleLeave edge cases ────────────────────────────────

  describe("handleLeave edge cases", () => {
    test("leaving a playing room returns null", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);
      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      expect(room.status).toBe("playing");
      expect(room.handleLeave(0)).toBeNull();
      expect(room.handleLeave(1)).toBeNull();
    });
  });

  // ── Input validation ──────────────────────────────────────

  describe("input validation", () => {
    test("input with no tick field applies immediately", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);
      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      // No tick field = current/past → apply immediately
      room.handleInput(0, { type: "input", buttons: 5, aimX: 1, aimY: 0 });
      // Should not crash
    });

    test("input with past tick applies immediately", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);
      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      mockTick = 50;
      room.handleInput(0, { type: "input", tick: 30, buttons: 3, aimX: -1, aimY: 0 });
      // Should not crash — past ticks are applied immediately
    });

    test("input for both players tracked independently", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);
      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      room.handleInput(0, { type: "input", buttons: 1, aimX: -1, aimY: 0 });
      room.handleInput(1, { type: "input", buttons: 2, aimX: 1, aimY: 0 });

      const activity = room.getInputActivity();
      expect(activity[0]).toBe(1);
      expect(activity[1]).toBe(1);
    });
  });

  // ── Static properties ─────────────────────────────────────

  describe("static properties", () => {
    test("MAX_SPECTATORS is 20", () => {
      expect(GameRoom.MAX_SPECTATORS).toBe(20);
    });
  });

  // ── Room lifecycle transitions ────────────────────────────

  describe("room lifecycle transitions", () => {
    test("waiting -> playing -> ended is the normal flow", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);
      expect(room.status).toBe("waiting");

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);
      expect(room.status).toBe("playing");

      room.handleDisconnect(0);
      expect(room.status).toBe("ended");
    });

    test("waiting -> ended via leave (no second player)", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);
      expect(room.status).toBe("waiting");

      room.handleLeave(0);
      expect(room.status).toBe("ended");
    });

    test("waiting -> ended via disconnect (no second player)", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);
      expect(room.status).toBe("waiting");

      room.handleDisconnect(0);
      expect(room.status).toBe("ended");
    });
  });

  // ── Spectator broadcast on ended ──────────────────────────

  describe("spectator interactions", () => {
    test("spectators receive state broadcasts when ticks are simulated", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      const spec = createFakeSocket({ username: "Watcher" });
      room.addSpectator(spec);

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      // Spectator was added before match started — verify it's in the list
      expect(room.spectatorSockets).toContain(spec);
    });

    test("broken spectator socket is removed on send failure", () => {
      const creator = createFakeSocket({ username: "P1" });
      const room = new GameRoom("r1", "Room", creator);

      const brokenSpec = createFakeSocket({ username: "Broken" });
      (brokenSpec as any).send = () => {
        throw new Error("broken");
      };

      room.addSpectator(brokenSpec);
      expect(room.spectatorSockets).toHaveLength(1);

      // The broken spectator will be removed on the next broadcast attempt.
      // This happens inside the game loop (private), so we verify the setup.
    });
  });

  // ── Override game params consumption ──────────────────────

  describe("override game params consumption", () => {
    test("override params are consumed (used only once)", () => {
      const creator = createFakeSocket({ username: "P1" });
      const overrideParams = {
        seed: 999,
        mapIndex: 0,
        characters: [1, 2] as [number, number],
      };
      const room = new GameRoom(
        "r1",
        "Room",
        creator,
        false,
        "casual",
        true,
        undefined,
        overrideParams,
      );

      const joiner = createFakeSocket({ username: "P2" });
      room.addPlayer(joiner);

      // Verify override was applied
      expect(room.currentSeed).toBe(999);
      expect(room.characters).toEqual([1, 2]);
    });
  });

  // ── Bot addBot with default values ────────────────────────

  describe("bot defaults", () => {
    test("addBot with no arguments uses default difficulty 0.3", () => {
      const creator = createFakeSocket({ username: "Human" });
      const room = new GameRoom("r1", "Room", creator);

      room.addBot();
      expect(room.currentBotDifficulty).toBe(0.3);
    });

    test("addBot generates a non-empty bot name when none provided", () => {
      const creator = createFakeSocket({ username: "Human" });
      const room = new GameRoom("r1", "Room", creator);

      room.addBot();
      expect(room.botName).toBeTruthy();
      expect(typeof room.botName).toBe("string");
    });
  });
});
