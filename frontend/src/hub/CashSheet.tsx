// Record cash a driver has just handed over. The receipt number is required
// and can only be used once per driver, so the same hand-in cannot be entered
// twice; the entry is written to the audit log with the manager's name.
import React, { useEffect, useState } from "react";
import { Text, TextInput } from "react-native";

import { BottomSheet } from "@/src/components/ui";
import { formatINR } from "@/src/i18n";
import { hubApi } from "@/src/hub/session";
import { useHubText } from "@/src/hub/text";
import { Btn, hubStyles } from "@/src/hub/ui";
import { colors, spacing } from "@/src/theme";

export interface CashTarget { driver_id: string; name: string | null; you_owe: number }

export const CashSheet: React.FC<{
  target: CashTarget | null;
  onClose: () => void;
  onDone: (message: string) => void;
}> = ({ target, onClose, onDone }) => {
  const t = useHubText();
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setAmount(target.you_owe > 0 ? String(Math.round(target.you_owe)) : "");
    setReference("");
    setNote("");
    setErr(null);
  }, [target]);

  const submit = async () => {
    if (!target || busy) return;
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0) return setErr(t.cash_bad_amount);
    if (reference.trim().length < 3) return setErr(t.cash_bad_ref);
    setBusy(true);
    setErr(null);
    try {
      const r = await hubApi.post<{ duplicate: boolean }>(`/admin/drivers/${target.driver_id}/cash-deposit`, {
        amount: a,
        reference: reference.trim(),
        reason: note.trim().length >= 3 ? note.trim() : t.cash_note_default,
      });
      if (r.duplicate) return setErr(t.cash_dup);
      onDone(t.cash_done(formatINR(a), target.name ?? ""));
    } catch {
      setErr(t.cash_fail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet visible={!!target} onClose={() => (busy ? undefined : onClose())} title={target ? t.cash_sheet_title(target.name ?? "") : ""} testID="hub-cash-sheet">
      <Text style={hubStyles.label}>{t.amount}</Text>
      <TextInput testID="hub-cash-amount" value={amount} onChangeText={(v) => setAmount(v.replace(/[^0-9.]/g, ""))} keyboardType="numeric" style={hubStyles.input} placeholder="0" placeholderTextColor={colors.muted} />
      <Text style={hubStyles.label}>{t.receipt_no}</Text>
      <TextInput testID="hub-cash-ref" value={reference} onChangeText={setReference} autoCapitalize="characters" style={hubStyles.input} placeholder="R-1042" placeholderTextColor={colors.muted} />
      <Text style={hubStyles.label}>{t.note}</Text>
      <TextInput testID="hub-cash-note" value={note} onChangeText={setNote} style={hubStyles.input} placeholder={t.cash_note_default} placeholderTextColor={colors.muted} />
      {err ? <Text style={hubStyles.err} testID="hub-cash-err">{err}</Text> : null}
      <Btn label={t.record_cash} onPress={submit} busy={busy} style={{ marginTop: spacing.md }} testID="hub-cash-submit" />
    </BottomSheet>
  );
};
