import type { NetworkManager, GameMode } from "./net/NetworkManager";

/** Shared mutable application session state. Imported directly by UI modules. */
export const session = {
  networkManager: null as NetworkManager | null,
  activeRegionId: "",
  currentUsername: "",
  currentMode: "casual" as GameMode,
  currentTournamentId: null as string | null,
  tournamentSpectating: false,
  inTutorialFlow: false,
  lastVerifiedAddr: null as string | null,
  verifyInProgress: null as string | null,
  pendingQuickplay: false,
  homeCharacter: 0,
  awayCharacter: 1,
  pendingCharacter: 0,
};

export type Session = typeof session;
