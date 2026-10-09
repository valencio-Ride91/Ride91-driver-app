// Inbox — what drivers have written (and the automatic alerts about their
// shift), and their requests for leave, an advance or extra hours.
//
// Two views, each with its count: Messages, one row per driver with their
// newest message and how many are unread; and Requests, each a card with
// Approve and Reject. "Message all" writes to every driver at once.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { formatIST, formatINR } from "@/src/i18n";
import { Avatar, Icon, Segmented, useToast } from "@/src/hub/kit";
import { hubApi, useHubSession } from "@/src/hub/session";
import { BroadcastSheet } from "@/src/hub/sheets";
import { useHubText } from "@/src/hub/text";
import { useHubToday } from "@/src/hub/today";
import { Btn, Empty, HubHeader, Tag, hubStyles } from "@/src/hub/ui";
import { colors, fonts, spacing } from "@/src/theme";

interface Note {
  id: string;
  driver_id: string;
  driver_name: string | null;
  body: string;
  created_at: string;
  read: boolean;
  kind?: "system" | null;
}

interface Req {
  id: string;
  driver_name: string | null;
  type: string;
  payload: Record<string, unknown> | null;
  created_at: string;
  state: string;
}

interface Thread { driver_id: string; name: string; unread: number; latest: Note }

type View_ = "messages" | "requests";

// The details of a request in a few words: amount, dates, hours.
function details(r: Req): string {
  const p = r.payload ?? {};
  const parts: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (v == null || v === "") continue;
    parts.push(k === "amount" && typeof v === "number" ? formatINR(v) : String(v));
  }
  return parts.join(" · ");
}

