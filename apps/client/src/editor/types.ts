export interface EditorTile {
  id: number;
  gridX: number;
  gridY: number;
  frame: number;
  rotation: number; // 0, 90, 180, 270
  collision: boolean;
  depth: number;
}

export interface EditorSpawn {
  type: "player" | "weapon";
  gridX: number;
  gridY: number;
}

export interface EditorMap {
  width: number;
  height: number;
  tiles: EditorTile[];
  spawns: EditorSpawn[];
  bgCells: { gridX: number; gridY: number }[];
  bgColor: string;
}

export interface Command {
  execute(): void;
  undo(): void;
}

export type Tool = "paint" | "erase" | "select" | "spawn" | "bg";

export type SpawnSubMode = "player" | "weapon";

export const TILE_SIZE = 16;
export const TERRAIN_COLS = 22;
export const TERRAIN_ROWS = 11;
export const MAP_WIDTH = 960;
export const MAP_HEIGHT = 540;
export const GRID_COLS = MAP_WIDTH / TILE_SIZE; // 60
export const GRID_ROWS = MAP_HEIGHT / TILE_SIZE; // 33.75 → 34

export const BG_KEYS = ["blue", "brown", "gray", "green", "pink", "purple", "yellow"] as const;
