import { escapeHtml } from "./format";
import { getRegions } from "../net/regions";

let fetchingLeaderboard = false;

export function fetchLeaderboard(container: HTMLElement, currentUsername: string): void {
  if (fetchingLeaderboard) return;
  fetchingLeaderboard = true;
  const regions = getRegions();
  const fetches = regions.map((r) =>
    fetch(`${r.httpUrl}/api/leaderboard`)
      .then((res) => res.json() as Promise<{ name: string; elo: number; wins: number; losses: number }[]>)
      .catch(() => [] as { name: string; elo: number; wins: number; losses: number }[]),
  );
  Promise.all(fetches)
    .then((results) => {
      // Merge by name: keep highest ELO, sum wins/losses across regions
      const merged = new Map<string, { name: string; elo: number; wins: number; losses: number }>();
      for (const entries of results) {
        for (const e of entries) {
          const existing = merged.get(e.name);
          if (existing) {
            existing.elo = Math.max(existing.elo, e.elo);
            existing.wins += e.wins;
            existing.losses += e.losses;
          } else {
            merged.set(e.name, { ...e });
          }
        }
      }
      const sorted = [...merged.values()].sort((a, b) => b.elo - a.elo);
      renderLeaderboard(container, sorted, currentUsername);
    })
    .catch(() => {
      container.innerHTML = `<div class="empty-state">Failed to load leaderboard</div>`;
    })
    .finally(() => {
      fetchingLeaderboard = false;
    });
}

export function renderLeaderboard(
  container: HTMLElement,
  data: { name: string; elo: number; wins: number; losses: number }[],
  currentUsername: string,
): void {
  if (data.length === 0) {
    container.innerHTML = `<div class="empty-state">No ranked players yet</div>`;
    return;
  }
  let html = `<table><tr><th>#</th><th>Name</th><th>ELO</th><th>W</th><th>L</th></tr>`;
  data.forEach((entry, i) => {
    const highlight = entry.name === currentUsername ? ' class="highlight"' : "";
    html += `<tr${highlight}><td>${i + 1}</td><td>${escapeHtml(entry.name)}</td><td>${entry.elo}</td><td>${entry.wins}</td><td>${entry.losses}</td></tr>`;
  });
  html += `</table>`;
  container.innerHTML = html;
}
