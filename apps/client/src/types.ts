import type { GameMode } from "./net/NetworkManager";

export interface MatchRecord {
  id: string;
  roomName: string;
  player1: string;
  player2: string;
  wallet1?: string;
  wallet2?: string;
  wallet1Verified?: boolean;
  wallet2Verified?: boolean;
  winner: number;
  scores: [number, number];
  timestamp: number;
  proofStatus: "none" | "pending" | "proving" | "verified" | "settled";
  roomId: string;
  mode?: GameMode;
  matchStartTime?: number;
  proofRequestedAt?: number;
  proofCompletedAt?: number;
  proofSource?: string;
  startTxHash?: string;
  settleTxHash?: string;
  proofArtifacts?: { seal: string; journal: string; imageId: string };
  contractAddress?: string;
  verifierAddress?: string;
  gameHubAddress?: string;
  transcriptCid?: string;
  boundlessRequestId?: string;
  boundlessTxHash?: string;
  sessionId?: number;
  _regionUrl?: string; // client-side: which region server this match came from
  _regionId?: string;
}
