// Shift alarm orchestration.
//
// On mount (and every time the driver identity changes or the app returns to
// foreground) we call GET /shift-alarm/next to learn the driver's upcoming
// shift. If shift_start is in the future we compute alarm_fires_at (1h before)
// and hand it to the native AlarmManager module so it can survive Doze and
// process-death.
//
// We also subscribe to the native DeviceEvent stream so that when the driver
// answers "awake" / "not coming" / "snooze" on the full-screen activity, we
// POST it through the offline queue.
//
// On web / Expo Go the native module is a no-op — the /alarm route is used
// instead for manual testing, and the SAME POST logic is called via
// `submitAlarmResponse` below.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import * as Crypto from "expo-crypto";

import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { useSync } from "@/src/sync";
import { alarms, AlarmResponse, alarmsAvailable } from "@/src/alarms";

export interface ShiftSchedule {
  id: string;
  driver_id: string;
  shift_start: string;      // ISO
  shift_type: "day" | "night";
  hub_id: string | null;
  alarm_fires_at: string;   // ISO
  state: "scheduled" | "responded" | "no_response";
}

interface Ctx {
  next: ShiftSchedule | null;
  refresh: () => Promise<void>;
  scheduleShift: (input: { shift_start: string; shift_type?: "day" | "night"; hub_id?: string }) => Promise<ShiftSchedule | null>;
  submitAlarmResponse: (r: AlarmResponse) => Promise<void>;
  testFireNow: () => Promise<void>;
  nativeAvailable: boolean;
}

const ShiftAlarmCtx = createContext<Ctx | null>(null);

export const ShiftAlarmProvider: React.FC<{ children: React.ReactNode; enabled: boolean }> = ({
  children,
  enabled,
}) => {
  const { driver } = useAuth();
  const { enqueue } = useSync();
  const [next, setNext] = useState<ShiftSchedule | null>(null);
  const listenerRef = useRef<{ remove: () => void } | null>(null);

  const submitAlarmResponse = useCallback(
    async (r: AlarmResponse) => {
      await enqueue("/shift-alarm/response", {
        schedule_id: r.scheduleId,
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

  const refresh = useCallback(async () => {
    if (!enabled || !driver) return;
    try {
      const row = await api.get<ShiftSchedule | Record<string, never>>("/shift-alarm/next");
      const parsed = row && (row as ShiftSchedule).id ? (row as ShiftSchedule) : null;
      setNext(parsed);
      if (parsed) {
        const atMs = new Date(parsed.alarm_fires_at).getTime();
        if (!Number.isNaN(atMs) && atMs > Date.now()) {
          await alarms.schedule({
            atMs,
            scheduleId: parsed.id,
            driverId: parsed.driver_id,
            title: parsed.shift_type === "night"
              ? "Night shift starts in 1 hour"
              : "Shift starts in 1 hour",
          });
        }
      }
    } catch {
      // ignore — will retry on foreground/next tick
    }
  }, [enabled, driver]);

  // Boot + foreground + driver-change → refresh.
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") refresh();
    });
    return () => sub.remove();
  }, [enabled, refresh]);

  // Response listener → offline queue.
  useEffect(() => {
    if (!enabled) return;
    listenerRef.current?.remove();
    const sub = alarms.addResponseListener(async (r) => {
      await submitAlarmResponse(r);
      // Re-fetch so `next` transitions from scheduled → responded.
      setTimeout(refresh, 500);
    });
    listenerRef.current = sub ?? null;
    return () => {
      listenerRef.current?.remove();
      listenerRef.current = null;
    };
  }, [enabled, submitAlarmResponse, refresh]);

  const scheduleShift = useCallback(
    async (input: { shift_start: string; shift_type?: "day" | "night"; hub_id?: string }) => {
      if (!enabled || !driver) return null;
      const client_action_id = Crypto.randomUUID();
      try {
        const row = await api.post<ShiftSchedule>("/shift-alarm/schedule", {
          shift_start: input.shift_start,
          shift_type: input.shift_type ?? "day",
          hub_id: input.hub_id,
          client_action_id,
        });
        setNext(row);
        const atMs = new Date(row.alarm_fires_at).getTime();
        if (!Number.isNaN(atMs) && atMs > Date.now()) {
          await alarms.schedule({
            atMs,
            scheduleId: row.id,
            driverId: row.driver_id,
            title: row.shift_type === "night"
              ? "Night shift starts in 1 hour"
              : "Shift starts in 1 hour",
          });
        }
        return row;
      } catch {
        return null;
      }
    },
    [enabled, driver],
  );

  const testFireNow = useCallback(async () => {
    if (!driver) return;
    const scheduleId = next?.id ?? `test-${Date.now()}`;
    if (alarmsAvailable) {
      await alarms.fireNow({
        scheduleId,
        driverId: driver.id,
        title: "TEST · Shift starts in 1 hour",
      });
    }
    // No-op on web / Expo Go — user must open /alarm manually to preview UI.
  }, [driver, next]);

  const value = useMemo<Ctx>(
    () => ({
      next,
      refresh,
      scheduleShift,
      submitAlarmResponse,
      testFireNow,
      nativeAvailable: alarmsAvailable,
    }),
    [next, refresh, scheduleShift, submitAlarmResponse, testFireNow],
  );

  return React.createElement(ShiftAlarmCtx.Provider, { value }, children);
};

export const useShiftAlarm = (): Ctx => {
  const c = useContext(ShiftAlarmCtx);
  if (!c) throw new Error("useShiftAlarm outside provider");
  return c;
};
