// Shift alarm orchestration.
//
// This ties together:
//   • the native Android AlarmManager module (Ride91Alarms) — see src/alarms.ts,
//   • the server (routes /api/shift-alarm/*),
//   • the offline sync queue (POSTs on driver responses).
//
// Two alarms per shift are tracked:
//   1. Start alarm  — fires exactly 1h before shift_start (fixed).
//   2. End alarm    — fires shift_end - (eta_to_hub + buffer). Because the
//      ETA changes as the driver moves, we RE-ARM the native alarm every ~60s
//      whenever `alarm_at` shifts by more than 30s.
//
// On Expo Go / web the native module no-ops — the /alarm route is used for
// UI preview and the same submitAlarmResponse path posts to the backend.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import * as Crypto from "expo-crypto";

import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { useSync } from "@/src/sync";
import { useTracking } from "@/src/tracking";
import { alarms, AlarmResponse, alarmsAvailable } from "@/src/alarms";

export interface ShiftSchedule {
  id: string;
  driver_id: string;
  shift_start: string;
  shift_type: "day" | "night";
  hub_id: string | null;
  alarm_fires_at: string;
  state: "scheduled" | "responded" | "no_response";
  // End-alarm fields (nullable when only start alarm is scheduled).
  shift_end?: string | null;
  end_buffer_min?: number | null;
  end_state?: "scheduled" | "responded" | "no_response" | "na" | null;
}

export interface EndEta {
  has_end_alarm: boolean;
  has_hub?: boolean;
  schedule_id?: string;
  shift_end?: string;
  hub_lat?: number;
  hub_lng?: number;
  hub_name?: string | null;
  current_lat?: number;
  current_lng?: number;
  distance_km?: number;
  avg_speed_kmph?: number;
  eta_minutes?: number;
  buffer_minutes?: number;
  remaining_minutes?: number;
  alarm_at?: string;
  should_alarm_now?: boolean;
}

interface Ctx {
  next: ShiftSchedule | null;
  endEta: EndEta | null;
  refresh: () => Promise<void>;
  scheduleShift: (input: {
    shift_start: string;
    shift_type?: "day" | "night";
    hub_id?: string;
    shift_end?: string;
    end_buffer_min?: number;
  }) => Promise<ShiftSchedule | null>;
  submitAlarmResponse: (r: AlarmResponse, phase?: "start" | "end") => Promise<void>;
  testFireNow: (opts?: { phase?: "start" | "end" }) => Promise<void>;
  nativeAvailable: boolean;
}

const ShiftAlarmCtx = createContext<Ctx | null>(null);

// Only re-arm the native alarm when alarm_at drifts by more than this. Every
// city block the ETA can wobble by ~seconds — no point burning battery on
// AlarmManager churn.
const REARM_THRESHOLD_MS = 30 * 1000;

