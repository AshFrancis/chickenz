import type { RegionConfig } from "./regions";
import { PING_THRESHOLD_MS } from "./regions";
import type { RoomInfo } from "./NetworkManager";

export interface RegionPing {
  region: RegionConfig;
  pingMs: number; // median of 3 samples, or Infinity if unreachable
}

export interface RegionRoomInfo {
  regionId: string;
  regionFlag: string;
  room: RoomInfo;
}

interface RegionManagerOptions {
  onRoomsChanged: (rooms: RegionRoomInfo[]) => void;
  onPingsUpdated?: (pings: RegionPing[]) => void;
}

/** Measures ping for a single region URL. Returns ms or Infinity on failure. */
async function pingRegion(httpUrl: string): Promise<number> {
  try {
    const start = performance.now();
    const res = await fetch(`${httpUrl}/api/ping`, { cache: "no-store" });
    if (!res.ok) return Infinity;
    await res.text();
    return performance.now() - start;
  } catch {
    return Infinity;
  }
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const LOBBY_STORAGE_KEY = "chickenz-home-region";
const PING_REFRESH_INTERVAL = 30_000;

export class RegionManager {
  private regions: RegionConfig[];
  private opts: RegionManagerOptions;
  private pings = new Map<string, number>(); // regionId → median ping ms
  private lobbyWs = new Map<string, WebSocket>(); // regionId → lobby WS
  private regionRooms = new Map<string, RoomInfo[]>(); // regionId → rooms from that region
  private _homeRegionId: string;
  private _activeRegionId = ""; // region the main NetworkManager is connected to
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>(); // regionId → pending reconnect

  constructor(regions: RegionConfig[], opts: RegionManagerOptions) {
    this.regions = regions;
    this.opts = opts;
    this._homeRegionId = localStorage.getItem(LOBBY_STORAGE_KEY) || "";
  }

  // ── Public API ───────────────────────────────────────────────

  /** Measure pings to all regions (3 samples, take median). All regions pinged in parallel. */
  async measurePings(): Promise<RegionPing[]> {
    // Warmup: establish TCP+TLS connections to all regions (discarded, avoids cold-start bias)
    await Promise.all(this.regions.map((r) => pingRegion(r.httpUrl)));
    // Measure with warm connections
    const regionResults = await Promise.all(
      this.regions.map(async (region) => {
        const samples: number[] = [];
        for (let i = 0; i < 3; i++) {
          samples.push(await pingRegion(region.httpUrl));
        }
        const med = median(samples);
        this.pings.set(region.id, med);
        return { region, pingMs: med } as RegionPing;
      }),
    );
    // If no home region set, default to lowest ping
    if (!this._homeRegionId || !this.regions.find((r) => r.id === this._homeRegionId)) {
      const best = regionResults.reduce((a, b) => (a.pingMs < b.pingMs ? a : b));
      this._homeRegionId = best.region.id;
      localStorage.setItem(LOBBY_STORAGE_KEY, this._homeRegionId);
    }
    this.opts.onPingsUpdated?.(regionResults);
    return regionResults;
  }

  /** Get the cached home region config (from localStorage), or first region as fallback. */
  getCachedHomeRegion(): RegionConfig | null {
    if (this._homeRegionId) {
      const region = this.regions.find((r) => r.id === this._homeRegionId);
      if (region) return region;
    }
    return null;
  }

  /** Start periodic ping refresh (every 30s). */
  startPingRefresh() {
    this.stopPingRefresh();
    this.pingTimer = setInterval(() => {
      void this.measurePings();
    }, PING_REFRESH_INTERVAL);
  }

  stopPingRefresh() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Set which region the main NetworkManager is connected to (avoids duplicate lobby WS). */
  set activeRegionId(id: string) {
    // If the active region changed, close the old lobby WS for the previously active region
    // (the NetworkManager will feed its rooms via updateRoomsForRegion)
    if (this._activeRegionId !== id) {
      const oldWs = this.lobbyWs.get(this._activeRegionId);
      if (oldWs) {
        oldWs.onclose = null; // prevent reconnect
        oldWs.close();
        this.lobbyWs.delete(this._activeRegionId);
      }
      this._activeRegionId = id;
    }
  }

  get activeRegionId(): string {
    return this._activeRegionId;
  }

  /** Feed room list from the main NetworkManager's lobby messages. */
  updateRoomsForRegion(regionId: string, rooms: RoomInfo[]) {
    this.regionRooms.set(regionId, rooms);
    this.opts.onRoomsChanged(this.getMergedRooms());
  }

  /** Open lightweight lobby WebSockets to all reachable regions (except the active one). */
  connectLobbyStreams() {
    this.disconnectLobbyStreams();
    for (const region of this.getReachableRegions()) {
      // Skip the active region — its rooms come from the main NetworkManager
      if (region.id === this._activeRegionId) continue;
      this.connectLobbyWs(region);
    }
  }

  disconnectLobbyStreams() {
    for (const [, timer] of this.reconnectTimers) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const [, ws] of this.lobbyWs) {
      ws.onclose = null;
      ws.close();
    }
    this.lobbyWs.clear();
    // Keep rooms from the active region (fed by NetworkManager), clear the rest
    const activeRooms = this.regionRooms.get(this._activeRegionId);
    this.regionRooms.clear();
    if (activeRooms) this.regionRooms.set(this._activeRegionId, activeRooms);
  }

  /** Get merged room list from all connected lobby streams. */
  getMergedRooms(): RegionRoomInfo[] {
    const merged: RegionRoomInfo[] = [];
    for (const [regionId, rooms] of this.regionRooms) {
      const region = this.regions.find((r) => r.id === regionId);
      if (!region) continue;
      for (const room of rooms) {
        merged.push({ regionId, regionFlag: region.flag, room });
      }
    }
    // Sort: home region rooms first, then by status (waiting first)
    merged.sort((a, b) => {
      const aHome = a.regionId === this._homeRegionId ? 0 : 1;
      const bHome = b.regionId === this._homeRegionId ? 0 : 1;
      if (aHome !== bHome) return aHome - bHome;
      const aWait = a.room.status === "waiting" ? 0 : 1;
      const bWait = b.room.status === "waiting" ? 0 : 1;
      return aWait - bWait;
    });
    return merged;
  }

  /** Get the home region config, or first reachable region if home is unreachable. */
  getBestRegion(): RegionConfig {
    const home = this.regions.find((r) => r.id === this._homeRegionId);
    if (home) {
      const ping = this.pings.get(home.id) ?? Infinity;
      if (ping < Infinity) return home;
    }
    // Fallback: lowest ping region
    let best: RegionConfig | null = null;
    let bestPing = Infinity;
    for (const region of this.regions) {
      const ping = this.pings.get(region.id) ?? Infinity;
      if (ping < bestPing) {
        bestPing = ping;
        best = region;
      }
    }
    return best ?? this.regions[0]!;
  }

  /** Get all regions under ping threshold. */
  getReachableRegions(): RegionConfig[] {
    return this.regions.filter((r) => {
      const ping = this.pings.get(r.id) ?? Infinity;
      return ping < PING_THRESHOLD_MS;
    });
  }

  /** Get all regions with their pings. */
  getAllPings(): RegionPing[] {
    return this.regions.map((region) => ({
      region,
      pingMs: this.pings.get(region.id) ?? Infinity,
    }));
  }

  getPing(regionId: string): number {
    return this.pings.get(regionId) ?? Infinity;
  }

  get homeRegionId(): string {
    return this._homeRegionId;
  }

  set homeRegionId(id: string) {
    this._homeRegionId = id;
    localStorage.setItem(LOBBY_STORAGE_KEY, id);
  }

  getRegionById(id: string): RegionConfig | undefined {
    return this.regions.find((r) => r.id === id);
  }

  /** Find a region that has a waiting room matching a join code. */
  findRegionWithCode(code: string): RegionConfig | undefined {
    const upperCode = code.toUpperCase();
    for (const [regionId, rooms] of this.regionRooms) {
      for (const room of rooms) {
        if (room.joinCode === upperCode && room.status === "waiting") {
          return this.regions.find((r) => r.id === regionId);
        }
      }
    }
    return undefined;
  }

  /** Find a region that has a quickplay-eligible room (waiting, public, matching mode). */
  findRegionWithWaitingRoom(mode: string): RegionConfig | undefined {
    // Check home region first
    const homeRooms = this.regionRooms.get(this._homeRegionId) ?? [];
    if (homeRooms.some((r) => r.status === "waiting" && !r.isPrivate && r.mode === mode)) {
      return this.regions.find((r) => r.id === this._homeRegionId);
    }
    // Check other reachable regions sorted by ping
    const reachable = this.getReachableRegions()
      .filter((r) => r.id !== this._homeRegionId)
      .sort((a, b) => (this.pings.get(a.id) ?? Infinity) - (this.pings.get(b.id) ?? Infinity));
    for (const region of reachable) {
      const rooms = this.regionRooms.get(region.id) ?? [];
      if (rooms.some((r) => r.status === "waiting" && !r.isPrivate && r.mode === mode)) {
        return region;
      }
    }
    return undefined;
  }

  destroy() {
    this.stopPingRefresh();
    this.disconnectLobbyStreams();
  }

  // ── Private ──────────────────────────────────────────────────

  private connectLobbyWs(region: RegionConfig) {
    const ws = new WebSocket(region.wsUrl);
    this.lobbyWs.set(region.id, ws);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "lobby") {
          this.regionRooms.set(region.id, msg.rooms);
          this.opts.onRoomsChanged(this.getMergedRooms());
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      this.lobbyWs.delete(region.id);
      this.regionRooms.delete(region.id);
      // Reconnect after 5s if still reachable
      const timer = setTimeout(() => {
        this.reconnectTimers.delete(region.id);
        const ping = this.pings.get(region.id) ?? Infinity;
        if (ping < PING_THRESHOLD_MS && !this.lobbyWs.has(region.id)) {
          this.connectLobbyWs(region);
        }
      }, 5000);
      this.reconnectTimers.set(region.id, timer);
    };

    ws.onerror = () => {
      // Error followed by close
    };
  }
}
