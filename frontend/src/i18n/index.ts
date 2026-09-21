// Selector lives in header per spec, not in settings.
// Dictionary is deliberately minimal — numbers, colour and position carry
// meaning; text only supports it.
import React, { createContext, useContext, useMemo, useState, useCallback, useEffect } from "react";

import { storage } from "@/src/utils/storage";

export type Lang = "en" | "hi" | "kn";
const STORAGE_KEY = "ride91.lang";

const dict = {
  en: {
    login_title: "Sign in",
    login_subtitle: "Enter the phone and password from your fleet office",
    phone_placeholder: "Phone number",
    password_placeholder: "Password",
    sign_in: "Sign in",
    login_bad_credentials: "Wrong phone or password",
    login_error: "Could not sign in. Try again.",
    login_help: "Use the login your fleet office gave you.",
    change_password: "Change password",
    pw_current: "Current password",
    pw_new: "New password",
    pw_confirm: "Confirm new password",
    pw_save: "Update password",
    pw_changed: "Password updated",
    pw_wrong: "Current password is wrong",
    pw_mismatch: "New passwords don't match",
    pw_short: "At least 6 characters",
    home: "Home",
    money: "Earnings",
    requests: "Requests",
    profile: "Profile",
    on_duty: "On duty",
    distance: "Distance",
    battery: "Battery",
    range: "Range",
    pick_platform: "Pick platform",
    go_offline: "Go offline",
    close_out_title: "Close out block",
    close_out_hint: "How did the last block go?",
    trips: "Trips",
    amount_earned: "Amount earned",
    cash_collected: "Cash collected",
    save: "Save",
    cancel: "Cancel",
    todays_gross: "Today's gross",
    driver_share: "Your share (30%)",
    cash_held: "Cash held",
    over_limit: "OVER LIMIT",
    deposit_cash: "Deposit cash",
    settlement: "Settlement",
    payable: "Payable to you",
    advance: "Advance",
    principal: "Principal",
    daily_recovery: "Daily recovery",
    days_remaining: "Days left",
    weekly: "This week",
    new_request: "New request",
    request_type: "Type",
    submit: "Submit",
    reason: "Reason",
    amount: "Amount",
    date: "Date",
    hours: "Hours",
    pending: "Pending",
    approved: "Approved",
    rejected: "Rejected",
    paid: "Paid",
    unsynced_msg: (n: number) =>
      `${n} saved on your phone, will send by itself.`,
    health_synced: "Synced",
    health_offline: "No network",
    health_location: "Location off",
    health_service: "Service killed",
    fix_now: "Fix now",
    language: "Language",
    logout: "Log out",
    request_advance: "Advance",
    request_holiday: "Holiday",
    request_extra: "Extra hours",
    scan_to_deposit: "Scan with any UPI app to pay",
    qr_amount: "Amount to pay",
    qr_expires_in: "Expires in",
    qr_expired: "This QR has expired",
    qr_new: "Get a new QR",
    qr_waiting: "Waiting for payment…",
    qr_paid: "Payment received",
    qr_paid_hint: "Your cash in hand has been updated.",
    qr_error: "Couldn't create the QR",
    qr_no_dues: "Nothing to pay right now",
    qr_fixed_hint: "The amount is fixed and set by Ride91.",
    retry: "Try again",
    go_to_charger: "Go to charger",
    charging_start: "Start charging",
    charging_stop: "Stop charging",
    charging_now: "Charging",
    charging_heading: "Heading to charger",
    shift_progress: "Shift progress",
    working_hours: "Working hours",
    notif_title: "Notifications",
    notif_empty: "No messages yet. Send one to the office below.",
    notif_placeholder: "Message the office…",
    notif_send: "Send",
    notif_from_ops: "Office",
    notif_from_you: "You",
  },
  hi: {
    login_title: "साइन इन",
    login_subtitle: "फ़्लीट ऑफ़िस से मिला फ़ोन और पासवर्ड डालें",
    phone_placeholder: "फ़ोन नंबर",
    password_placeholder: "पासवर्ड",
    sign_in: "साइन इन",
    login_bad_credentials: "ग़लत फ़ोन या पासवर्ड",
    login_error: "साइन इन नहीं हो सका। फिर कोशिश करें।",
    login_help: "फ़्लीट ऑफ़िस से मिला लॉगिन इस्तेमाल करें।",
    change_password: "पासवर्ड बदलें",
    pw_current: "मौजूदा पासवर्ड",
    pw_new: "नया पासवर्ड",
    pw_confirm: "नया पासवर्ड दोबारा",
    pw_save: "पासवर्ड बदलें",
    pw_changed: "पासवर्ड बदल गया",
    pw_wrong: "मौजूदा पासवर्ड ग़लत है",
    pw_mismatch: "नए पासवर्ड मेल नहीं खाते",
    pw_short: "कम से कम 6 अक्षर",
    home: "होम",
    money: "कमाई",
    requests: "अनुरोध",
    profile: "प्रोफ़ाइल",
    on_duty: "ड्यूटी पर",
    distance: "दूरी",
    battery: "बैटरी",
    range: "रेंज",
    pick_platform: "प्लेटफ़ॉर्म चुनें",
    go_offline: "ऑफ़लाइन जाएँ",
    close_out_title: "ब्लॉक बंद करें",
    close_out_hint: "पिछला ब्लॉक कैसा रहा?",
    trips: "ट्रिप",
    amount_earned: "कमाई",
    cash_collected: "नकद लिया",
    save: "सहेजें",
    cancel: "रद्द",
    todays_gross: "आज की कुल कमाई",
    driver_share: "आपका हिस्सा (30%)",
    cash_held: "आपके पास नकद",
    over_limit: "सीमा पार",
    deposit_cash: "नकद जमा करें",
    settlement: "निपटान",
    payable: "आपको देय",
    advance: "एडवांस",
    principal: "मूल राशि",
    daily_recovery: "दैनिक कटौती",
    days_remaining: "बाकी दिन",
    weekly: "यह सप्ताह",
    new_request: "नया अनुरोध",
    request_type: "प्रकार",
    submit: "जमा करें",
    reason: "कारण",
    amount: "राशि",
    date: "तारीख़",
    hours: "घंटे",
    pending: "लंबित",
    approved: "स्वीकृत",
    rejected: "अस्वीकृत",
    paid: "भुगतान हुआ",
    unsynced_msg: (n: number) => `${n} फ़ोन पर सहेजा, अपने आप भेजा जाएगा।`,
    health_synced: "सिंक",
    health_offline: "नेटवर्क नहीं",
    health_location: "लोकेशन बंद",
    health_service: "सेवा बंद",
    fix_now: "अभी ठीक करें",
    language: "भाषा",
    logout: "लॉग आउट",
    request_advance: "एडवांस",
    request_holiday: "छुट्टी",
    request_extra: "अतिरिक्त घंटे",
    scan_to_deposit: "किसी भी UPI ऐप से स्कैन करके भुगतान करें",
    qr_amount: "भुगतान राशि",
    qr_expires_in: "समय शेष",
    qr_expired: "यह QR समाप्त हो गया",
    qr_new: "नया QR लें",
    qr_waiting: "भुगतान की प्रतीक्षा…",
    qr_paid: "भुगतान मिल गया",
    qr_paid_hint: "आपका नकद शेष अपडेट हो गया है।",
    qr_error: "QR नहीं बन सका",
    qr_no_dues: "अभी कुछ बाकी नहीं है",
    qr_fixed_hint: "राशि Ride91 द्वारा तय है, बदली नहीं जा सकती।",
    retry: "फिर कोशिश करें",
    go_to_charger: "चार्जर जाएँ",
    charging_start: "चार्जिंग शुरू करें",
    charging_stop: "चार्जिंग रोकें",
    charging_now: "चार्जिंग",
    charging_heading: "चार्जर की ओर",
    shift_progress: "शिफ़्ट प्रगति",
    working_hours: "कार्य घंटे",
    notif_title: "सूचनाएँ",
    notif_empty: "अभी कोई संदेश नहीं। नीचे ऑफ़िस को भेजें।",
    notif_placeholder: "ऑफ़िस को संदेश…",
    notif_send: "भेजें",
    notif_from_ops: "ऑफ़िस",
    notif_from_you: "आप",
  },
  kn: {
    login_title: "ಸೈನ್ ಇನ್",
    login_subtitle: "ಫ್ಲೀಟ್ ಕಚೇರಿಯಿಂದ ಸಿಕ್ಕ ಫೋನ್ ಮತ್ತು ಪಾಸ್‌ವರ್ಡ್ ನಮೂದಿಸಿ",
    phone_placeholder: "ಫೋನ್ ನಂಬರ್",
    password_placeholder: "ಪಾಸ್‌ವರ್ಡ್",
    sign_in: "ಸೈನ್ ಇನ್",
    login_bad_credentials: "ತಪ್ಪು ಫೋನ್ ಅಥವಾ ಪಾಸ್‌ವರ್ಡ್",
    login_error: "ಸೈನ್ ಇನ್ ಆಗಲಿಲ್ಲ. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.",
    login_help: "ಫ್ಲೀಟ್ ಕಚೇರಿಯಿಂದ ಸಿಕ್ಕ ಲಾಗಿನ್ ಬಳಸಿ.",
    change_password: "ಪಾಸ್‌ವರ್ಡ್ ಬದಲಿಸಿ",
    pw_current: "ಪ್ರಸ್ತುತ ಪಾಸ್‌ವರ್ಡ್",
    pw_new: "ಹೊಸ ಪಾಸ್‌ವರ್ಡ್",
    pw_confirm: "ಹೊಸ ಪಾಸ್‌ವರ್ಡ್ ದೃಢೀಕರಿಸಿ",
    pw_save: "ಪಾಸ್‌ವರ್ಡ್ ಬದಲಿಸಿ",
    pw_changed: "ಪಾಸ್‌ವರ್ಡ್ ಬದಲಾಯಿತು",
    pw_wrong: "ಪ್ರಸ್ತುತ ಪಾಸ್‌ವರ್ಡ್ ತಪ್ಪಾಗಿದೆ",
    pw_mismatch: "ಹೊಸ ಪಾಸ್‌ವರ್ಡ್‌ಗಳು ಹೊಂದಿಕೆಯಾಗುತ್ತಿಲ್ಲ",
    pw_short: "ಕನಿಷ್ಠ 6 ಅಕ್ಷರಗಳು",
    home: "ಮುಖಪುಟ",
    money: "ಗಳಿಕೆ",
    requests: "ವಿನಂತಿಗಳು",
    profile: "ಪ್ರೊಫೈಲ್",
    on_duty: "ಕರ್ತವ್ಯದಲ್ಲಿ",
    distance: "ದೂರ",
    battery: "ಬ್ಯಾಟರಿ",
    range: "ವ್ಯಾಪ್ತಿ",
    pick_platform: "ಪ್ಲಾಟ್‌ಫಾರ್ಮ್ ಆಯ್ಕೆ",
    go_offline: "ಆಫ್‌ಲೈನ್",
    close_out_title: "ಬ್ಲಾಕ್ ಮುಚ್ಚಿ",
    close_out_hint: "ಹಿಂದಿನ ಬ್ಲಾಕ್ ಹೇಗಿತ್ತು?",
    trips: "ಟ್ರಿಪ್",
    amount_earned: "ಗಳಿಕೆ",
    cash_collected: "ನಗದು",
    save: "ಉಳಿಸಿ",
    cancel: "ರದ್ದು",
    todays_gross: "ಇಂದಿನ ಒಟ್ಟು",
    driver_share: "ನಿಮ್ಮ ಭಾಗ (30%)",
    cash_held: "ನಗದು ಇರುವುದು",
    over_limit: "ಮಿತಿ ಮೀರಿದೆ",
    deposit_cash: "ನಗದು ಠೇವಣಿ",
    settlement: "ಇತ್ಯರ್ಥ",
    payable: "ನಿಮಗೆ ಪಾವತಿ",
    advance: "ಮುಂಗಡ",
    principal: "ಮೂಲಧನ",
    daily_recovery: "ದೈನಿಕ ಕಡಿತ",
    days_remaining: "ಬಾಕಿ ದಿನ",
    weekly: "ಈ ವಾರ",
    new_request: "ಹೊಸ ವಿನಂತಿ",
    request_type: "ಪ್ರಕಾರ",
    submit: "ಸಲ್ಲಿಸು",
    reason: "ಕಾರಣ",
    amount: "ಮೊತ್ತ",
    date: "ದಿನಾಂಕ",
    hours: "ಗಂಟೆ",
    pending: "ಬಾಕಿ",
    approved: "ಅನುಮೋದನೆ",
    rejected: "ತಿರಸ್ಕರಿಸಲಾಗಿದೆ",
    paid: "ಪಾವತಿಸಿದೆ",
    unsynced_msg: (n: number) => `${n} ಫೋನಿನಲ್ಲಿ ಉಳಿಸಿದೆ, ಸ್ವಯಂ ಕಳುಹಿಸುತ್ತದೆ.`,
    health_synced: "ಸಿಂಕ್",
    health_offline: "ನೆಟ್‌ವರ್ಕ್ ಇಲ್ಲ",
    health_location: "ಸ್ಥಳ ಆಫ್",
    health_service: "ಸೇವೆ ನಿಂತಿದೆ",
    fix_now: "ಸರಿಪಡಿಸಿ",
    language: "ಭಾಷೆ",
    logout: "ಲಾಗ್ ಔಟ್",
    request_advance: "ಮುಂಗಡ",
    request_holiday: "ರಜೆ",
    request_extra: "ಹೆಚ್ಚುವರಿ ಗಂಟೆ",
    scan_to_deposit: "ಯಾವುದೇ UPI ಆ್ಯಪ್‌ನಿಂದ ಸ್ಕ್ಯಾನ್ ಮಾಡಿ ಪಾವತಿಸಿ",
    qr_amount: "ಪಾವತಿಸಬೇಕಾದ ಮೊತ್ತ",
    qr_expires_in: "ಉಳಿದ ಸಮಯ",
    qr_expired: "ಈ QR ಅವಧಿ ಮುಗಿದಿದೆ",
    qr_new: "ಹೊಸ QR ಪಡೆಯಿರಿ",
    qr_waiting: "ಪಾವತಿಗಾಗಿ ಕಾಯಲಾಗುತ್ತಿದೆ…",
    qr_paid: "ಪಾವತಿ ಸ್ವೀಕರಿಸಲಾಗಿದೆ",
    qr_paid_hint: "ನಿಮ್ಮ ನಗದು ಬಾಕಿ ನವೀಕರಿಸಲಾಗಿದೆ.",
    qr_error: "QR ರಚಿಸಲು ಆಗಲಿಲ್ಲ",
    qr_no_dues: "ಈಗ ಪಾವತಿಸಲು ಏನೂ ಇಲ್ಲ",
    qr_fixed_hint: "ಮೊತ್ತವನ್ನು Ride91 ನಿಗದಿಪಡಿಸಿದೆ, ಬದಲಾಯಿಸಲಾಗದು.",
    retry: "ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ",
    go_to_charger: "ಚಾರ್ಜರ್‌ಗೆ ಹೋಗಿ",
    charging_start: "ಚಾರ್ಜಿಂಗ್ ಆರಂಭಿಸಿ",
    charging_stop: "ಚಾರ್ಜಿಂಗ್ ನಿಲ್ಲಿಸಿ",
    charging_now: "ಚಾರ್ಜಿಂಗ್",
    charging_heading: "ಚಾರ್ಜರ್ ಕಡೆಗೆ",
    shift_progress: "ಶಿಫ್ಟ್ ಪ್ರಗತಿ",
    working_hours: "ಕೆಲಸದ ಗಂಟೆ",
    notif_title: "ಅಧಿಸೂಚನೆಗಳು",
    notif_empty: "ಇನ್ನೂ ಸಂದೇಶಗಳಿಲ್ಲ. ಕೆಳಗೆ ಕಚೇರಿಗೆ ಕಳುಹಿಸಿ.",
    notif_placeholder: "ಕಚೇರಿಗೆ ಸಂದೇಶ…",
    notif_send: "ಕಳುಹಿಸಿ",
    notif_from_ops: "ಕಚೇರಿ",
    notif_from_you: "ನೀವು",
  },
};

