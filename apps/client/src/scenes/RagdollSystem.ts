export interface RagdollState {
  active: boolean;
  settled: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  angularVel: number;
  bounces: number;
  wasAlive: boolean;
}

export function makeRagdoll(): RagdollState {
  return { active: false, settled: false, x: 0, y: 0, vx: 0, vy: 0, rotation: 0, angularVel: 0, bounces: 0, wasAlive: false };
}

export function resetRagdoll(r: RagdollState): void {
  r.active = false;
  r.settled = false;
  r.rotation = 0;
  r.angularVel = 0;
  r.bounces = 0;
  r.wasAlive = false;
}
