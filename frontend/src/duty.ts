// Duty state (the app spine): keeps the current append-only timeline and
// exposes helpers to switch platform / close out. Optimistically appends
// locally so the UI updates while the sync worker POSTs in the background.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import * as Crypto from "expo-crypto";

import { api } from "@/src/api";
import { useSync } from "@/src/sync";
import { useTracking } from "@/src/tracking";

export interface DutySegment {
  state: string;
  from_ts: string;
  to_ts: string;
  seconds: number;
}

export interface DutyToday {
  segments: DutySegment[];
  totals_seconds: Record<string, number>;
  on_duty: boolean;
  on_duty_seconds: number;
  working_seconds: number;
  /** to_charger + charging: on duty, but not earning on any platform. */
  charging_seconds: number;
  current_state: string | null;
  current_platform: string | null;
  current_platforms: string[];
  distance_km: number;
  business_date: string;
  day_start: string;
  server_ts: string;
}

interface DutyCtx {
  today: DutyToday | null;
  loading: boolean;
  refresh: () => Promise<void>;
  switchState: (
    state: string,
    onNeedCloseOut: (info: {
      platform: string;
      from_ts: string;
      to_ts: string;
    }) => void,
  ) => Promise<void>;
  // Set the full set of platforms the driver is online on (multiple allowed).
  setPlatforms: (platforms: string[]) => Promise<void>;
  // Start duty and say what happened, so the screen can react:
  //   ok                  on duty
  //   inspection_required today's car check is not on file yet
  //   offline             no network. With `queueIfOffline` the start is kept
  //                       on the phone and sent when the network is back.
  //   error               the server refused for some other reason
  startDuty: (queueIfOffline: boolean) => Promise<StartDutyResult>;
}

export type StartDutyResult = "ok" | "inspection_required" | "offline" | "error";

const Ctx = createContext<DutyCtx | null>(null);

const PLATFORMS = new Set(["ride91", "uber", "rapido", "ola"]);

export const DutyProvider: React.FC<{ children: React.ReactNode; enabled: boolean }> = ({
  children,
  enabled,
}) => {
  const [today, setToday] = useState<DutyToday | null>(null);
  const [loading, setLoading] = useState(true);
  const { enqueue } = useSync();
  const { lat, lng } = useTracking();

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<DutyToday>("/duty/today");
      setToday(r);
    } catch {
      // keep whatever we have
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const t = setInterval(refresh, 20000);
    return () => clearInterval(t);
  }, [enabled, refresh]);

  const switchState: DutyCtx["switchState"] = useCallback(
    async (state, onNeedCloseOut) => {
      const startedAt = new Date().toISOString();
      // Optimistic local append so the stripe / status bar updates immediately
      setToday((prev) => {
        if (!prev) return prev;
        const segs = [...prev.segments];
        if (segs.length) {
          segs[segs.length - 1] = { ...segs[segs.length - 1], to_ts: startedAt };
          segs[segs.length - 1].seconds = Math.max(
            0,
            Math.floor(
              (new Date(startedAt).getTime() -
                new Date(segs[segs.length - 1].from_ts).getTime()) /
                1000,
            ),
          );
        }
        segs.push({ state, from_ts: startedAt, to_ts: startedAt, seconds: 0 });
        return {
          ...prev,
          segments: segs,
          current_state: state,
          // start / end duty decide this; every other state leaves it alone
          on_duty: state === "start_duty" ? true : state === "end_duty" ? false : prev.on_duty,
          current_platforms: state === "start_duty" || state === "end_duty" ? [] : prev.current_platforms,
        };
      });

      // If we're moving AWAY FROM a platform (not to Offline) and the
      // previous block was ≥ 1 minute long, ask for a close-out.
      const prev = today?.segments?.[today.segments.length - 1];
      const prevState = prev?.state ?? today?.current_state ?? null;
      if (
        prevState &&
        PLATFORMS.has(prevState) &&
        state !== "offline" &&
        prev &&
        (Date.now() - new Date(prev.from_ts).getTime()) / 1000 >= 60
      ) {
        onNeedCloseOut({
          platform: prevState,
          from_ts: prev.from_ts,
          to_ts: startedAt,
        });
      }

      await enqueue("/duty/state", {
        state,
        started_at: startedAt,
        lat,       // null when the phone has no fix — never a made-up 0,0
        lng,
        source: "driver",
      });
      // Refresh soon after so the server-side segment math takes over
      setTimeout(refresh, 1500);
    },
    [enqueue, lat, lng, today, refresh],
  );

  // Start duty goes straight to the server instead of through the offline
  // queue: the server can refuse it (no inspection on file), and the driver
  // has to be told at once rather than left looking at a button that did
  // nothing.
  const startDuty: DutyCtx["startDuty"] = useCallback(
    async (queueIfOffline) => {
      const startedAt = new Date().toISOString();
      const body = { state: "start_duty", started_at: startedAt, lat, lng, source: "driver" };
      const showOnDuty = () =>
        setToday((prev) =>
          prev
            ? {
                ...prev,
                on_duty: true,
                current_state: "start_duty",
                current_platforms: [],
                segments: [...prev.segments, { state: "start_duty", from_ts: startedAt, to_ts: startedAt, seconds: 0 }],
              }
            : prev,
        );
      try {
        await api.post("/duty/state", { ...body, client_action_id: Crypto.randomUUID() });
      } catch (e: any) {
        if (e?.status === 409 && e?.body?.detail === "inspection_required") return "inspection_required";
        if (e?.status) return "error";
        if (!queueIfOffline) return "offline";
        showOnDuty();
        await enqueue("/duty/state", body);
        return "offline";
      }
      showOnDuty();
      await refresh();
      return "ok";
    },
    [enqueue, lat, lng, refresh],
  );

  const setPlatforms: DutyCtx["setPlatforms"] = useCallback(
    async (platforms) => {
      const startedAt = new Date().toISOString();
      const uniq = Array.from(new Set(platforms)).sort();
      const state = uniq.length ? "online" : "not_online";
      // Optimistic local update so the toggles flip instantly.
      setToday((prev) => {
        if (!prev) return prev;
        const segs = [...prev.segments];
        if (segs.length) {
          segs[segs.length - 1] = { ...segs[segs.length - 1], to_ts: startedAt };
        }
        segs.push({ state, from_ts: startedAt, to_ts: startedAt, seconds: 0 });
        return { ...prev, segments: segs, current_state: state, current_platforms: uniq };
      });
      await enqueue("/duty/state", {
        state,
        platforms: uniq,
        started_at: startedAt,
        lat,
        lng,
        source: "driver",
      });
      setTimeout(refresh, 1200);
    },
    [enqueue, lat, lng, refresh],
  );

  const value = useMemo<DutyCtx>(
    () => ({ today, loading, refresh, switchState, setPlatforms, startDuty }),
    [today, loading, refresh, switchState, setPlatforms, startDuty],
  );
  return React.createElement(Ctx.Provider, { value }, children);
};

export const useDuty = (): DutyCtx => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useDuty outside provider");
  return c;
};
