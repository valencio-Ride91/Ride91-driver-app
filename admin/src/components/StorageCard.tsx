// How full the database is, and what is using the space (owner only).
//
// The free database plan holds 512 MB. When it filled up on 30-31 Oct the
// whole system stopped, with no warning beforehand; this card is the gauge.
// `compact` shows just the bar and a warning, for the dashboard.
import { useEffect, useState } from "react";
import { api } from "../api";

interface StorageRow { collection: string; documents: number; data_mb: number; storage_mb: number; index_mb: number }
interface Storage { quota_mb: number; used_mb: number; storage_mb: number; used_pct: number | null; collections: StorageRow[] }

const WARN_PCT = 70;
const ALERT_PCT = 85;

export default function StorageCard({ compact = false }: { compact?: boolean }) {
  const [s, setS] = useState<Storage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    api.get<Storage>("/admin/storage")
      .then(setS)
      .catch((e) => setErr(e?.status === 403 ? null : "Could not read the database size."));
  }, []);

  if (!s) return err && !compact ? <div className="card" style={{ marginTop: 16, maxWidth: 560 }}><div className="sub">{err}</div></div> : null;
  const pct = s.used_pct ?? 0;
  const color = pct >= ALERT_PCT ? "#BF3F2C" : pct >= WARN_PCT ? "#E8A317" : "#3A7A1F";
  if (compact && pct < WARN_PCT) return null;

  const bar = (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong>Database {pct}% full</strong>
        <span className="sub">{s.used_mb} MB of {s.quota_mb} MB</span>
      </div>
      <div style={{ height: 10, borderRadius: 5, background: "#E5E5E0", marginTop: 6, overflow: "hidden" }}>
        <div style={{ width: `${Math.min(100, pct)}%`, height: 10, background: color }} />
      </div>
      {pct >= WARN_PCT ? (
        <div className="sub" style={{ color, marginTop: 6 }}>
          {pct >= ALERT_PCT
            ? "Nearly full. When it fills, the apps stop working. Clear old data or move to a bigger plan now."
            : "Getting full. Check the biggest collections below."}
        </div>
      ) : null}
    </>
  );

  if (compact) return <div className="card" style={{ marginBottom: 16, borderColor: color }}>{bar}</div>;

  const rows = all ? s.collections : s.collections.slice(0, 8);
  return (
    <div className="card" style={{ marginTop: 16, maxWidth: 560 }}>
      <h2 style={{ marginTop: 0 }}>Database storage</h2>
      {bar}
      <table style={{ width: "100%", marginTop: 12, fontSize: 13 }}>
        <thead>
          <tr><th style={{ textAlign: "left" }}>What</th><th style={{ textAlign: "right" }}>Rows</th><th style={{ textAlign: "right" }}>Size (MB)</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.collection}>
              <td>{r.collection}</td>
              <td style={{ textAlign: "right" }}>{r.documents.toLocaleString("en-IN")}</td>
              <td style={{ textAlign: "right" }}>{(r.data_mb + r.index_mb).toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {s.collections.length > 8 ? (
        <button className="ghost" style={{ marginTop: 8 }} onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${s.collections.length}`}</button>
      ) : null}
    </div>
  );
}
