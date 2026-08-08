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
    login_subtitle: "Enter your driver phone number",
    phone_placeholder: "Phone number",
    otp_placeholder: "6-digit code",
    send_otp: "Send code",
    verify_otp: "Verify",
    demo_hint: "Demo OTP: 123456",
    home: "Home",
    money: "Money",
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
    scan_to_deposit: "Show this to the cash collector",
    shift_progress: "Shift progress",
    working_hours: "Working hours",
  },
  hi: {
    login_title: "साइन इन",
    login_subtitle: "अपना ड्राइवर फ़ोन नंबर डालें",
    phone_placeholder: "फ़ोन नंबर",
    otp_placeholder: "6 अंकों का कोड",
    send_otp: "कोड भेजें",
    verify_otp: "पुष्टि करें",
    demo_hint: "डेमो OTP: 123456",
    home: "होम",
    money: "पैसा",
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
    scan_to_deposit: "यह कैश कलेक्टर को दिखाएँ",
    shift_progress: "शिफ़्ट प्रगति",
    working_hours: "कार्य घंटे",
  },
  kn: {
    login_title: "ಸೈನ್ ಇನ್",
    login_subtitle: "ನಿಮ್ಮ ಡ್ರೈವರ್ ಫೋನ್ ನಂಬರ್ ನಮೂದಿಸಿ",
    phone_placeholder: "ಫೋನ್ ನಂಬರ್",
    otp_placeholder: "6-ಅಂಕಿಯ ಕೋಡ್",
    send_otp: "ಕೋಡ್ ಕಳುಹಿಸಿ",
    verify_otp: "ದೃಢೀಕರಿಸಿ",
    demo_hint: "ಡೆಮೊ OTP: 123456",
    home: "ಮುಖಪುಟ",
    money: "ಹಣ",
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
    scan_to_deposit: "ನಗದು ಸಂಗ್ರಾಹಕರಿಗೆ ತೋರಿಸಿ",
    shift_progress: "ಶಿಫ್ಟ್ ಪ್ರಗತಿ",
    working_hours: "ಕೆಲಸದ ಗಂಟೆ",
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
