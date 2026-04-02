import Phaser from "phaser";
import { WeaponType, PlayerStateFlag } from "@chickenz/sim";
import type { StateMessage } from "../../../../services/server/src/protocol";
import { playSFX } from "../audio/sfx";

/** Game state data -- shared shape of StateMessage and WASM exports */
type GameStateData = Omit<StateMessage, "type">;

export class AudioManager {
  private musicMuted = false;
  private bgm: Phaser.Sound.BaseSound | null = null;
  private bgmLoading = false;
  private audioLoaded = false;
  bgmVolume = 0.1;
  sfxVolume = 0.8;
  private lastBgmTrack = 0;
  private fadeTimers: ReturnType<typeof setInterval>[] = [];

  constructor(private scene: Phaser.Scene) {}

  /** Mark audio assets as loaded. Called from preload complete callback. */
  setAudioLoaded() {
    this.audioLoaded = true;
  }

  get isAudioLoaded(): boolean {
    return this.audioLoaded;
  }

  // ── SFX ──────────────────────────────────────────────────────────────────

  playSound(key: string) {
    if (this.sfxVolume === 0) return;
    if (this.audioLoaded && this.scene.cache.audio.exists(key)) {
      try {
        this.scene.sound.play(key, { volume: this.sfxVolume });
        return;
      } catch {
        /* fall through */
      }
    }
    playSFX(key, this.sfxVolume);
  }

  /** Play a sound, stopping any previous instance first (for spammable SFX like taunt). */
  playSoundInterrupt(key: string) {
    if (this.sfxVolume === 0) return;
    if (this.audioLoaded && this.scene.cache.audio.exists(key)) {
      try {
        this.scene.sound.stopByKey(key);
        this.scene.sound.play(key, { volume: this.sfxVolume });
        return;
      } catch {
        /* fall through */
      }
    }
    playSFX(key, this.sfxVolume);
  }

  // ── Volume fade ──────────────────────────────────────────────────────────

  /** Smoothly fade a WebAudio track's volume from `from` to `to` over `ms` milliseconds. */
  fadeVolume(track: Phaser.Sound.WebAudioSound, from: number, to: number, ms: number) {
    const steps = 20;
    const interval = ms / steps;
    let step = 0;
    const timer = setInterval(() => {
      step++;
      try {
        track.volume = from + (to - from) * (step / steps);
      } catch {
        clearInterval(timer);
        this.fadeTimers = this.fadeTimers.filter((t) => t !== timer);
        return;
      }
      if (step >= steps) {
        clearInterval(timer);
        this.fadeTimers = this.fadeTimers.filter((t) => t !== timer);
      }
    }, interval);
    this.fadeTimers.push(timer);
  }

  /** Clear all pending fade intervals (for cleanup). */
  clearFadeTimers() {
    for (const t of this.fadeTimers) clearInterval(t);
    this.fadeTimers = [];
  }

  // ── BGM ──────────────────────────────────────────────────────────────────

  private pickBgmTrack(): string {
    const TRACK_COUNT = 5;
    let track: number;
    do {
      track = 1 + Math.floor(Math.random() * TRACK_COUNT);
    } while (track === this.lastBgmTrack && TRACK_COUNT > 1);
    this.lastBgmTrack = track;
    return `bgm-${track}`;
  }

  /** Start BGM if not already playing. Idempotent -- safe to call multiple times. */
  startBGM() {
    if (this.bgmVolume === 0 || !this.audioLoaded || this.musicMuted) return;
    if (this.bgm?.isPlaying || this.bgmLoading) return;
    this.playNextTrack();
  }

  private playNextTrack() {
    if (this.bgmVolume === 0 || !this.audioLoaded || this.musicMuted) return;
    try {
      const key = this.pickBgmTrack();
      if (!this.scene.cache.audio.exists(key)) {
        this.bgmLoading = true;
        this.scene.load.audio(key, `/audio/${key}.mp3`);
        this.scene.load.once("complete", () => {
          this.bgmLoading = false;
          this.startTrack(key);
        });
        this.scene.load.start();
        return;
      }
      this.startTrack(key);
    } catch {
      // BGM not available
    }
  }

