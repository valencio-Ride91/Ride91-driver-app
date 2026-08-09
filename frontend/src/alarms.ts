// JS bridge to the native Android AlarmManager module (Ride91Alarms).
//
// On Expo Go / web the native module is undefined — every call becomes a no-op
// so the rest of the app keeps working. The full-screen fallback route lives
// at /alarm and is what we drive on preview builds when the native module is
// missing.
//
// USAGE
//   import { alarms } from "@/src/alarms";
//   await alarms.schedule({ atMs, scheduleId, driverId, title });
//   const unsub = alarms.addResponseListener((r) => { ... });
//
// The native side emits a "Ride91AlarmResponse" DeviceEvent with:
//   { scheduleId, response: 'awake'|'not_coming'|'snooze',
//     reasonCode?, reasonNote?, backBy?, firedAt, respondedAt }

import { EmitterSubscription, NativeEventEmitter, NativeModules, Platform } from "react-native";

const RN = NativeModules.Ride91Alarms as
  | {
      schedule: (atMs: number, meta: Record<string, string>) => Promise<string>;
      cancel: (scheduleId: string) => Promise<boolean>;
      fireNow: (meta: Record<string, string>) => Promise<boolean>;
      addListener: (name: string) => void;
      removeListeners: (n: number) => void;
    }
  | undefined;

export interface AlarmMeta {
  atMs: number;                 // wall-clock ms when alarm should fire
  scheduleId: string;
  driverId: string;
  title?: string;
}

export interface AlarmResponse {
  scheduleId: string;
  response: "awake" | "not_coming" | "snooze";
  reasonCode?: string | null;
  reasonNote?: string | null;
  backBy?: string | null;
  firedAt: number;
  respondedAt: number;
}

export const alarmsAvailable = Platform.OS === "android" && !!RN;

let emitter: NativeEventEmitter | null = null;
function getEmitter(): NativeEventEmitter | null {
  if (!RN) return null;
  if (!emitter) emitter = new NativeEventEmitter(RN as unknown as { addListener: (e: string) => void; removeListeners: (c: number) => void });
  return emitter;
}

export const alarms = {
  available: alarmsAvailable,

  async schedule(meta: AlarmMeta): Promise<string | null> {
    if (!RN) return null;
    return RN.schedule(meta.atMs, {
      scheduleId: meta.scheduleId,
      driverId: meta.driverId,
      title: meta.title ?? "Shift starts in 1 hour",
    });
  },

  async cancel(scheduleId: string): Promise<boolean> {
    if (!RN) return true;
    try {
      return await RN.cancel(scheduleId);
    } catch {
      return false;
    }
  },

  async fireNow(meta: { scheduleId: string; driverId: string; title?: string }): Promise<boolean> {
    if (!RN) return false;
    try {
      return await RN.fireNow({
        scheduleId: meta.scheduleId,
        driverId: meta.driverId,
        title: meta.title ?? "Shift starts in 1 hour",
      });
    } catch {
      return false;
    }
  },

  addResponseListener(cb: (r: AlarmResponse) => void): EmitterSubscription | null {
    const e = getEmitter();
    if (!e) return null;
    return e.addListener("Ride91AlarmResponse", cb as (r: unknown) => void);
  },
};
