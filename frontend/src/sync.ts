// Offline queue + sync worker.
//
// Every mutating user action goes here first with a client-generated UUID.
// The UI never waits on the network. When connectivity returns, we drain
// the queue in order and let the server dedupe on (driver_id, client_action_id).
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
import NetInfo from "@react-native-community/netinfo";
import * as Crypto from "expo-crypto";

import { api } from "@/src/api";
import { storage } from "@/src/utils/storage";

const Q_KEY = "ride91.sync.queue";

export interface QueuedAction {
  id: string;              // client_action_id (UUID)
  path: string;            // /duty/state, /close-out, /requests, ...
  body: Record<string, any>;
  device_ts: string;       // when the action happened on the phone
  attempts: number;
}

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
  await storage.setItem(Q_KEY, q);
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
      while (q.length) {
        const head = q[0];
        try {
          await api.post(head.path, { ...head.body, client_action_id: head.id });
        } catch (e: any) {
          // network error → stop; anything else, mark attempts and keep going
          if (!e?.status) break;
          head.attempts += 1;
          if (head.attempts > 5) {
            // drop poison message but keep going
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

  const enqueue = useCallback(
    async (path: string, body: Record<string, any>): Promise<QueuedAction> => {
      const q = await readQueue();
      const action: QueuedAction = {
        id: Crypto.randomUUID(),
        path,
        body,
        device_ts: new Date().toISOString(),
        attempts: 0,
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
