// Offline queue + sync worker.
//
// Every mutating user action goes here first with a client-generated UUID.
// The UI never waits on the network. When connectivity returns, we drain
// the queue in order and let the server dedupe on (driver_id, client_action_id).
//
// A tap is only ever dropped when the server refuses it outright (a 4xx such
// as a bad value), after a few tries. No signal, a timeout, the server being
// down (5xx) or a login that has run out (401) keep it waiting: it is sent
// when things are back. Before, those failures counted toward a limit of 5
// and then the tap was thrown away, so an "end duty" made during an outage
// could vanish. The queue is retried every minute and when the app comes back
// to the front, not only when the network changes.
//
// Backing store is AsyncStorage via the shared storage util (persistent across
// launches, works on native + web preview). SQLite is available if we ever
// outgrow this.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import * as Crypto from "expo-crypto";

import { api } from "@/src/api";
import { storage } from "@/src/utils/storage";

const PROFILE_KEY = "ride91.driver.profile";      // written by src/auth.ts
const RETRY_MS = 60000;
const MAX_REFUSALS = 3;                            // a tap the server keeps refusing (4xx)
// One tap the server keeps failing on (5xx) must not hold up every tap behind
// it for ever. An outage clears within hours or a day or two; a tap still
// failing three days after its first failure is let go.
const SERVER_ERROR_GIVE_UP_MS = 72 * 3600 * 1000;

// Who is signed in on this phone now (from the saved profile), or null.
async function currentDriverId(): Promise<string | null> {
  const p = await storage.getItem<{ driver?: { id?: string } } | null>(PROFILE_KEY, null);
  return p?.driver?.id ?? null;
}

// Worth trying again later: no answer, a timeout, the server down or busy, or
// a login that ran out (the driver signs in again and it goes through).
const retryLater = (status: number | undefined) =>
  !status || status >= 500 || status === 401 || status === 403 || status === 408 || status === 429;

const Q_KEY = "ride91.sync.queue";

// A type alias, not an interface: only aliases get an implicit index
// signature, which is what lets QueuedAction[] satisfy StorageItemValue
// when the queue is persisted.
export type QueuedAction = {
  id: string;              // client_action_id (UUID)
  path: string;            // /duty/state, /close-out, /requests, ...
  body: Record<string, any>;
  device_ts: string;       // when the action happened on the phone
  attempts: number;
  driver_id?: string | null;   // who made it; never sent under someone else's login
  first_server_error_at?: string;   // when the server first answered it with an error (5xx)
};

interface SyncCtx {
  online: boolean;
  unsynced: number;
  enqueue: (path: string, body: Record<string, any>) => Promise<QueuedAction>;
  drain: () => Promise<void>;
}

const Ctx = createContext<SyncCtx | null>(null);

async function readQueue(): Promise<QueuedAction[]> {
  return (await storage.getItem<QueuedAction[]>(Q_KEY, [])) ?? [];
}

async function writeQueue(q: QueuedAction[]): Promise<void> {
  // storage.setItem swallows its own errors and reports false, so without
  // this check a failed write looked like a successful enqueue: the caller
  // showed "done" while the action was never persisted or sent. That silently
  // dropped go-online captures, which are the record that a vehicle was
  // inspected. A queue that cannot be written has to be an error.
  const ok = await storage.setItem(Q_KEY, q);
  if (!ok) throw new Error("queue_write_failed");
}

export const SyncProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [online, setOnline] = useState(true);
  const [unsynced, setUnsynced] = useState(0);
  const draining = useRef(false);

  const refreshCount = useCallback(async () => {
    const q = await readQueue();
    setUnsynced(q.length);
  }, []);

  useEffect(() => {
    refreshCount();
    const sub = NetInfo.addEventListener((s) => {
      const isOn = !!(s.isConnected && s.isInternetReachable !== false);
      setOnline(isOn);
    });
    return () => sub();
  }, [refreshCount]);

  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    try {
      let q = await readQueue();
      const me = await currentDriverId();
      while (q.length) {
        const head = q[0];
        if (head.driver_id && me && head.driver_id !== me) {
          // Made by another driver who used this phone: never send it as this one.
          q = q.slice(1);
          await writeQueue(q);
          continue;
        }
        if (!me) break;          // nobody signed in: keep everything for later
        try {
          await api.post(head.path, { ...head.body, client_action_id: head.id });
        } catch (e: any) {
          if (e?.status >= 500) {
            const first = head.first_server_error_at ? new Date(head.first_server_error_at).getTime() : Date.now();
            if (Date.now() - first > SERVER_ERROR_GIVE_UP_MS) {
              q = q.slice(1);
              await writeQueue(q);
              continue;
            }
            if (!head.first_server_error_at) {
              q[0] = { ...head, first_server_error_at: new Date(first).toISOString() };
              await writeQueue(q);
            }
            break;
          }
          if (retryLater(e?.status)) break;     // keep it; try again later
          // The server refused this one (a bad value...): a few tries, then let it go
          head.attempts += 1;
          if (head.attempts >= MAX_REFUSALS) {
            q = q.slice(1);
            await writeQueue(q);
            continue;
          }
          q[0] = head;
          await writeQueue(q);
          break;
        }
        q = q.slice(1);
        await writeQueue(q);
      }
    } finally {
      draining.current = false;
      await refreshCount();
    }
  }, [refreshCount]);

  useEffect(() => {
    if (online) drain();
  }, [online, drain]);

  // Also retry on a timer and on coming back to the app: the network can be
  // "on" while the server was down, and nothing else would try again.
  useEffect(() => {
    const id = setInterval(() => { if (online) drain(); }, RETRY_MS);
    const sub = AppState.addEventListener("change", (st) => { if (st === "active") drain(); });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [online, drain]);

  const enqueue = useCallback(
    async (path: string, body: Record<string, any>): Promise<QueuedAction> => {
      const q = await readQueue();
      const action: QueuedAction = {
        id: Crypto.randomUUID(),
        path,
        body,
        device_ts: new Date().toISOString(),
        attempts: 0,
        driver_id: await currentDriverId(),
      };
      q.push(action);
      await writeQueue(q);
      setUnsynced(q.length);
      // Fire-and-forget drain
      drain();
      return action;
    },
    [drain],
  );

  const value = useMemo<SyncCtx>(
    () => ({ online, unsynced, enqueue, drain }),
    [online, unsynced, enqueue, drain],
  );
  return React.createElement(Ctx.Provider, { value }, children);
};

export const useSync = (): SyncCtx => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSync outside provider");
  return c;
};
