/** Pure formatting utilities for display. No DOM access, no side effects. */

export const GUEST_IMAGE_ID = "c69a2804afae47c1bee35e0a80013d9dad8a4f096d1b5bfa53d870c8e8d43746";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatTimestamp(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatDuration(startMs: number, endMs: number): string {
  const s = Math.round((endMs - startMs) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function explorerTxUrl(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(hash)}`;
}

export function explorerAccountUrl(addr: string): string {
  return `https://stellar.expert/explorer/testnet/account/${encodeURIComponent(addr)}`;
}

export function explorerContractUrl(addr: string): string {
  return `https://stellar.expert/explorer/testnet/contract/${encodeURIComponent(addr)}`;
}

export function proofStatusLabel(status: string): string {
  switch (status) {
    case "none":
      return "Casual";
    case "pending":
    case "proving":
      return "Generating Proof";
    case "verified":
      return "Proof Verified";
    case "settled":
      return "Settled";
    default:
      return status;
  }
}