  private startTrack(key: string) {
    try {
      const newTrack = this.scene.sound.add(key, {
        loop: false,
        volume: this.bgmVolume,
      }) as Phaser.Sound.WebAudioSound;
      if (this.bgm?.isPlaying && "volume" in this.bgm) {
        const oldTrack = this.bgm as Phaser.Sound.WebAudioSound;
        this.fadeVolume(oldTrack, oldTrack.volume, 0, 1000);
        setTimeout(() => {
          oldTrack.stop();
          oldTrack.destroy();
        }, 1050);
      } else if (this.bgm) {
        this.bgm.destroy();
      }
      this.bgm = newTrack;
      newTrack.on("complete", () => this.playNextTrack());
      newTrack.play();
    } catch {
      // BGM not available
    }
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  setMusicMuted(muted: boolean) {
    this.musicMuted = muted;
    if (muted) {
      this.bgmLoading = false;
      if (this.bgm) {
        this.bgm.stop();
        this.bgm.destroy();
        this.bgm = null;
      }
    } else {
      this.startBGM();
    }
  }

  get isMusicMuted(): boolean {
    return this.musicMuted;
  }

  setBGMVolume(vol: number) {
    this.bgmVolume = vol;
    if (this.bgm && "volume" in this.bgm) {
      (this.bgm as Phaser.Sound.WebAudioSound).volume = vol;
    }
  }

  setSFXVolume(vol: number) {
    this.sfxVolume = vol;
  }

  // ── Audio event detection ────────────────────────────────────────────────

  detectAudioEvents(prev: GameStateData, curr: GameStateData) {
    // New projectiles -> shoot sound (detect by ID, not count, since old ones expire)
    const prevIds = new Set(prev.projectiles.map((p) => p.id));
    for (const proj of curr.projectiles) {
      if (!prevIds.has(proj.id)) {
        if (proj.weapon === WeaponType.SMG) {
          this.playSound("shoot-smg");
        } else {
          this.playSoundInterrupt("shoot");
        }
        break; // one sound per frame is enough
      }
    }

    // Per-player events
    for (let i = 0; i < curr.players.length; i++) {
      const pp = prev.players[i];
      const cp = curr.players[i];
      if (pp && cp) {
        if (cp.health < pp.health && cp.health > 0) {
          this.playSound("hit");
        }
        if (pp.stateFlags & PlayerStateFlag.Alive && !(cp.stateFlags & PlayerStateFlag.Alive)) {
          this.playSound("death");
        }
        if (cp.weapon !== null && cp.weapon >= 0 && cp.weapon !== pp.weapon) {
          this.playSound("pickup");
        }
        // Jump: jumpsLeft decreased while alive
        if (cp.jumpsLeft < pp.jumpsLeft && cp.stateFlags & PlayerStateFlag.Alive) {
          this.playSound("jump");
        }
      }
    }
  }

  // ── Focus fade helpers (called from scene create) ────────────────────────

  /** Set up blur/focus/visibility handlers to fade BGM in and out. */
  setupFocusFade() {
    let bgmFadedOut = false;
    const fadeOut = () => {
      if (bgmFadedOut) return;
      bgmFadedOut = true;
      if (!this.bgm || !this.bgm.isPlaying) return;
      this.fadeVolume(this.bgm as Phaser.Sound.WebAudioSound, (this.bgm as Phaser.Sound.WebAudioSound).volume, 0, 400);
    };
    const fadeIn = () => {
      if (!bgmFadedOut) return;
      if (document.hidden || !document.hasFocus()) return;
      bgmFadedOut = false;
      if (!this.bgm) return;
      const ctx = (this.scene.sound as Phaser.Sound.WebAudioSoundManager).context;
      if (ctx.state === "suspended") void ctx.resume();
      this.fadeVolume(this.bgm as Phaser.Sound.WebAudioSound, 0, this.bgmVolume, 400);
    };
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) fadeOut();
      else fadeIn();
    });
    window.addEventListener("blur", fadeOut);
    window.addEventListener("focus", fadeIn);
  }
}