type Dict = typeof dict.en;

interface I18nCtx {
  lang: Lang;
  t: Dict;
  setLang: (l: Lang) => void;
}

const Ctx = createContext<I18nCtx | null>(null);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Lang>("en");
  useEffect(() => {
    (async () => {
      const stored = await storage.getItem<Lang>(STORAGE_KEY, "en");
      if (stored) setLangState(stored);
    })();
  }, []);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    storage.setItem(STORAGE_KEY, l);
  }, []);
  const value = useMemo<I18nCtx>(() => ({ lang, t: dict[lang], setLang }), [lang, setLang]);
  return React.createElement(Ctx.Provider, { value }, children);
};

export const useI18n = (): I18nCtx => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useI18n outside provider");
  return c;
};

// en-IN money formatter (₹1,23,456)
export const formatINR = (n: number): string => {
  const rounded = Math.round(n);
  return "₹" + rounded.toLocaleString("en-IN");
};

export const formatDuration = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, "0")}m`;
};

// All timestamps rendered in the app pass through this. Asia/Kolkata, human
// readable ("Today 12:32 pm", "Wed 6 Aug 12:32 pm", "6 Aug 2025 12:32 pm").
export const formatIST = (input: string | number | Date | undefined | null): string => {
  if (!input) return "—";
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return "—";
  const now = new Date();
  const optsTime: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  };
  const optsDate: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  };
  const optsYear: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  };
  const day = (x: Date) =>
    x.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" });
  const isSameDay = day(d) === day(now);
  const t = d.toLocaleTimeString("en-IN", optsTime).replace(" AM", " am").replace(" PM", " pm");
  if (isSameDay) return `Today ${t}`;
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  const dateStr = sameYear
    ? d.toLocaleDateString("en-IN", optsDate)
    : d.toLocaleDateString("en-IN", optsYear);
  return `${dateStr} ${t}`;
};

// Short "Mon 4 Aug" / "6 Aug 2024" — no time. For headers and list dates.
export const formatISTDate = (input: string | number | Date | undefined | null): string => {
  if (!input) return "—";
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return "—";
  const now = new Date();
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  return d.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
    timeZone: "Asia/Kolkata",
  });
};
