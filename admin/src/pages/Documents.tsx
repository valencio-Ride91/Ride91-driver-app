// Document review queue — same shape as Captures but simpler.
import { useEffect, useState } from "react";
import { api, DocumentRow } from "../api";

interface Media { image_b64: string | null; }

const STATUS_META: Record<string, { label: string; klass: string }> = {
  expired: { label: "Expired", klass: "alert" },
  expiring_soon: { label: "Renew ≤30d", klass: "warn" },
  ok: { label: "Valid", klass: "ok" },
  missing: { label: "Missing", klass: "muted" },
};

export default function Documents() {
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [includeAll, setIncludeAll] = useState(false);
  const [selected, setSelected] = useState<DocumentRow | null>(null);
  const [media, setMedia] = useState<Media | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = async () => {
    const r = await api.get<{ items: DocumentRow[] }>(
      `/admin/documents/pending?include_all=${includeAll}`,
    );
    setRows(r.items);
  };

  useEffect(() => {
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeAll]);

  const pickOne = async (r: DocumentRow) => {
    setSelected(r);
    setMedia(null);
    setNote("");
    setMediaLoading(true);
    try {
      const m = await api.get<Media>(`/admin/documents/${r.id}/media`);
      setMedia(m);
    } finally {
      setMediaLoading(false);
    }
  };

  const decide = async (decision: "approve" | "reject") => {
    if (!selected) return;
    setSaving(true);
    try {
      await api.post(`/admin/documents/${selected.id}/review`, { decision, note: note || null });
      setToast(`Marked ${decision}`);
      setTimeout(() => setToast(null), 1800);
      await load();
      setSelected(null);
      setMedia(null);
      setNote("");
    } catch (e: any) {
      setToast(e?.body?.detail ?? "Failed to save");
      setTimeout(() => setToast(null), 2500);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h1>Document reviews</h1>
      <div className="sub" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>{rows.length} to verify · drivers who uploaded but not yet approved</span>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={includeAll}
            onChange={(e) => setIncludeAll(e.target.checked)}
            style={{ width: "auto" }}
          />
          Show all documents
        </label>
      </div>

      <div className="review-split">
        <ul className="review-list">
          {rows.length === 0 ? (
            <div className="empty">
              {includeAll ? "No documents on file." : "Nothing pending — all up to date."}
            </div>
          ) : rows.map((r) => (
            <li
              key={r.id}
              className={"review-item " + (selected?.id === r.id ? "active" : "")}
              onClick={() => pickOne(r)}
            >
              <div className="title">{r.driver_name ?? "unknown"}</div>
              <div className="meta">
                {r.label} · {r.number ?? "no number"}
              </div>
              <div className="meta" style={{ marginTop: 4 }}>
                <span className={"tag " + (STATUS_META[r.status]?.klass ?? "muted")}>
                  {STATUS_META[r.status]?.label ?? r.status}
                </span>
                {r.verified ? <span className="tag ok" style={{ marginLeft: 4 }}>verified</span> : null}
              </div>
            </li>
          ))}
        </ul>

        <div className="card">
          {!selected ? (
            <div className="empty">Pick a document from the list to verify.</div>
          ) : (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>{selected.label}</div>
                  <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 2 }}>
                    {selected.driver_name} · {selected.driver_phone}
                  </div>
                </div>
                <span className={"tag " + (STATUS_META[selected.status]?.klass ?? "muted")}>
                  {STATUS_META[selected.status]?.label ?? selected.status}
                </span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: 16 }}>
                <Kv label="Number" value={selected.number ?? "—"} />
                <Kv label="Expires on" value={selected.expires_on ?? "—"} warn={selected.status === "expired" || selected.status === "expiring_soon"} />
                <Kv label="Verified" value={selected.verified ? "Yes" : "No"} />
              </div>

              <div style={{ marginTop: 20 }}>
                <div className="kicker" style={{ fontSize: 11, color: "var(--muted)", letterSpacing: 1, textTransform: "uppercase", fontWeight: 700, marginBottom: 8 }}>
                  Uploaded image
                </div>
                {mediaLoading ? (
                  <div className="empty" style={{ padding: 24 }}>Loading…</div>
                ) : media?.image_b64 ? (
                  <img
                    src={media.image_b64}
                    alt={selected.label}
                    style={{ maxWidth: "100%", maxHeight: 480, borderRadius: 8, border: "1px solid var(--line)" }}
                  />
                ) : (
                  <div className="empty">No image uploaded yet.</div>
                )}
              </div>

              <div style={{ marginTop: 20 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6, display: "block" }}>
                  Review note (optional)
                </label>
                <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>

              <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
                <button className="primary" disabled={saving || !media?.image_b64} onClick={() => decide("approve")}>
                  {saving ? "…" : "Approve"}
                </button>
                <button className="danger" disabled={saving} onClick={() => decide("reject")}>
                  {saving ? "…" : "Reject"}
                </button>
                <button disabled={saving} onClick={() => setSelected(null)} style={{ marginLeft: "auto" }}>
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {toast ? (
        <div style={{ position: "fixed", bottom: 24, right: 24, background: "var(--ink)", color: "#fff", padding: "12px 18px", borderRadius: 8 }}>
          {toast}
        </div>
      ) : null}
    </div>
  );
}

const Kv = ({ label, value, warn }: { label: string; value: string; warn?: boolean }) => (
  <div>
    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</div>
    <div style={{ fontSize: 18, fontWeight: 600, color: warn ? "var(--alert)" : "var(--ink)", marginTop: 4 }}>{value}</div>
  </div>
);
