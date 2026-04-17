import { describe, it, expect, beforeEach } from "bun:test";

// ── Mock browser globals ──────────────────────────────────────────────────────

let lastWs: MockWebSocket | null = null;

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = 1; // OPEN
  url: string;
  sent: string[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    lastWs = this;
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }

  // Test helpers
  simulateOpen() {
    this.onopen?.();
  }

  simulateMessage(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }
}

(globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;

// ── Import after mock setup ───────────────────────────────────────────────────

const { NetworkManager } = await import("../NetworkManager");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCallbacks() {
  return {
    onWaiting: () => {},
    onMatched: () => {},
    onState: () => {},
    onRoundEnd: () => {},
    onRoundStart: () => {},
    onEnded: () => {},
    onLobby: () => {},
    onError: () => {},
    onDisconnect: () => {},
  };
}

function connectAndOpen(url = "ws://localhost:3000/ws") {
  const callbacks = makeCallbacks();
  const nm = new NetworkManager(callbacks);
  nm.connect(url);
  const ws = lastWs!;
  ws.simulateOpen();
  return { nm, ws, callbacks };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("NetworkManager", () => {
  beforeEach(() => {
    lastWs = null;
  });

  describe("connect()", () => {
    it("creates a WebSocket to the given URL", () => {
      const nm = new NetworkManager(makeCallbacks());
      nm.connect("ws://test.example.com/ws");
      expect(lastWs).not.toBeNull();
      expect(lastWs!.url).toBe("ws://test.example.com/ws");
    });

    it("derives httpOrigin from ws URL", () => {
      const nm = new NetworkManager(makeCallbacks());
      nm.connect("ws://test.example.com/ws");
      expect(nm.httpOrigin).toBe("http://test.example.com");
    });

    it("derives httpOrigin correctly for wss URLs", () => {
      const nm = new NetworkManager(makeCallbacks());
      nm.connect("wss://prod.example.com/ws");
      expect(nm.httpOrigin).toBe("https://prod.example.com");
    });

    it("reports connected after open", () => {
      const { nm, ws } = connectAndOpen();
      expect(nm.connected).toBe(true);
      void nm;
      void ws;
    });

    it("sends a ping on open", () => {
      const { ws } = connectAndOpen();
      const pingMsg = ws.sent.find((s) => JSON.parse(s).type === "ping");
      expect(pingMsg).toBeDefined();
    });
  });

  describe("message routing", () => {
    it("routes lobby message to onLobby", () => {
      const rooms = [
        { id: "r1", name: "Match", status: "waiting", joinCode: "AAAAA", isPrivate: false, players: 1, mode: "casual" },
      ];
      let received: unknown = null;
      const nm = new NetworkManager({
        ...makeCallbacks(),
        onLobby: (r) => {
          received = r;
        },
      });
      nm.connect("ws://localhost/ws");
      lastWs!.simulateOpen();
      lastWs!.simulateMessage({ type: "lobby", rooms });
      expect(received).toEqual(rooms);
    });

    it("routes waiting message to onWaiting", () => {
      let result: unknown = null;
      const nm = new NetworkManager({
        ...makeCallbacks(),
        onWaiting: (id, name, code) => {
          result = { id, name, code };
        },
      });
      nm.connect("ws://localhost/ws");
      lastWs!.simulateOpen();
      lastWs!.simulateMessage({ type: "waiting", roomId: "r1", roomName: "Test", joinCode: "ABCDE" });
      expect(result).toEqual({ id: "r1", name: "Test", code: "ABCDE" });
    });

    it("routes error message to onError", () => {
      let errMsg = "";
      const nm = new NetworkManager({
        ...makeCallbacks(),
        onError: (m) => {
          errMsg = m;
        },
      });
      nm.connect("ws://localhost/ws");
      lastWs!.simulateOpen();
      lastWs!.simulateMessage({ type: "error", message: "Test error" });
      expect(errMsg).toBe("Test error");
    });

    it("routes round_end message to onRoundEnd", () => {
      let result: unknown = null;
      const nm = new NetworkManager({
        ...makeCallbacks(),
        onRoundEnd: (r, w, rw) => {
          result = { r, w, rw };
        },
      });
      nm.connect("ws://localhost/ws");
      lastWs!.simulateOpen();
      lastWs!.simulateMessage({ type: "round_end", round: 1, winner: 0, roundWins: [1, 0] });
      expect(result).toEqual({ r: 1, w: 0, rw: [1, 0] });
    });

    it("routes round_start message to onRoundStart", () => {
      let result: unknown = null;
      const nm = new NetworkManager({
        ...makeCallbacks(),
        onRoundStart: (r, s, m) => {
          result = { r, s, m };
        },
      });
      nm.connect("ws://localhost/ws");
      lastWs!.simulateOpen();
      lastWs!.simulateMessage({ type: "round_start", round: 2, seed: 42, mapIndex: 1 });
      expect(result).toEqual({ r: 2, s: 42, m: 1 });
    });

    it("routes tournament_lobby message to onTournamentLobby", () => {
      let received: unknown = null;
      const nm = new NetworkManager({
        ...makeCallbacks(),
        onTournamentLobby: (msg) => {
          received = msg;
        },
      });
      nm.connect("ws://localhost/ws");
      lastWs!.simulateOpen();
      const lobbyMsg = {
        type: "tournament_lobby",
        tournamentId: "t1",
        joinCode: "TCODE",
        participants: [],
        status: "waiting",
        config: { bracketType: "winners_only", matchFormat: "bo3" },
        hostSlot: 0,
      };
      lastWs!.simulateMessage(lobbyMsg);
      expect((received as { tournamentId: string }).tournamentId).toBe("t1");
    });

    it("ignores malformed JSON messages", () => {
      const nm = new NetworkManager(makeCallbacks());
      nm.connect("ws://localhost/ws");
      lastWs!.simulateOpen();
      // Should not throw
      lastWs!.onmessage?.({ data: "not json{{{" });
    });
  });

  describe("RTT calculation (EWMA)", () => {
    it("initialises RTT on first pong", () => {
      const { nm, ws } = connectAndOpen();
      const sentT = Date.now() - 50;
      ws.simulateMessage({ type: "pong", t: sentT });
      expect(nm.rtt).toBeGreaterThan(0);
    });

    it("discards outlier pong samples (>2s)", () => {
      const { nm, ws } = connectAndOpen();
      // First, set a baseline
      ws.simulateMessage({ type: "pong", t: Date.now() - 30 });
      const baseline = nm.rtt;
      // Now send a >2s outlier — should be discarded
      ws.simulateMessage({ type: "pong", t: Date.now() - 5000 });
      expect(nm.rtt).toBe(baseline);
    });

    it("uses faster alpha when sample is higher than current RTT", () => {
      const { nm, ws } = connectAndOpen();
      // Set baseline of ~20ms
      ws.simulateMessage({ type: "pong", t: Date.now() - 20 });
      const baseline = nm.rtt;
      // Now send a spike — faster alpha (0.5) should move RTT towards it quickly
      ws.simulateMessage({ type: "pong", t: Date.now() - 200 });
      const afterSpike = nm.rtt;
      expect(afterSpike).toBeGreaterThan(baseline);
    });
  });

  describe("sendInput() throttling", () => {
    it("sends input when it changes", () => {
      const { ws } = connectAndOpen();
      const nm2 = new NetworkManager(makeCallbacks());
      nm2.connect("ws://localhost/ws");
      lastWs!.simulateOpen();
      const ws2 = lastWs!;
      nm2.sendInput({ buttons: 1, aimX: 0, aimY: 0 });
      const inputSent = ws2.sent.some((s) => JSON.parse(s).type === "input");
      expect(inputSent).toBe(true);
      void ws;
    });

    it("suppresses identical input", () => {
      const nm = new NetworkManager(makeCallbacks());
      nm.connect("ws://localhost/ws");
      lastWs!.simulateOpen();
      const ws = lastWs!;
      const input = { buttons: 5, aimX: 10, aimY: 20 };
      nm.sendInput(input);
      const countBefore = ws.sent.filter((s) => JSON.parse(s).type === "input").length;
      nm.sendInput(input); // same — should not send again
      const countAfter = ws.sent.filter((s) => JSON.parse(s).type === "input").length;
      expect(countAfter).toBe(countBefore);
    });

    it("sends again after resetThrottle()", () => {
      const nm = new NetworkManager(makeCallbacks());
      nm.connect("ws://localhost/ws");
      lastWs!.simulateOpen();
      const ws = lastWs!;
      const input = { buttons: 3, aimX: 0, aimY: 0 };
      nm.sendInput(input);
      nm.resetThrottle();
      nm.sendInput(input); // same input but throttle reset — should send
      const inputMsgs = ws.sent.filter((s) => JSON.parse(s).type === "input");
      expect(inputMsgs.length).toBe(2);
    });
  });

  describe("disconnect()", () => {
    it("closes the WebSocket intentionally (no reconnect callback)", () => {
      let disconnectCalled = false;
      const nm = new NetworkManager({
        ...makeCallbacks(),
        onDisconnect: () => {
          disconnectCalled = true;
        },
      });
      nm.connect("ws://localhost/ws");
      lastWs!.simulateOpen();
      nm.disconnect();
      // Intentional disconnect should NOT fire onDisconnect
      expect(disconnectCalled).toBe(false);
    });

    it("fires onDisconnect on unexpected close", () => {
      let disconnectCalled = false;
      const nm = new NetworkManager({
        ...makeCallbacks(),
        onDisconnect: () => {
          disconnectCalled = true;
        },
      });
      nm.connect("ws://localhost/ws");
      lastWs!.simulateOpen();
      lastWs!.simulateClose(); // unexpected close
      expect(disconnectCalled).toBe(true);
    });
  });

  describe("send helpers", () => {
    it("sendSetUsername sends correct message", () => {
      const { nm, ws } = connectAndOpen();
      nm.sendSetUsername("TestUser");
      const msg = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === "set_username");
      expect(msg).toMatchObject({ type: "set_username", username: "TestUser" });
    });

    it("sendSetWallet sends correct message", () => {
      const { nm, ws } = connectAndOpen();
      nm.sendSetWallet("GADDR123", true);
      const msg = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === "set_wallet");
      expect(msg).toMatchObject({ type: "set_wallet", address: "GADDR123", verified: true });
    });

    it("sendLeave sends leave message", () => {
      const { nm, ws } = connectAndOpen();
      nm.sendLeave();
      const msg = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === "leave");
      expect(msg).toBeDefined();
    });
  });
});
