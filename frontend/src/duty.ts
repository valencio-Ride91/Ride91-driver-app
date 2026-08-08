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
  current_state: string | null;
  current_platform: string | null;
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
}

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
        return { ...prev, segments: segs, current_state: state };
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
        lat: lat ?? 0,
        lng: lng ?? 0,
        source: "driver",
      });
      // Refresh soon after so the server-side segment math takes over
      setTimeout(refresh, 1500);
    },
    [enqueue, lat, lng, today, refresh],
  );

  const value = useMemo<DutyCtx>(
    () => ({ today, loading, refresh, switchState }),
    [today, loading, refresh, switchState],
  );
  return React.createElement(Ctx.Provider, { value }, children);
};

export const useDuty = (): DutyCtx => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useDuty outside provider");
  return c;
};
