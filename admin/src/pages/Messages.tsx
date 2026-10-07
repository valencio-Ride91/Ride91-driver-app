// Messages — the inbox for what drivers write to the hub from the app's bell.
//
// One card per driver, unread first, newest first. Each card shows the
// driver's recent messages, a box to answer, and a link to the driver's page
// for the whole conversation. Answering a driver marks their messages read;
// "Mark read" does the same without answering.
//
// Opened from a hub it lists that hub's drivers only; from the menu it lists
// every driver the signed-in admin may see.
import { useCallback, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { api, NotificationRow } from "../api";
import { AdminIdentity } from "../auth";

interface Inbox {
  items: NotificationRow[];
  count: number;
  unread: number;
}

interface Thread {
  driver_id: string;
  name: string;
  phone: string | null;
  unread: number;
  last_at: string;
  messages: NotificationRow[];     // newest first
}

const SHOWN_PER_DRIVER = 4;

function fmtWhen(iso: string) {
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

function threads(items: NotificationRow[]): Thread[] {
  const by = new Map<string, Thread>();
  for (const n of items) {               // items arrive newest first
    let t = by.get(n.driver_id);
    if (!t) {
      t = { driver_id: n.driver_id, name: n.driver_name ?? n.driver_id.slice(0, 8), phone: n.driver_phone ?? null,
            unread: 0, last_at: n.created_at, messages: [] };
      by.set(n.driver_id, t);
    }
    t.messages.push(n);
    if (!n.read) t.unread += 1;
  }
  // Unread drivers first, then whoever wrote most recently.
  return [...by.values()].sort((a, b) =>
    (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) || b.last_at.localeCompare(a.last_at));
}

export default function Messages({ hubId }: { hubId?: string }) {
  const { admin } = useOutletContext<{ admin: AdminIdentity }>();
  const canReply = admin?.role !== "viewer";
  const [data, setData] = useState<Inbox | null>(null);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams();
      if (hubId) q.set("hub_id", hubId);
      if (onlyUnread) q.set("unread_only", "true");
      setData(await api.get<Inbox>(`/admin/notifications?${q.toString()}`));
    } catch {
      setErr("Could not load messages.");
    }
  }, [hubId, onlyUnread]);

  useEffect(() => {
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, [load]);

  const act = async (driverId: string, fn: () => Promise<unknown>, failMsg: string) => {
    setBusyId(driverId);
    setErr(null);
    try {
      await fn();
      await load();
      window.dispatchEvent(new Event("ride91:messages-changed"));   // refresh the menu badge
    } catch {
      setErr(failMsg);
    } finally {
      setBusyId(null);
    }
  };

  const reply = (t: Thread) => {
    const body = (drafts[t.driver_id] ?? "").trim();
    if (!body) return;
    act(t.driver_id, async () => {
      await api.post(`/admin/drivers/${t.driver_id}/notifications`, { body });
      setDrafts((d) => ({ ...d, [t.driver_id]: "" }));
    }, "Could not send the reply.");
  };

  const markRead = (t: Thread) =>
    act(t.driver_id, () => api.post(`/admin/drivers/${t.driver_id}/notifications/read`), "Could not mark as read.");

  const list = data ? threads(data.items) : [];

  return (
    <div>
      {hubId ? null : <h1>Messages</h1>}
      <div className="sub" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span>
          What drivers write from the app.{" "}
          {data ? (data.unread > 0
            ? <span className="tag alert" data-testid="messages-unread">{data.unread} unread</span>
            : <span className="tag muted">nothing unread</span>) : null}
        </span>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} style={{ width: "auto" }} />
          Unread only
        </label>
      </div>
      {err ? <div className="err" style={{ marginBottom: 12 }}>{err}</div> : null}

      {!data ? (
        <div className="card"><div className="empty">Loading…</div></div>
      ) : list.length === 0 ? (
        <div className="card">
          <div className="empty">{onlyUnread ? "No unread messages." : "No messages from drivers yet. Drivers write from the bell at the top of the app."}</div>
        </div>
      ) : list.map((t) => (
        <div key={t.driver_id} className="card" style={{ marginBottom: 12, borderLeft: t.unread ? "3px solid var(--alert)" : "3px solid transparent" }}
          data-testid={`thread-${t.driver_id}`}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
            <Link to={`/drivers/${t.driver_id}`} style={{ fontWeight: 700, color: "var(--ink)" }}>{t.name}</Link>
            {t.phone ? <span className="muted-sm" style={{ fontFamily: "ui-monospace, monospace" }}>{t.phone}</span> : null}
            {t.unread ? <span className="tag alert">{t.unread} new</span> : null}
            <span style={{ flex: 1 }} />
            <Link to={`/drivers/${t.driver_id}`} className="muted-sm">Whole conversation →</Link>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
            {t.messages.slice(0, SHOWN_PER_DRIVER).map((n) => (
              <div key={n.id} style={{ background: n.read ? "transparent" : "var(--line)", borderRadius: 8, padding: n.read ? "2px 0" : "6px 10px" }}>
                <div style={{ fontSize: 14, whiteSpace: "pre-wrap", fontWeight: n.read ? 400 : 600 }}>{n.body}</div>
                <div className="muted-sm">{fmtWhen(n.created_at)}</div>
              </div>
            ))}
            {t.messages.length > SHOWN_PER_DRIVER
              ? <div className="muted-sm">+ {t.messages.length - SHOWN_PER_DRIVER} earlier</div> : null}
          </div>

          {canReply ? (
            <div style={{ display: "flex", gap: 8 }}>
              <input
                placeholder={`Reply to ${t.name}…`}
                value={drafts[t.driver_id] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [t.driver_id]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") reply(t); }}
                style={{ flex: 1 }}
              />
              <button className="primary" onClick={() => reply(t)} disabled={busyId === t.driver_id || !(drafts[t.driver_id] ?? "").trim()}>
                {busyId === t.driver_id ? "…" : "Reply"}
              </button>
              {t.unread ? (
                <button className="ghost" onClick={() => markRead(t)} disabled={busyId === t.driver_id}>Mark read</button>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