export default function Inbox() {
  const t = useHubText();
  const router = useRouter();
  const say = useToast();
  const { session } = useHubSession();
  const { refresh } = useHubToday();
  const hubId = session?.hubId;
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [reqs, setReqs] = useState<Req[] | null>(null);
  const [view, setView] = useState<View_>("messages");
  const [toAll, setToAll] = useState(false);       // the "message all drivers" sheet
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!hubId) return;
    try {
      const [n, r] = await Promise.all([
        hubApi.get<{ items: Note[] }>(`/admin/notifications?hub_id=${hubId}&limit=100`),
        hubApi.get<{ items: Req[] }>(`/admin/requests?state=pending&hub_id=${hubId}`),
      ]);
      setNotes(n.items);
      setReqs(r.items);
    } catch {
      // keep what we had
    }
  }, [hubId]);

  useEffect(() => {
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([load(), refresh()]);
    setRefreshing(false);
  }, [load, refresh]);

  // One row per driver: their newest message and how many are unread.
  const threads = useMemo<Thread[]>(() => {
    const by = new Map<string, Thread>();
    for (const n of notes ?? []) {            // newest first
      const th = by.get(n.driver_id);
      if (!th) by.set(n.driver_id, { driver_id: n.driver_id, name: n.driver_name ?? "—", unread: n.read ? 0 : 1, latest: n });
      else if (!n.read) th.unread += 1;
    }
    return [...by.values()].sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || b.latest.created_at.localeCompare(a.latest.created_at));
  }, [notes]);

  const decide = async (r: Req, decision: "approve" | "reject") => {
    setBusyId(r.id);
    try {
      await hubApi.post(`/admin/requests/${r.id}/decide`, { decision });
      say(decision === "approve" ? t.approved : t.reject_done);
      await Promise.all([load(), refresh()]);
    } catch {
      say(t.action_fail, "bad");
    } finally {
      setBusyId(null);
    }
  };

  const unread = threads.reduce((a, th) => a + th.unread, 0);

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top"]}>
      <HubHeader title={t.tab_inbox} right={<Btn label={t.msg_all} small onPress={() => setToAll(true)} testID="hub-msg-all" />} />
      <Segmented
        style={styles.switch} testID="hub-inbox-filter" value={view} onChange={setView}
        options={[{ key: "messages", label: t.messages, count: unread }, { key: "requests", label: t.requests, count: reqs?.length ?? 0 }]}
      />
      <ScrollView contentContainerStyle={hubStyles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {view === "requests" ? (
          <View style={styles.cards} testID="hub-requests">
            {reqs === null ? <Empty>{t.loading}</Empty> : reqs.length === 0 ? (
              <View style={styles.blank}>
                <Icon name="checkmark-done-circle-outline" size={40} color={colors.line} />
                <Text style={styles.blankText}>{t.inbox_empty}</Text>
              </View>
            ) : reqs.map((r) => (
              <View key={r.id} style={hubStyles.card} testID={`hub-req-${r.id}`}>
                <View style={styles.reqTop}>
                  <Avatar name={r.driver_name} tone="warn" />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={styles.nameRow}>
                      <Text style={[hubStyles.name, { flexShrink: 1 }]} numberOfLines={1}>{r.driver_name ?? "—"}</Text>
                      <Tag tone="warn">{t.req[r.type] ?? r.type}</Tag>
                    </View>
                    {details(r) ? <Text style={styles.reqWhat}>{details(r)}</Text> : null}
                    <Text style={hubStyles.sub}>{formatIST(r.created_at)}</Text>
                  </View>
                </View>
                <View style={styles.reqBtns}>
                  <Btn label={t.reject} small kind="danger" onPress={() => decide(r, "reject")} disabled={busyId === r.id} style={{ flex: 1 }} testID={`hub-req-reject-${r.id}`} />
                  <Btn label={t.approve} small onPress={() => decide(r, "approve")} busy={busyId === r.id} style={{ flex: 1 }} testID={`hub-req-approve-${r.id}`} />
                </View>
              </View>
            ))}
          </View>
        ) : (
          <View testID="hub-threads">
            {notes === null ? <Empty>{t.loading}</Empty> : threads.length === 0 ? (
              <View style={styles.blank}>
                <Icon name="chatbubbles-outline" size={40} color={colors.line} />
                <Text style={styles.blankText}>{t.inbox_empty}</Text>
              </View>
            ) : (
              <View style={[hubStyles.card, { paddingVertical: 2 }]}>
                {threads.map((th, i) => (
                  <TouchableOpacity key={th.driver_id} style={[hubStyles.row, styles.thread, i === 0 ? hubStyles.rowFirst : null]}
                    onPress={() => router.push(`/driver/${th.driver_id}?focus=messages` as never)} testID={`hub-thread-${th.driver_id}`}>
                    <Avatar name={th.name} tone={th.unread ? "ok" : "mute"} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={styles.nameRow}>
                        <Text style={[hubStyles.name, { flex: 1 }, th.unread ? null : { fontFamily: fonts.uiMed }]} numberOfLines={1}>{th.name}</Text>
                        <Text style={styles.when}>{formatIST(th.latest.created_at)}</Text>
                      </View>
                      <View style={styles.nameRow}>
                        <Text style={[hubStyles.sub, { flex: 1 }, th.unread ? { color: colors.ink, fontFamily: fonts.uiMed } : null]} numberOfLines={2}>
                          {th.latest.kind === "system" ? `${t.automatic} · ` : ""}{th.latest.body}
                        </Text>
                        {th.unread ? <View style={styles.unread}><Text style={styles.unreadText}>{th.unread}</Text></View> : null}
                      </View>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        )}
      </ScrollView>
      <BroadcastSheet visible={toAll} hubId={hubId ?? ""} onClose={() => setToAll(false)} onDone={(m) => { setToAll(false); say(m); }} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  switch: { marginHorizontal: spacing.md, marginTop: spacing.xs },
  cards: { gap: spacing.md },
  nameRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  thread: { alignItems: "flex-start" },
  when: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted },
  unread: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, backgroundColor: colors.alert, alignItems: "center", justifyContent: "center" },
  unreadText: { fontFamily: fonts.uiBold, fontSize: 12, color: colors.white },
  reqTop: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  reqWhat: { fontFamily: fonts.uiMed, fontSize: 14, color: colors.ink, marginTop: 2 },
  reqBtns: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  blank: { alignItems: "center", gap: spacing.sm, paddingVertical: spacing.xxl },
  blankText: { fontFamily: fonts.ui, fontSize: 14, color: colors.muted },
});
