const K = 32;
const DEFAULT_ELO = 1000;

interface PlayerStats {
  elo: number;
  wins: number;
  losses: number;
}

const players = new Map<string, PlayerStats>();

function getOrCreate(name: string): PlayerStats {
  let stats = players.get(name);
  if (!stats) {
    stats = { elo: DEFAULT_ELO, wins: 0, losses: 0 };
    players.set(name, stats);
  }
  return stats;
}

/** Calculate expected score for player A against player B. */
function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/** Update ELO ratings after a match. Returns new ratings. */
export function updateElo(
  winnerName: string,
  loserName: string,
): { winnerElo: number; loserElo: number } {
  const winner = getOrCreate(winnerName);
  const loser = getOrCreate(loserName);

  const expectedW = expectedScore(winner.elo, loser.elo);
  const expectedL = expectedScore(loser.elo, winner.elo);

  winner.elo = Math.round(winner.elo + K * (1 - expectedW));
  loser.elo = Math.round(loser.elo + K * (0 - expectedL));
  winner.wins++;
  loser.losses++;

  return { winnerElo: winner.elo, loserElo: loser.elo };
}

export interface LeaderboardEntry {
  name: string;
  elo: number;
  wins: number;
  losses: number;
}

/** Get top N players by ELO. */
export function getLeaderboard(limit: number = 20): LeaderboardEntry[] {
  return [...players.entries()]
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.elo - a.elo)
    .slice(0, limit);
}

/** Get a player's stats. */
export function getPlayerStats(name: string): LeaderboardEntry | null {
  const stats = players.get(name);
  if (!stats) return null;
  return { name, ...stats };
}
