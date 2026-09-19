// Daily vehicle inspections — one per driver per business day: a dashboard
// photo and a walkaround video. List on the left, media on the right.
import { useEffect, useState } from "react";
import { api, InspectionRow } from "../api";

interface Media {
  dashboard_photo_b64: string | null;
  exterior_video_b64: string | null;
  exterior_video_mime: string | null;
}

function fmtWhen(iso: string) {
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

export default function Inspections() {
  const [rows, setRows] = useState<InspectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<InspectionRow | null>(null);
  const [media, setMedia] = useState<Media | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);

  const load = async () => {
    try {
      const r = await api.get<{ items: InspectionRow[] }>("/admin/inspections");
      setRows(r.items);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load().catch(() => undefined);
    const id = setInterval(() => load().catch(() => undefined), 60000);
    return () => clearInterval(id);
  }, []);

  const pickOne = async (r: InspectionRow) => {
    setSelected(r);
    setMedia(null);
    setMediaLoading(true);
    try {
      const m = await api.get<Media>(`/admin/inspections/${r.id}/media`);
      setMedia(m);
    } finally {
      setMediaLoading(false);
    }
  };

  return (
    <div>
      <h1>Inspections</h1>
      <div className="sub">{loading ? "Loading…" : `${rows.length} inspections · newest first`}</div>

      <div className="review-split">
        <ul className="review-list">
          {rows.length === 0 && !loading ? (
            <div className="empty">No inspections yet.</div>
          ) : rows.map((r) => (
            <li key={r.id} className={"review-item " + (selected?.id === r.id ? "active" : "")} onClick={() => pickOne(r)}>
              <div className="title">{r.driver_name ?? "unknown"}</div>
              <div className="meta">{r.day_key} · {r.vehicle_number ?? "no vehicle"}</div>
              <div className="meta" style={{ marginTop: 4 }}>{fmtWhen(r.created_at)}</div>
            </li>
          ))}
        </ul>

        <div className="card">
          {!selected ? (
            <div className="empty">Pick an inspection to view its photo and video.</div>
          ) : (
            <div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{selected.driver_name}</div>
              <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 2 }}>
                {selected.driver_phone} · {selected.vehicle_number ?? "no vehicle"} · {selected.day_key}
              </div>

              <div style={{ marginTop: 20 }}>
                <div style={{ fontSize: 11, color: "var(--muted)", letterSpacing: 1, textTransform: "uppercase", fontWeight: 700, marginBottom: 8 }}>
                  Dashboard photo
                </div>
                {mediaLoading ? (
                  <div className="empty" style={{ padding: 24 }}>Loading media…</div>
                ) : media?.dashboard_photo_b64 ? (
                  <img src={media.dashboard_photo_b64} alt="dashboard" style={{ maxWidth: "100%", borderRadius: 8, border: "1px solid var(--line)" }} />
                ) : (
                  <div className="empty">No photo attached.</div>
                )}
              </div>

              <div style={{ marginTop: 20 }}>
                <div style={{ fontSize: 11, color: "var(--muted)", letterSpacing: 1, textTransform: "uppercase", fontWeight: 700, marginBottom: 8 }}>
                  Walk-around video
                </div>
                {mediaLoading ? null : media?.exterior_video_b64 ? (
                  <video src={media.exterior_video_b64} controls style={{ width: "100%", maxHeight: 420, borderRadius: 8, background: "#000" }} />
                ) : (
                  <div className="empty">No video attached.</div>
                )}
              </div>

              <div style={{ display: "flex", marginTop: 16 }}>
                <button onClick={() => setSelected(null)} style={{ marginLeft: "auto" }}>Close</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
