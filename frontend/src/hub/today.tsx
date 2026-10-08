// The hub's live picture, shared by every tab: one call to
// /admin/hubs/<id>/today, refreshed every 20 seconds and whenever the manager
// does something (a cash entry, a payment, a reply) or returns to the app.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";

import { hubApi, useHubSession } from "@/src/hub/session";

export interface HubDriver {
  driver_id: string;
  name: string | null;
  phone: string | null;
  shift_type: string;
  active: boolean;
  shift_start_time: string | null;
  vehicle_number: string | null;
  shift_status: "no_shift_time" | "alarm_pending" | "ringing" | "no_answer" | "coming" | "not_coming" | "late" | "not_started" | "started";
  shift_start?: string | null;
  reason_code?: string | null;
  reason_note?: string | null;
  back_by?: string | null;
  duty_started_at?: string | null;
  late_minutes?: number | null;
  on_duty: boolean;
  current_platforms: string[];
  current_state: string | null;
  on_duty_seconds: number;
  working_seconds: number;
  tracking: "live" | "stopped" | null;
  tracking_reason: string | null;
  // Where the driver's phone was last heard from (absent on an older server).
  lat?: number | null;
  lng?: number | null;
  seen_at?: string | null;
  seen_minutes?: number | null;
  you_owe: number;
  over_limit: boolean;
}

export interface Attention {
  kind: "not_coming" | "not_started" | "no_answer" | "late" | "tracking_stopped" | "over_cash_limit";
  driver_id: string;
  name: string | null;
  phone: string | null;
  shift_start?: string | null;
  reason_code?: string | null;
  reason_note?: string | null;
  back_by?: string | null;
  reason?: string | null;
  amount?: number;
}

export interface HubToday {
  hub: { id: string; name: string | null; lat?: number | null; lng?: number | null };
  business_date: string;
  server_ts: string;
  drivers: HubDriver[];
  attention: Attention[];
  counts: {
    drivers: number;
    on_duty: number;
    shift: Record<string, number>;
    cash_owed: number;
    over_limit: number;
    withdrawals_pending: number;
    requests_pending: number;
    unread_messages: number;
  };
  cash_limit: number;
  razorpayx_ready: boolean;
}

interface Ctx {
  today: HubToday | null;
  failed: boolean;            // the last refresh did not get through
  refresh: () => Promise<void>;
}

const TodayCtx = createContext<Ctx | null>(null);

export const HubTodayProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { session } = useHubSession();
  const hubId = session?.hubId ?? null;
  const [today, setToday] = useState<HubToday | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    if (!hubId) return;
    try {
      setToday(await hubApi.get<HubToday>(`/admin/hubs/${hubId}/today`));
      setFailed(false);
    } catch {
      setFailed(true);        // keep showing what we had
    }
  }, [hubId]);

  useEffect(() => {
    if (!hubId) {
      setToday(null);
      return;
    }
    refresh();
    const id = setInterval(refresh, 20000);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") refresh();
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [hubId, refresh]);

  const value = useMemo<Ctx>(() => ({ today, failed, refresh }), [today, failed, refresh]);
  return <TodayCtx.Provider value={value}>{children}</TodayCtx.Provider>;
};

export const useHubToday = (): Ctx => {
  const c = useContext(TodayCtx);
  if (!c) throw new Error("useHubToday outside provider");
  return c;
};
