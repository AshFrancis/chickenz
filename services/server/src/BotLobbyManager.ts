import { randomBotName, releaseBotName } from "./BotAI";
import { generateJoinCode } from "./protocol";
import type { RoomInfo } from "./protocol";

interface FakeRoom {
  id: string;
  name: string;
  joinCode: string;
  ttl: number;
  botName: string;
}

/**
 * Manages fake bot "waiting" rooms in the lobby and auto-joins bots to human rooms.
 * Fake rooms appear as real waiting rooms. When a human tries to join one,
 * the server creates a real GameRoom with the human as P1 and adds a bot as P2.
 */
export class BotLobbyManager {
  private fakeRooms: FakeRoom[] = [];
  private humanWatchers = new Map<string, ReturnType<typeof setTimeout>>();
  private cycleTimer: ReturnType<typeof setInterval> | null = null;
  private generateRoomId: () => string;
  private isJoinCodeInUse: (code: string) => boolean;
  private broadcastLobby: () => void;

  private readonly MIN_ROOMS = 3;
  private readonly MAX_ROOMS = 5;
  private readonly MIN_TTL = 45_000;
  private readonly MAX_TTL = 120_000;
  private readonly HUMAN_BOT_DELAY = 5_000;

  constructor(opts: {
    generateRoomId: () => string;
    isJoinCodeInUse: (code: string) => boolean;
    broadcastLobby: () => void;
  }) {
    this.generateRoomId = opts.generateRoomId;
    this.isJoinCodeInUse = opts.isJoinCodeInUse;
    this.broadcastLobby = opts.broadcastLobby;
  }

  /** Start the bot lobby system. */
  start() {
    const count = this.MIN_ROOMS + Math.floor(Math.random() * (this.MAX_ROOMS - this.MIN_ROOMS + 1));
    for (let i = 0; i < count; i++) {
      this.spawnFakeRoom();
    }
    this.cycleTimer = setInterval(() => this.cycle(), 5_000);
  }

  /** Stop the bot lobby system. */
  stop() {
    if (this.cycleTimer) {
      clearInterval(this.cycleTimer);
      this.cycleTimer = null;
    }
    for (const timer of this.humanWatchers.values()) clearTimeout(timer);
    this.humanWatchers.clear();
    for (const room of this.fakeRooms) releaseBotName(room.botName);
    this.fakeRooms = [];
  }

  /** Get fake rooms as RoomInfo for lobby display. */
  getFakeRooms(): RoomInfo[] {
    return this.fakeRooms.map((r) => ({
      id: r.id,
      name: r.name,
      status: "waiting" as const,
      players: 1,
      joinCode: r.joinCode,
      isPrivate: false,
      mode: "casual" as const,
      playerNames: [r.botName],
    }));
  }

  /** Check if a room ID is a fake bot room. */
  getFakeRoom(roomId: string): FakeRoom | undefined {
    return this.fakeRooms.find((r) => r.id === roomId);
  }

  /** Find a fake room by join code. */
  findByJoinCode(code: string): FakeRoom | undefined {
    return this.fakeRooms.find((r) => r.joinCode === code.toUpperCase());
  }

  /** Consume a fake room when a human joins. Returns the bot name to use. */
  consumeFakeRoom(roomId: string): string | null {
    const idx = this.fakeRooms.findIndex((r) => r.id === roomId);
    if (idx < 0) return null;
    const botName = this.fakeRooms[idx]!.botName;
    this.fakeRooms.splice(idx, 1);
    // Spawn replacement after short delay
    setTimeout(
      () => {
        this.spawnFakeRoom();
        this.broadcastLobby();
      },
      2000 + Math.random() * 3000,
    );
    return botName;
  }

  /** Watch a human-created casual room. Adds bot after 5s if no human joins. */
  watchHumanRoom(roomId: string, addBot: () => void) {
    if (this.humanWatchers.has(roomId)) return;
    const timer = setTimeout(() => {
      this.humanWatchers.delete(roomId);
      addBot();
    }, this.HUMAN_BOT_DELAY);
    this.humanWatchers.set(roomId, timer);
  }

  /** Cancel watching a room (a human joined). */
  cancelWatch(roomId: string) {
    const timer = this.humanWatchers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.humanWatchers.delete(roomId);
    }
  }

  private spawnFakeRoom() {
    const id = this.generateRoomId();
    const botName = randomBotName();
    let joinCode = generateJoinCode();
    // Ensure unique join code across real rooms, tournaments, and other fake rooms
    while (this.isJoinCodeInUse(joinCode) || this.fakeRooms.some((r) => r.joinCode === joinCode)) {
      joinCode = generateJoinCode();
    }
    const ttl = Date.now() + this.MIN_TTL + Math.random() * (this.MAX_TTL - this.MIN_TTL);
    this.fakeRooms.push({ id, name: "Public Match", joinCode, ttl, botName });
  }

  private cycle() {
    const now = Date.now();
    let changed = false;

    // Remove expired fake rooms
    for (let i = this.fakeRooms.length - 1; i >= 0; i--) {
      if (now >= this.fakeRooms[i]!.ttl) {
        releaseBotName(this.fakeRooms[i]!.botName);
        this.fakeRooms.splice(i, 1);
        changed = true;
      }
    }

    // Maintain minimum count
    while (this.fakeRooms.length < this.MIN_ROOMS) {
      this.spawnFakeRoom();
      changed = true;
    }

    if (changed) this.broadcastLobby();
  }
}
