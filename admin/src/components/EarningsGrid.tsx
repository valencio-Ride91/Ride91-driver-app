// Daily earnings grid — the hub keys in each driver's earnings for a
// day+platform. One canonical row per (driver, platform, date); a manual entry
// never overwrites an official CSV import (those rows are locked).
//
// Used fleet-wide on the Daily earnings page (no hubId) and scoped to a single
// hub inside the Hub detail page (hubId set). The only difference is the
// ?hub_id= filter the server applies.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, EarningsForDate, EarningsRow } from "../api";

const PLATFORMS = ["uber", "rapido", "ola"] as const;
function todayISO() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
}

interface Draft { gross: string; cash: string; }

export default function EarningsGrid({ hubId }: { hubId?: string }) {
  const [date, setDate] = useState(todayISO());
  const [platform, setPlatform] = useState<(typeof PLATFORMS)[number]>("uber");
  const [data, setData] = useState<EarningsForDate | null>(null);
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const hubQ = hubId ? `&hub_id=${hubId}` : "";
      const d = await api.get<EarningsForDate>(`/admin/earnings?date=${date}&platform=${platform}${hubQ}`);
      setData(d);
      const dr: Record<string, Draft> = {};
      d.items.forEach((r) => {
        dr[r.driver_id] = {
          gross: r.gross_amount != null ? String(r.gross_amount) : "",
          cash: r.cash_amount != null ? String(r.cash_amount) : "",
        };
      });
      setDraft(dr);
    } catch {
      setErr("Could not load earnings.");
    } finally {
      setLoading(false);
    }
  }, [date, platform, hubId]);

  useEffect(() => { load(); }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 2500); };
  const setField = (id: string, k: keyof Draft, v: string) =>
    setDraft((p) => ({ ...p, [id]: { ...(p[id] ?? { gross: "", cash: "" }), [k]: v } }));

  const save = async (r: EarningsRow) => {
    setErr(null);
    const d = draft[r.driver_id] ?? { gross: "", cash: "" };
    const gross = Number(d.gross || 0);
    const cash = Number(d.cash || 0);
    if (!Number.isFinite(gross) || gross < 0) return setErr("Gross must be a positive number.");
    if (!Number.isFinite(cash) || cash < 0) return setErr("Cash must be a positive number.");
    setSavingId(r.driver_id);
    try {
      await api.post(`/admin/drivers/${r.driver_id}/earnings`, {
        business_date: date, platform, gross_amount: gross, cash_amount: cash,
      });
      flash(`${r.name ?? "Driver"} saved.`);
      await load();
    } catch (e: any) {
      setErr(e?.body?.detail === "already_imported" ? "An official report is already imported for this day — can't overwrite." : "Could not save.");
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div>
      <div className="card" style={{ padding: 12, marginBottom: 16, display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ fontSize: 13 }}>Date
          <input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label style={{ fontSize: 13 }}>Platform
          <select value={platform} onChange={(e) => setPlatform(e.target.value as typeof platform)}>
            {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <div className="muted-sm">Gross = total fares (drives the 30% share). Cash = what the rider paid the driver in cash (drives cash owed).</div>
      </div>

      {msg ? <div className="tag ok" style={{ display: "inline-block", marginBottom: 12 }}>{msg}</div> : null}
      {err ? <div className="err" style={{ marginBottom: 12 }}>{err}</div> : null}

      <div className="card" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr><th>Code</th><th>Driver</th><th style={{ width: 130 }}>Gross (₹)</th><th style={{ width: 130 }}>Cash (₹)</th><th></th></tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="empty">Loading…</td></tr>
            ) : (data?.items ?? []).length === 0 ? (
              <tr><td colSpan={5} className="empty">No drivers.</td></tr>
            ) : data!.items.map((r) => {
              const d = draft[r.driver_id] ?? { gross: "", cash: "" };
              return (
                <tr key={r.driver_id}>
                  <td style={{ fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>{r.code ?? "—"}</td>
                  <td>
                    <Link to={`/drivers/${r.driver_id}`} style={{ fontWeight: 600, color: "var(--ink)" }}>{r.name ?? r.driver_id.slice(0, 8)}</Link>
                    <span className="muted-sm"> ({r.shift})</span>
                  </td>
                  {r.locked ? (
                    <>
                      <td style={{ fontFamily: "ui-monospace, monospace" }}>{r.gross_amount ?? "—"}</td>
                      <td style={{ fontFamily: "ui-monospace, monospace" }}>{r.cash_amount ?? "—"}</td>
                      <td><span className="tag muted">from report</span></td>
                    </>
                  ) : (
                    <>
                      <td><input type="number" min={0} value={d.gross} onChange={(e) => setField(r.driver_id, "gross", e.target.value)} /></td>
                      <td><input type="number" min={0} value={d.cash} onChange={(e) => setField(r.driver_id, "cash", e.target.value)} /></td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button className="primary" onClick={() => save(r)} disabled={savingId === r.driver_id}>
                          {savingId === r.driver_id ? "…" : "Save"}
                        </button>
                        {r.source === "manual" ? <span className="tag ok" style={{ marginLeft: 6 }}>saved</span> : null}
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="muted-sm" style={{ marginTop: 12 }}>
        Tip: enter earnings under the platform the trips were on, so a later official report replaces your entry instead of double-counting. Rows "from report" are locked.
      </div>
    </div>
  );
}
