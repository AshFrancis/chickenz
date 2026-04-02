import Phaser from "phaser";
import { PLAYER_WIDTH, PLAYER_HEIGHT, PlayerStateFlag } from "@chickenz/sim";
import type { MatchConfig } from "@chickenz/sim";
import type { StateMessage } from "../../../../services/server/src/protocol";
import { DPR, VIEW_W, VIEW_H } from "../game";
import { lerp, smoothLerp } from "./constants";

/** Game state data -- shared shape of StateMessage and WASM exports */
type GameStateData = Omit<StateMessage, "type">;

export class CameraSystem {
  currentZoom = 1.0;
  cameraX = 480;
  cameraY = 270;
  dynamicZoom = true;
  hudCamera!: Phaser.Cameras.Scene2D.Camera;

  constructor(private scene: Phaser.Scene) {}

  applyCam(cam: Phaser.Cameras.Scene2D.Camera) {
    cam.setZoom(this.currentZoom * DPR);
    cam.centerOn(this.cameraX, this.cameraY);
    cam.scrollX = Math.round(cam.scrollX);
    cam.scrollY = Math.round(cam.scrollY);
  }

  updateCamera(
    curr: GameStateData,
    predicted: GameStateData | null,
    delta: number,
    context: {
      config: MatchConfig | null;
      warmupConfig: MatchConfig | null;
      warmupMode: boolean;
      tutorialMode: boolean;
      localPlayerId: number;
      roundTransition: boolean;
    },
  ) {
    const cam = this.scene.cameras.main;
    const { config, warmupConfig, warmupMode, tutorialMode, localPlayerId, roundTransition } = context;

    // Fixed zoom mode: show whole arena, centered (with padding so edges aren't clipped)
    if (!this.dynamicZoom && !warmupMode && !tutorialMode) {
      const mapW = config?.map.width ?? 960;
      const mapH = config?.map.height ?? 540;
      const PAD = 40;
      const fitZoom = Math.min(VIEW_W / (mapW + PAD * 2), VIEW_H / (mapH + PAD * 2));
      this.currentZoom = smoothLerp(this.currentZoom, fitZoom, 0.1, delta);
      this.cameraX = smoothLerp(this.cameraX, mapW / 2, 0.15, delta);
      this.cameraY = smoothLerp(this.cameraY, mapH / 2, 0.15, delta);
      this.applyCam(cam);
      return;
    }

    // Local player from predicted state, remote from server state (curr)
    const localP = (predicted ?? curr).players[localPlayerId];
    const remoteP = curr.players[1 - localPlayerId];

    // Warmup or single-player
    if (!localP || !remoteP || warmupMode || tutorialMode) {
      if ((warmupMode || tutorialMode) && this.dynamicZoom && localP) {
        // Dynamic zoom in warmup: follow the player
        const aliveLocal = !!(localP.stateFlags & PlayerStateFlag.Alive);
        const targetX = aliveLocal ? localP.x + PLAYER_WIDTH / 2 : 480;
        const targetY = aliveLocal ? localP.y + PLAYER_HEIGHT / 2 : 270;
        this.currentZoom = smoothLerp(this.currentZoom, 1.3, 0.05, delta);
        this.cameraX = smoothLerp(this.cameraX, targetX, 0.15, delta);
        this.cameraY = smoothLerp(this.cameraY, targetY, 0.15, delta);
      } else {
        // Static zoom: show full arena
        const mapW = (warmupMode || tutorialMode ? warmupConfig?.map.width : config?.map.width) ?? 960;
        const mapH = (warmupMode || tutorialMode ? warmupConfig?.map.height : config?.map.height) ?? 540;
        const PAD = 40;
        const fitZoom = Math.min(VIEW_W / (mapW + PAD * 2), VIEW_H / (mapH + PAD * 2));
        this.currentZoom = smoothLerp(this.currentZoom, fitZoom, 0.05, delta);
        this.cameraX = smoothLerp(this.cameraX, mapW / 2, 0.15, delta);
        this.cameraY = smoothLerp(this.cameraY, mapH / 2, 0.15, delta);
      }
      this.applyCam(cam);
      return;
    }

    const aliveLocal = !!(localP.stateFlags & PlayerStateFlag.Alive);
    const aliveRemote = !!(remoteP.stateFlags & PlayerStateFlag.Alive);

    let targetZoom: number;
    let targetX: number;
    let targetY: number;

    // During round transition, stay zoomed on the winner
    const killZoom = roundTransition || (predicted ?? curr).deathLingerTimer > 0;

    if (aliveLocal && aliveRemote) {
      const dist = Math.hypot(localP.x - remoteP.x, localP.y - remoteP.y);
      targetZoom = dist < 250 ? 1.3 : dist > 500 ? 1.0 : lerp(1.3, 1.0, (dist - 250) / 250);
      targetX = (localP.x + remoteP.x) / 2 + PLAYER_WIDTH / 2;
      targetY = (localP.y + remoteP.y) / 2 + PLAYER_HEIGHT / 2;

      // Ensure both players fit in viewport (critical for narrow windows)
      const PAD = 80; // pixels of padding around players
      const needW = Math.abs(localP.x - remoteP.x) + PLAYER_WIDTH + PAD * 2;
      const needH = Math.abs(localP.y - remoteP.y) + PLAYER_HEIGHT + PAD * 2;
      const fitZoom = Math.min(VIEW_W / needW, VIEW_H / needH);
      if (fitZoom < targetZoom) targetZoom = fitZoom;
    } else if (aliveLocal) {
      targetZoom = killZoom ? 1.5 : 1.0;
      targetX = localP.x + PLAYER_WIDTH / 2;
      targetY = localP.y + PLAYER_HEIGHT / 2;
    } else if (aliveRemote) {
      targetZoom = killZoom ? 1.5 : 1.0;
      targetX = remoteP.x + PLAYER_WIDTH / 2;
      targetY = remoteP.y + PLAYER_HEIGHT / 2;
    } else {
      targetZoom = killZoom ? 1.5 : 1.0;
      targetX = 480;
      targetY = 270;
    }

    this.currentZoom = smoothLerp(this.currentZoom, targetZoom, 0.05, delta);
    this.cameraX = smoothLerp(this.cameraX, targetX, 0.15, delta);
    this.cameraY = smoothLerp(this.cameraY, targetY, 0.15, delta);
    this.applyCam(cam);
  }

  /** Handle browser window resize -- reposition HUD, update cameras, resize background. */
  handleResize(config: MatchConfig | null) {
    // Update main camera bounds and zoom
    const mapW = config?.map?.width ?? 960;
    const mapH = config?.map?.height ?? 540;
    const padX = VIEW_W / 2;
    const padY = VIEW_H / 2;
    this.scene.cameras.main.setBounds(-padX, -padY, mapW + padX * 2, mapH + padY * 2);
    this.scene.cameras.main.setZoom(this.currentZoom * DPR);

    // Update HUD camera viewport and zoom
    if (this.hudCamera) {
      this.hudCamera.setSize(Math.round(VIEW_W * DPR), Math.round(VIEW_H * DPR));
      this.hudCamera.setZoom(DPR);
    }
  }
}