export const ShiftAlarmProvider: React.FC<{ children: React.ReactNode; enabled: boolean }> = ({
  children,
  enabled,
}) => {
  const { driver } = useAuth();
  const { enqueue } = useSync();
  const { lat, lng } = useTracking();
  const [next, setNext] = useState<ShiftSchedule | null>(null);
  const [endEta, setEndEta] = useState<EndEta | null>(null);
  const listenerRef = useRef<{ remove: () => void } | null>(null);
  const lastEndArmedAtRef = useRef<number | null>(null);

  const submitAlarmResponse = useCallback(
    async (r: AlarmResponse, phase: "start" | "end" = "start") => {
      await enqueue("/shift-alarm/response", {
        schedule_id: r.scheduleId,
        phase,
        response: r.response,
        reason_code: r.reasonCode ?? undefined,
        reason_note: r.reasonNote ?? undefined,
        back_by: r.backBy ?? undefined,
        fired_at: new Date(r.firedAt).toISOString(),
        responded_at: new Date(r.respondedAt).toISOString(),
      });
    },
    [enqueue],
  );

  const armEndAlarm = useCallback(
    async (eta: EndEta) => {
      if (!eta.has_end_alarm || !eta.has_hub || !eta.alarm_at || !eta.schedule_id) return;
      const atMs = new Date(eta.alarm_at).getTime();
      if (Number.isNaN(atMs)) return;
      const last = lastEndArmedAtRef.current;
      if (last !== null && Math.abs(atMs - last) < REARM_THRESHOLD_MS) return;
      // Never arm an alarm in the past — instead treat should_alarm_now via UI.
      if (atMs <= Date.now()) {
        lastEndArmedAtRef.current = atMs;
        return;
      }
      await alarms.schedule({
        atMs,
        scheduleId: `${eta.schedule_id}-end`,
        driverId: driver?.id ?? "",
        title: "Shift ends soon — head back to hub",
      });
      lastEndArmedAtRef.current = atMs;
    },
    [driver],
  );

  const refresh = useCallback(async () => {
    if (!enabled || !driver) return;
    try {
      const row = await api.get<ShiftSchedule | Record<string, never>>("/shift-alarm/next");
      const parsed = row && (row as ShiftSchedule).id ? (row as ShiftSchedule) : null;
      setNext(parsed);
      if (parsed) {
        // Arm start alarm.
        if (parsed.state !== "responded") {
          const atMs = new Date(parsed.alarm_fires_at).getTime();
          if (!Number.isNaN(atMs) && atMs > Date.now()) {
            await alarms.schedule({
              atMs,
              scheduleId: parsed.id,
              driverId: parsed.driver_id,
              title:
                parsed.shift_type === "night"
                  ? "Night shift starts in 1 hour"
                  : "Shift starts in 1 hour",
            });
          }
        }
        // Arm end alarm from ETA (if configured).
        if (parsed.shift_end && parsed.end_state !== "responded") {
          const qs = lat != null && lng != null ? `?lat=${lat}&lng=${lng}` : "";
          const eta = await api.get<EndEta>(`/shift-alarm/end-eta${qs}`);
          setEndEta(eta);
          if (eta.has_end_alarm && eta.has_hub) {
            await armEndAlarm(eta);
          }
        } else {
          setEndEta(null);
        }
      } else {
        setEndEta(null);
        lastEndArmedAtRef.current = null;
      }
    } catch {
      // ignore — try again on next tick / foreground
    }
  }, [enabled, driver, lat, lng, armEndAlarm]);

  // Foreground + boot refresh.
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") refresh();
    });
    return () => sub.remove();
  }, [enabled, refresh]);

  // Poll while end alarm is armed — recompute ETA every 60s using latest GPS.
  useEffect(() => {
    if (!enabled) return;
    if (!next?.shift_end || next.end_state === "responded") return;
    const id = setInterval(() => {
      refresh();
    }, 60_000);
    return () => clearInterval(id);
  }, [enabled, next?.shift_end, next?.end_state, refresh]);

  // Response listener → offline queue.
  useEffect(() => {
    if (!enabled) return;
    listenerRef.current?.remove();
    const sub = alarms.addResponseListener(async (r) => {
      // Distinguish end-phase by the `-end` suffix the native module receives
      // via the second scheduled alarm.
      const phase: "start" | "end" = r.scheduleId?.endsWith("-end") ? "end" : "start";
      const cleanedId = phase === "end" ? r.scheduleId.slice(0, -4) : r.scheduleId;
      await submitAlarmResponse({ ...r, scheduleId: cleanedId }, phase);
      setTimeout(refresh, 500);
    });
    listenerRef.current = sub ?? null;
    return () => {
      listenerRef.current?.remove();
      listenerRef.current = null;
    };
  }, [enabled, submitAlarmResponse, refresh]);

  const scheduleShift = useCallback<Ctx["scheduleShift"]>(
    async (input) => {
      if (!enabled || !driver) return null;
      const client_action_id = Crypto.randomUUID();
      try {
        const row = await api.post<ShiftSchedule>("/shift-alarm/schedule", {
          shift_start: input.shift_start,
          shift_type: input.shift_type ?? "day",
          hub_id: input.hub_id,
          shift_end: input.shift_end,
          end_buffer_min: input.end_buffer_min ?? 10,
          client_action_id,
        });
        setNext(row);
        // Arm start alarm.
        const atMs = new Date(row.alarm_fires_at).getTime();
        if (!Number.isNaN(atMs) && atMs > Date.now()) {
          await alarms.schedule({
            atMs,
            scheduleId: row.id,
            driverId: row.driver_id,
            title:
              row.shift_type === "night"
                ? "Night shift starts in 1 hour"
                : "Shift starts in 1 hour",
          });
        }
        // Kick a refresh so ETA-side gets computed and end alarm gets armed.
        setTimeout(refresh, 500);
        return row;
      } catch {
        return null;
      }
    },
    [enabled, driver, refresh],
  );

  const testFireNow = useCallback<Ctx["testFireNow"]>(
    async (opts) => {
      if (!driver) return;
      const phase = opts?.phase ?? "start";
      const scheduleId = phase === "end" ? `${next?.id ?? `test-${Date.now()}`}-end` : next?.id ?? `test-${Date.now()}`;
      if (alarmsAvailable) {
        await alarms.fireNow({
          scheduleId,
          driverId: driver.id,
          title:
            phase === "end"
              ? "TEST · Shift ends soon — head back to hub"
              : "TEST · Shift starts in 1 hour",
        });
      }
    },
    [driver, next],
  );

  const value = useMemo<Ctx>(
    () => ({
      next,
      endEta,
      refresh,
      scheduleShift,
      submitAlarmResponse,
      testFireNow,
      nativeAvailable: alarmsAvailable,
    }),
    [next, endEta, refresh, scheduleShift, submitAlarmResponse, testFireNow],
  );

  return React.createElement(ShiftAlarmCtx.Provider, { value }, children);
};

export const useShiftAlarm = (): Ctx => {
  const c = useContext(ShiftAlarmCtx);
  if (!c) throw new Error("useShiftAlarm outside provider");
  return c;
};
