// Small shared formatters for the duty / activity views.

export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Math.floor((Date.now() - t) / 1000);
  if (diff < 0) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
}

// "Today" as the server counts it: the Ride91 business day runs 04:00 to
// 04:00 IST, so at 1 a.m. today is still yesterday's date. Using the calendar
// date here made the duty views open on an empty, not-yet-started day after
// midnight.
const BUSINESS_DAY_START_HOUR = 4;
export function todayISO(): string {
  const shifted = new Date(Date.now() - BUSINESS_DAY_START_HOUR * 3600 * 1000);
  return shifted.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
}

const PLATFORM_COLOR: Record<string, string> = {
  uber: "#111827",
  rapido: "#d9a400",
  ola: "#3a9e3f",
};
export function platformColor(p: string): string {
  return PLATFORM_COLOR[p] ?? "var(--muted)";
}
