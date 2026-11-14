// Words for referral earnings, shared by the driver app and the Hub app.
// English and Hindi; Kannada falls back to English.
import { useI18n } from "@/src/i18n";
import { useCalendarText } from "@/src/i18n/calendar";

const en = {
  title: "Referral earnings",
  card_title: "🤝 Referral earnings",
  card_sub_due: (date: string) => `This month so far · paid on ${date}`,
  card_sub_paid: "This month · paid into your salary",
  rule: (pct: string, min: string) =>
    `You earn ${pct}% of a friend's fares on every day they reach ${min}. Each month is paid into your salary after the 5th of the next month.`,
  rule_paid_on: (date: string) => `This month is paid on ${date}.`,
  paid: "Paid into your salary",
  to_be_paid: (date: string) => `To be paid on ${date}`,
  month_total: "This month",
  friends: "Drivers you referred",
  since: (date: string) => `since ${date}`,
  left: "left Ride91",
  days: "Day by day",
  no_days: "No referral earnings this month.",
  off: "Referral earnings are switched off for now.",
  prev: "Previous month",
  next: "Next month",
  loading: "Loading…",
  failed: "Could not load. Pull down to try again.",
  referred_by: (name: string, date: string) => `🤝 Referred by ${name} (since ${date})`,
  invite_title: "🤝 Refer a driver",
  invite_sub: (pct: string, min: string) => `Earn ${pct}% of their fares on every day they reach ${min}`,
  invite_how: "To refer someone, tell your hub their name and phone number. The office adds them as referred by you.",
  df_title: "Referred by (optional)",
  df_search: "Search name or phone",
  df_none: "Nobody",
  df_hint: "They earn a share of this driver's good days. Only the owner can change it later.",
  df_no_match: "No driver in your hub matches.",
  df_inactive: "That driver has left Ride91. Pick someone else, or leave it empty.",
};

type ReferralText = typeof en;

const hi: ReferralText = {
  title: "रेफ़रल कमाई",
  card_title: "🤝 रेफ़रल कमाई",
  card_sub_due: (date) => `इस महीने अब तक · ${date} को मिलेगा`,
  card_sub_paid: "इस महीने · आपकी सैलरी में जुड़ गया",
  rule: (pct, min) =>
    `आपके लाए दोस्त का किराया जिस दिन ${min} तक पहुँचे, उस दिन के किराये का ${pct}% आपको मिलता है। हर महीने की रकम अगले महीने की 5 तारीख के बाद सैलरी में जुड़ती है।`,
  rule_paid_on: (date) => `इस महीने की रकम ${date} को मिलेगी।`,
  paid: "सैलरी में जुड़ गया",
  to_be_paid: (date) => `${date} को मिलेगा`,
  month_total: "इस महीने",
  friends: "आपके लाए ड्राइवर",
  since: (date) => `${date} से`,
  left: "Ride91 छोड़ दिया",
  days: "दिन-ब-दिन",
  no_days: "इस महीने कोई रेफ़रल कमाई नहीं।",
  off: "रेफ़रल कमाई अभी बंद है।",
  prev: "पिछला महीना",
  next: "अगला महीना",
  loading: "लोड हो रहा है…",
  failed: "लोड नहीं हुआ। नीचे खींचकर फिर कोशिश करें।",
  referred_by: (name, date) => `🤝 ${name} के रेफ़रल से (${date} से)`,
  invite_title: "🤝 ड्राइवर लाइए",
  invite_sub: (pct, min) => `जिस दिन उनका किराया ${min} तक पहुँचे, उस दिन के किराये का ${pct}% आपको`,
  invite_how: "किसी को लाने के लिए अपने हब को उनका नाम और फ़ोन नंबर बताइए। ऑफ़िस उन्हें आपके रेफ़रल से जोड़ देगा।",
  df_title: "किसके रेफ़रल से (ज़रूरी नहीं)",
  df_search: "नाम या फ़ोन से खोजें",
  df_none: "किसी के नहीं",
  df_hint: "इस ड्राइवर के अच्छे दिनों का हिस्सा उन्हें मिलेगा। बाद में सिर्फ़ मालिक इसे बदल सकते हैं।",
  df_no_match: "आपके हब में ऐसा कोई ड्राइवर नहीं।",
  df_inactive: "वह ड्राइवर Ride91 छोड़ चुका है। कोई और चुनें, या खाली छोड़ें।",
};

export const useReferralText = (): ReferralText => {
  const { lang } = useI18n();
  return lang === "hi" ? hi : en;
};

export type { ReferralText };

export interface ReferralMonth {
  month: string;
  first_month: string;
  enabled: boolean;
  rate: number;
  daily_min: number;
  total: number;
  paid: boolean;
  pay_date: string;
  people: { name: string; since: string; active: boolean }[];
  days: { date: string; name: string; amount: number }[];
}

// Referral amounts are small and often not whole rupees, so keep the paise.
export const fmtRupees = (n: number): string =>
  "₹" + (n ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: Number.isInteger(n) ? 0 : 2 });

export function useDayLabel() {
  const ct = useCalendarText();
  return (d: string) => `${Number(d.slice(8, 10))} ${ct.months[Number(d.slice(5, 7)) - 1]}`;
}

