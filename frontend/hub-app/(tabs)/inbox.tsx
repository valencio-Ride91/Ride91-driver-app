// Inbox — what drivers have written (and the automatic alerts about their
// shift), plus their requests for leave, an advance or extra hours.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { formatIST, formatINR } from "@/src/i18n";
import { hubApi, useHubSession } from "@/src/hub/session";
import { useHubText } from "@/src/hub/text";
import { useHubToday } from "@/src/hub/today";
import { Btn, Empty, HubHeader, SectionTitle, Tag, hubStyles } from "@/src/hub/ui";
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
  driver_id: string;
  driver_name: string | null;
  type: string;
  payload: Record<string, unknown> | null;
  created_at: string;
  state: string;
}

interface Thread { driver_id: string; name: string; unread: number; latest: Note }

type Filter = "all" | "messages" | "requests";

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
  const { session } = useHubSession();
  const { refresh } = useHubToday();
  const hubId = session?.hubId;
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [reqs, setReqs] = useState<Req[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

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
    setErr(null);
    try {
      await hubApi.post(`/admin/requests/${r.id}/decide`, { decision });
      setMsg(decision === "approve" ? t.approved : t.reject_done);
      setTimeout(() => setMsg(null), 4000);
      await Promise.all([load(), refresh()]);
    } catch {
      setErr(t.action_fail);
    } finally {
      setBusyId(null);
    }
  };

  const unread = threads.reduce((a, th) => a + th.unread, 0);
  const showMessages = filter !== "requests";
  const showRequests = filter !== "messages";

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top"]}>
      <HubHeader title={t.tab_inbox} />
      <ScrollView contentContainerStyle={hubStyles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        <View style={styles.filters}>
          {(["all", "messages", "requests"] as Filter[]).map((f) => (
            <TouchableOpacity key={f} onPress={() => setFilter(f)} style={[styles.chip, filter === f ? styles.chipOn : null]} testID={`hub-inbox-filter-${f}`}>
              <Text style={[styles.chipText, filter === f ? styles.chipTextOn : null]}>
                {f === "all" ? t.all : f === "messages" ? `${t.messages}${unread ? ` ${unread}` : ""}` : `${t.requests}${reqs?.length ? ` ${reqs.length}` : ""}`}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        {msg ? <Text style={hubStyles.done}>{msg}</Text> : null}
        {err ? <Text style={[hubStyles.err, { marginBottom: spacing.sm }]}>{err}</Text> : null}

        {showRequests ? (
          <>
            <SectionTitle>{t.requests}</SectionTitle>
            <View style={hubStyles.card} testID="hub-requests">
              {reqs === null ? <Empty>{t.loading}</Empty> : reqs.length === 0 ? <Empty>{t.inbox_empty}</Empty> : reqs.map((r, i) => (
                <View key={r.id} style={[{ paddingVertical: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.line }]} testID={`hub-req-${r.id}`}>
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                    <Text style={hubStyles.name}>{r.driver_name ?? "—"}</Text>
                    <Tag tone="warn">{t.req[r.type] ?? r.type}</Tag>
                  </View>
                  <Text style={hubStyles.sub}>{[details(r), formatIST(r.created_at)].filter(Boolean).join(" · ")}</Text>
                  <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm }}>
                    <Btn label={t.approve} small onPress={() => decide(r, "approve")} busy={busyId === r.id} testID={`hub-req-approve-${r.id}`} />
                    <Btn label={t.reject} small kind="danger" onPress={() => decide(r, "reject")} disabled={busyId === r.id} testID={`hub-req-reject-${r.id}`} />
                  </View>
                </View>
              ))}
            </View>
          </>
        ) : null}

        {showMessages ? (
          <>
            <SectionTitle>{t.messages}</SectionTitle>
            <View style={hubStyles.card} testID="hub-threads">
              {notes === null ? <Empty>{t.loading}</Empty> : threads.length === 0 ? <Empty>{t.inbox_empty}</Empty> : threads.map((th, i) => (
                <TouchableOpacity key={th.driver_id} style={[hubStyles.row, i === 0 ? hubStyles.rowFirst : null]}
                  onPress={() => router.push(`/driver/${th.driver_id}?focus=messages` as never)} testID={`hub-thread-${th.driver_id}`}>
                  <View style={{ flex: 1 }}>
                    <Text style={hubStyles.name}>{th.name}</Text>
                    <Text style={[hubStyles.sub, th.unread ? { color: colors.ink, fontFamily: fonts.uiMed } : null]} numberOfLines={2}>
                      {th.latest.kind === "system" ? `${t.automatic} · ` : ""}{th.latest.body}
                    </Text>
                    <Text style={hubStyles.sub}>{formatIST(th.latest.created_at)}</Text>
                  </View>
                  {th.unread ? <Tag tone="bad">{t.new_count(th.unread)}</Tag> : null}
                </TouchableOpacity>
              ))}
            </View>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: "row", gap: spacing.sm },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontFamily: fonts.uiBold, fontSize: 13, color: colors.ink },
  chipTextOn: { color: colors.white },
});
