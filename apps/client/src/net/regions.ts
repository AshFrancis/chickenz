export interface RegionConfig {
  id: string;
  name: string;
  flag: string;
  wsUrl: string;
  httpUrl: string;
}

export const REGIONS: RegionConfig[] = [
  { id: "eu", name: "Europe", flag: "EU", wsUrl: "wss://eu.chickenz.io/ws", httpUrl: "https://eu.chickenz.io" },
  { id: "us", name: "US", flag: "US", wsUrl: "wss://us.chickenz.io/ws", httpUrl: "https://us.chickenz.io" },
  { id: "asia", name: "Asia", flag: "AS", wsUrl: "wss://asia.chickenz.io/ws", httpUrl: "https://asia.chickenz.io" },
];

export const DEV_REGIONS: RegionConfig[] = [
  { id: "local", name: "Local", flag: "DEV", wsUrl: "ws://localhost:3000/ws", httpUrl: "http://localhost:3000" },
];

export function getRegions(): RegionConfig[] {
  const isDev = location.port === "5173" || location.port === "5174";
  return isDev ? DEV_REGIONS : REGIONS;
}

export const PING_THRESHOLD_MS = 160;
