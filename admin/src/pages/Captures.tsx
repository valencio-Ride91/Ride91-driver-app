// Capture review queue — list on left, media detail on right.
import { useEffect, useState } from "react";
import { api, CaptureRow } from "../api";

interface Media {
  walkaround_video_b64: string | null;
  walkaround_video_mime: string | null;
  selfie_photo_b64: string | null;
}

export default function Captures() {
  const [rows, setRows] = useState<CaptureRow[]>([]);
  const [includeAll, setIncludeAll] = useState(false);
  const [selected, setSelected] = useState<CaptureRow | null>(null);
  const [media, setMedia] = useState<Media | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = async () => {
    const r = await api.get<{ items: CaptureRow[] }>(
      `/admin/captures/pending?include_all=${includeAll}`,
    );
    setRows(r.items);
  };

  useEffect(() => {
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeAll]);

  const pickOne = async (r: CaptureRow) => {
    setSelected(r);
    setMedia(null);
    setNote(r.review_decision ? "" : "");
    setMediaLoading(true);
    try {
      const m = await api.get<Media>(`/admin/captures/${r.id}/media`);
      setMedia(m);
    } finally {
      setMediaLoading(false);
    }
  };

  const decide = async (decision: "approve" | "reject") => {
    if (!selected) return;
    setSaving(true);
    try {
      await api.post(`/admin/captures/${selected.id}/review`, { decision, note: note || null });
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
      <h1>Capture reviews</h1>
      <div className="sub" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>{rows.length} to review · flagged for movement / off-hub</span>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={includeAll}
            onChange={(e) => setIncludeAll(e.target.checked)}
            style={{ width: "auto" }}
          />
          Show all captures (incl. already-reviewed)
        </label>
      </div>

      <div className="review-split">
        <ul className="review-list">
          {rows.length === 0 ? (
            <div className="empty">
              {includeAll ? "No captures yet." : "Nothing flagged — good day!"}
            </div>
          ) : rows.map((r) => (
            <li
              key={r.id}
              className={"review-item " + (selected?.id === r.id ? "active" : "")}
              onClick={() => pickOne(r)}
            >
              <div className="title">{r.driver_name ?? "unknown"}</div>
              <div className="meta">
                {r.day_key} · {r.driver_hub ?? "no hub"}
              </div>
              <div className="meta" style={{ marginTop: 4 }}>
                {r.review_flag_movement ? <span className="tag alert">movement {r.movement_m.toFixed(0)} m</span> : null}
                {r.hub_warn ? <span className="tag warn" style={{ marginLeft: 4 }}>hub {r.distance_from_hub_km?.toFixed(1)} km</span> : null}
                {r.review_decision === "approve" ? <span className="tag ok" style={{ marginLeft: 4 }}>approved</span> : null}
                {r.review_decision === "reject" ? <span className="tag alert" style={{ marginLeft: 4 }}>rejected</span> : null}
              </div>
            </li>
          ))}
        </ul>

        <div className="card">
          {!selected ? (
            <div className="empty">Pick a capture from the list to review.</div>
          ) : (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>{selected.driver_name}</div>
                  <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 2 }}>
                    {selected.driver_phone} · {selected.day_key}
                  </div>
                </div>
                {selected.review_decision ? (
                  <span className={"tag " + (selected.review_decision === "approve" ? "ok" : "alert")}>
                    {selected.review_decision}
                  </span>
                ) : null}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: 16 }}>
                <Kv label="Duration" value={`${selected.duration_s}s`} />
                <Kv label="Movement (start→end)" value={`${selected.movement_m.toFixed(0)} m`} warn={selected.review_flag_movement} />
                <Kv label="Distance from hub" value={selected.distance_from_hub_km != null ? `${selected.distance_from_hub_km.toFixed(2)} km` : "—"} warn={selected.hub_warn} />
              </div>

              <div style={{ marginTop: 20 }}>
                <div className="kicker" style={{ fontSize: 11, color: "var(--muted)", letterSpacing: 1, textTransform: "uppercase", fontWeight: 700, marginBottom: 8 }}>
                  Walk-around video
                </div>
                {mediaLoading ? (
                  <div className="empty" style={{ padding: 24 }}>Loading media…</div>
                ) : media?.walkaround_video_b64 ? (
                  <video
                    src={media.walkaround_video_b64}
                    controls
                    style={{ width: "100%", maxHeight: 420, borderRadius: 8, background: "#000" }}
                  />
                ) : (
                  <div className="empty">No video attached.</div>
                )}
              </div>

              <div style={{ marginTop: 20 }}>
                <div className="kicker" style={{ fontSize: 11, color: "var(--muted)", letterSpacing: 1, textTransform: "uppercase", fontWeight: 700, marginBottom: 8 }}>
                  Selfie
                </div>
                {media?.selfie_photo_b64 ? (
                  <img src={media.selfie_photo_b64} alt="selfie" style={{ maxWidth: 220, borderRadius: 8, border: "1px solid var(--line)" }} />
                ) : (
                  <div className="empty">No selfie attached.</div>
                )}
              </div>

              <div style={{ marginTop: 20 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6, display: "block" }}>
                  Review note (optional)
                </label>
                <textarea
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="What did you notice?"
                />
              </div>

              <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
                <button className="primary" disabled={saving} onClick={() => decide("approve")}>
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
        <div style={{ position: "fixed", bottom: 24, right: 24, background: "var(--ink)", color: "#fff", padding: "12px 18px", borderRadius: 8, boxShadow: "var(--shadow)" }}>
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
