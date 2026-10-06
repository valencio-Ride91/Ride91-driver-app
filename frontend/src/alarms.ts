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

import { getLang } from "@/src/i18n";
import { getCardText } from "@/src/i18n/cards";

const RN = NativeModules.Ride91Alarms as
  | {
      schedule: (atMs: number, meta: Record<string, string>) => Promise<string>;
      cancel: (scheduleId: string) => Promise<boolean>;
      fireNow: (meta: Record<string, string>) => Promise<boolean>;
      drainPending?: () => Promise<string>;
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
  // start alarm: awake / not_coming · end alarm: heading_back / delayed · both: snooze
  response: "awake" | "not_coming" | "snooze" | "heading_back" | "delayed";
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
      title: meta.title ?? getCardText().alarm_title_start,
      lang: getLang(),
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
        title: meta.title ?? getCardText().alarm_title_start,
        lang: getLang(),
      });
    } catch {
      return false;
    }
  },

  // Every answer the driver has given on the alarm screen since we last asked.
  // The native side stores them because the alarm usually fires while the app
  // is closed; reading them also clears them, so each is returned once.
  async drainPending(): Promise<AlarmResponse[]> {
    if (!RN?.drainPending) return [];
    try {
      const list = JSON.parse(await RN.drainPending());
      return Array.isArray(list) ? (list as AlarmResponse[]) : [];
    } catch {
      return [];
    }
  },

  // Fires when an answer has just been stored — a cue to call drainPending().
  addResponseListener(cb: () => void): EmitterSubscription | null {
    const e = getEmitter();
    if (!e) return null;
    return e.addListener("Ride91AlarmResponse", cb);
  },
};
