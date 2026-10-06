// Text for the cards inside the tabs (Home, Earnings, Rewards, Profile).
//
// The small `dict` in ./index covers navigation and shared words in all three
// languages. The cards carry far more copy, and it exists in English and Hindi:
// a driver who picks Hindi sees every card in Hindi, anyone else (including
// Kannada, until that copy is written) sees English.
//
// Wording aims at plain, spoken Hindi with the everyday loanwords drivers use
// (ड्यूटी, शिफ़्ट, बोनस, हब, QR, UPI). Amounts, times and car numbers stay in
// Latin digits.

import { useI18n } from "@/src/i18n";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_HI = ["जनवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर"];

const monthLabel = (names: string[]) => (ym: string): string => {
  const [y, m] = (ym ?? "").split("-").map(Number);
  return m >= 1 && m <= 12 ? `${names[m - 1]} ${y}` : ym;
};

const en = {
  // ---- shared ----
  refresh: "Refresh",
  back: "Back",
  status: "Status",
  saving: "Saving…",
  try_again: "Please try again.",

  // ---- Home ----
  home_owe_over: (amt: string) => `You owe ${amt} · OVER LIMIT`,
  home_owe: (amt: string) => `You owe ${amt} — deposit your cash to clear it.`,
  duty_label: "Ride91 duty",
  on_duty_for: (dur: string) => `On duty · ${dur}`,
  end_duty: "End duty",
  start_duty: "Start duty",
  online_on: "Online on",
  start_duty_to_enable: "  · start duty to enable",
  on: "ON",
  off: "OFF",
  not_online: "Not online on any app",
  shift: "Shift",

  // ---- Earnings ----
  earnings: "Earnings",
  settled: "SETTLED",
  pending: "PENDING",
  period_yesterday: "Yesterday",
  period_week: "This week",
  period_month: "This month",
  earn_sub: (label: string, pct: number, gross: string) => `${label} · your ${pct}% of ${gross} gross`,
  earn_days: (n: number) => ` · ${plural(n, "day")}`,
  yesterdays_cash: "Yesterday's cash",
  platform_cash: (name: string) => `${name} cash`,
  cash_collected: "Cash collected",
  deposited: "Deposited",
  cash_to_settle: "Cash to settle from yesterday",
  your_balance: "Your balance",
  in_credit: "In credit",
  you_owe: "You owe",
  over_limit_deposit: (limit: number) => `Over ₹${limit} — deposit now`,
  pay_dues: (amt: string) => `Pay ₹${amt} dues via UPI / card`,

  // ---- Collection QR ----
  collect_payment: "Collect payment",
  qr_not_setup: "Not set up yet — ask the office to enable your QR.",
  qr_not_ready: "Your QR isn't ready yet. Pull down to refresh.",
  show_to_rider: "Show this to the rider to pay by UPI",
  tap_enlarge: "Tap to enlarge",
  received: (amt: string) => `✓ Received ${amt}`,
  collected_today: "Collected today",
  pays: (n: number) => `${n} pay${n === 1 ? "" : "s"}`,
  no_payments_today: "No payments yet today — they appear here the moment a rider pays.",
  tap_close: "Tap anywhere to close",

  // ---- Payouts ----
  payouts: "Payouts",
  payouts_sub: "Fleet-to-driver bank transfers. Payouts appear here once ops releases them. Save your bank / UPI in Profile first.",
  payouts_error: "Couldn't load payouts. Pull to refresh.",
  no_payouts: "No payouts yet.",
  payout_status: {
    processed: "Paid",
    processing: "Processing",
    queued: "Queued",
    pending: "Pending",
    reversed: "Reversed",
    failed: "Failed",
    cancelled: "Cancelled",
    rejected: "Rejected",
  } as Record<string, string>,

  // ---- Rewards: this week ----
  this_week: "This week 🏆",
  on_top_30: "on top of your 30%",
  days_operated: "Days operated",
  loading: "Loading…",
  tier_daily: "Top car of the day",
  tier_car_week: "Top car of the week",
  tier_driver_week: "Top driver of the week",
  note_daily: "yesterday's earnings",
  note_car_week: (n: number) => `this week · all ${n} days needed`,
  note_driver_week: "your earnings this week",

  // ---- Rewards: loyalty wallet ----
  wallet_title: "Loyalty wallet 💰",
  wallet_hint: "grows every day you drive",
  wallet_from_days: (amt: string, days: number) => `${amt} from ${days} days`,
  wallet_milestones: (amt: string) => ` + ${amt} milestones`,
  wallet_paid: (amt: string) => ` · ${amt} paid`,
  wallet_note: "Earnings milestones land here too. Paid out by the office — you keep it by staying, it's lost if you leave.",

  // ---- Rewards: how to win ----
  how_to_win: "How to win",
  tip_all_days: "• Keep the car running all 7 days.",
  tip_safe: "• Safe driving and good service count for Top Driver.",
  tip_on_top: "Rewards are paid on top of your 30% earnings.",

  // ---- Attendance ----
  att_title: "Attendance bonus 📅",
  att_month: monthLabel(MONTHS_EN),
  att_counted_days: "COUNTED DAYS",
  att_bonus: "BONUS",
  att_paid: "Bonus paid for this month.",
  att_qualified: "You've qualified. The office pays this bonus after the month ends.",
  att_out_of_reach: (need: number, left: number) =>
    `Out of reach this month: ${plural(need, "more day")} needed, ${plural(left, "day")} left. A new count starts next month.`,
  att_need: (need: number) => `${plural(need, "more counted day")} needed`,
  att_left: (left: number) => ` · ${plural(left, "day")} left this month`,
  att_days_done_gross: (amt: string) => `Days done. Earn ${amt} more this month to qualify.`,
  att_days_done: "Days done.",
  att_day_counts: "A DAY COUNTS WHEN YOU",
  att_rule_earn: (amt: string) => `Earn ${amt} or more in fares that day`,
  att_rule_no_shift: "Start duty on time. Your hub hasn't set your shift time yet. Ask your hub to set it, or your days may not be counted.",
  att_rule_start_by: (cutoff: string, shift: string | null, grace: number) =>
    `Start duty by ${cutoff}` + (grace > 0 ? ` (your ${shift} shift + ${grace} min)` : " (your shift time)"),
  att_rule_on_time: (grace: number) => `Start duty on time${grace > 0 ? ` (within ${grace} min of your shift)` : ""}`,
  att_to_get_bonus: "TO GET THE BONUS",
  att_rule_days: (n: number) => `Reach ${plural(n, "counted day")} this month`,
  att_rule_month_gross: (min: string, at: string) => `Earn ${min} in fares this month (you're at ${at})`,
  att_note: "Yesterday's day is added once the office enters your earnings. The bonus is on top of your share and is paid by the office.",

  // ---- Loyalty milestones ----
  loy_title: "Loyalty milestones 🎖️",
  loy_tenure: (days: number) => {
    if (days < 60) return `${days} days`;
    if (days < 365) return `${Math.floor(days / 30)} months`;
    const y = Math.floor(days / 365);
    const mo = Math.floor((days % 365) / 30);
    return mo ? `${y}y ${mo}mo` : `${y} year${y > 1 ? "s" : ""}`;
  },
  loy_with_ride91: (tenure: string) => `${tenure} with Ride91`,
  loy_total_earned: "TOTAL EARNED",
  loy_bonus_unlocked: "BONUS UNLOCKED",
  loy_reached: (done: number, total: number) => `${done} of ${total} milestone${total === 1 ? "" : "s"} reached`,
  loy_none: "No milestones have been set yet.",
  // The office names each milestone in English; Hindi builds its own from the amount.
  loy_label: (label: string, _amount: string) => label,
  loy_unlocked: "Unlocked · added to your wallet",
  loy_lost: "Reached, but lost on leaving",
  loy_to_go: (amt: string) => `${amt} to go`,
  loy_unlocks_at: (amt: string) => `Unlocks at ${amt} earned`,
  loy_all_done: "You've reached every milestone. Thank you!",
  loy_note: "Bonuses land in your loyalty wallet and are paid by the office. Milestones unlock only while you're active.",

  // ---- Profile: vehicle ----
  vehicle: "Vehicle",
  veh_number: "Number",
  veh_model: "Model",
  veh_battery: "Battery",
  home_hub: "Home hub",
  hub_not_set: "Hub not set",

  // ---- Profile: shift alarm ----
  shift_alarm: "Shift alarm",
  alarm_ready: "Native ready",
  alarm_preview_only: "Preview only",
  alarm_sub: "Wakes your phone 1 hour before the shift starts and again when it's time to head back to the hub.",
  set_by_hub: "Set by your hub",
  start_alarm: "Start alarm",
  next_shift: "Next shift",
  not_scheduled: "Not scheduled",
  fires_at: "Fires at",
  alarm_state: (state: string) => state,
  end_alarm: "End alarm (dynamic ETA)",
  shift_ends: "Shift ends",
  distance_to_hub: "Distance to hub",
  eta: "ETA",
  eta_min: (min: number) => `${min} min`,
  eta_avg: (kmph: string) => `  ·  avg ${kmph} km/h`,
  alarm_at: "Alarm at",
  fire_window: "🟠 fire window open",
  set_home_hub: "Set a home hub to enable dynamic ETA-to-hub alarm.",
  hub_sets_time: "Your hub sets your wake-up time. The alarm arms automatically — contact your hub to change it.",
  schedule_shift: "Schedule shift",
  alarm_scheduled: "Alarm scheduled",
  alarm_not_scheduled: "Could not schedule — try again",
  when_next_shift: "When is your next shift?",
  how_long_shift: "How long is your shift?",
  starts_at: (when: string) => `Start: ${when}`,
  ends_at: (when: string) => `Ends: ${when}`,
  shift_presets: ["In 2 hours (day)", "In 5 hours (day)", "Tomorrow 6 AM", "Tonight 10 PM (night)"],
  duration_hours: (h: number) => `${h} hours`,
  no_end_alarm: "No end alarm",

  // ---- Profile: documents ----
  documents: "Documents",
  docs_attention: (n: number) => `${n} need attention`,
  docs_all_valid: "All valid",
  doc_status: { expired: "Expired", expiring_soon: "Renew ≤30d", ok: "Valid", missing: "Missing" } as Record<string, string>,
  // English keeps the name the server sends.
  doc_label: (_type: string, label: string) => label,
  doc_expires: (date: string) => `expires ${date}`,
  doc_no_expiry: "no expiry on file",
  doc_fallback: "Document",
  doc_number: "Document number",
  doc_expiry_field: "Expiry (YYYY-MM-DD)",
  doc_image_chosen: "Image chosen · tap to change",
  doc_attach: "Attach photo of document",
  doc_perm_title: "Photo permission needed",
  doc_perm_body: "Allow photo library access to upload a document image.",
  doc_expiry_bad: "Expiry must be YYYY-MM-DD",

  // ---- Profile: payout destination ----
  bank_title: "Payout destination",
  bank_verified: "Verified",
  bank_pending: "Pending verification",
  bank_sub: "Where Ride91 sends your Monday payout. Bank transfer (IMPS) or UPI — your choice.",
  bank_type: "Type",
  bank_kind_bank: "Bank account (IMPS)",
  bank_kind_upi: "UPI (VPA)",
  bank_holder: "Holder",
  bank_account: "Account",
  bank_upi_id: "UPI ID",
  bank_none: "No payout destination saved yet.",
  bank_update: "Update details",
  bank_add: "Add bank / UPI",
  bank_tab_bank: "Bank (IMPS)",
  bank_holder_name: "Account holder name",
  bank_holder_ph: "As on passbook",
  bank_acc_number: "Account number",
  bank_acc_ph: "6–26 digits",
  bank_acc_confirm: "Confirm account number",
  bank_acc_confirm_ph: "Re-enter",
  bank_upi_field: "UPI ID (VPA)",
  bank_upi_help: "You'll receive UPI payouts here. Payment reaches you within minutes.",
  bank_err_holder: "Enter the account-holder name.",
  bank_err_acc: "Account number should be 6–26 digits.",
  bank_err_match: "Account numbers don't match.",
  bank_err_ifsc: "IFSC looks wrong (e.g. HDFC0001234).",
  bank_err_upi: "Enter a valid UPI ID (e.g. name@upi).",
  bank_check: "Check details",
  bank_save_failed: "Couldn't save",
  bank_bad_ifsc: "IFSC looks wrong. Please double-check.",
  bank_bad_upi: "That UPI ID looks wrong.",

  // ---- Profile: consents ----
  consents: "Consents",
  consents_sub: "You can withdraw any consent at any time. Withdrawals are stored with a full audit trail.",
  consent_label: (_kind: string, label: string) => label,
  consent_changed: (granted: boolean, date: string) => `${granted ? "Granted" : "Withdrawn"} on ${date}`,
  consent_undecided: "Not decided yet",
  consent_withdraw_q: "Withdraw consent?",
  consent_withdraw_body: (label: string) =>
    `You're withdrawing consent for: ${label}. Some features that rely on this will stop working until you grant it again.`,
  consent_withdraw: "Withdraw",
};

export type CardText = typeof en;

const DOC_HI: Record<string, string> = {
  driving_licence: "ड्राइविंग लाइसेंस",
  vehicle_rc: "गाड़ी की RC",
  insurance: "गाड़ी का बीमा",
  puc: "प्रदूषण प्रमाणपत्र (PUC)",
  permit: "कमर्शियल परमिट",
  aadhaar: "आधार",
  pan: "पैन कार्ड",
};

const CONSENT_HI: Record<string, string> = {
  location_tracking: "ड्यूटी के दौरान लोकेशन ट्रैकिंग",
  camera_and_video: "जाँच के लिए कैमरा और वीडियो",
  cash_handling: "हमारी ओर से नकद लेना और उसका हिसाब देना",
  communications: "काम से जुड़े SMS / WhatsApp / ईमेल",
  terms_of_service: "Ride91 ड्राइवर सेवा की शर्तें",
};

const ALARM_STATE_HI: Record<string, string> = {
  scheduled: "तय है",
  responded: "जवाब दिया",
  no_response: "जवाब नहीं दिया",
  na: "—",
};

const hi: CardText = {
  // ---- shared ----
  refresh: "रीफ़्रेश",
  back: "वापस",
  status: "स्थिति",
  saving: "सहेज रहे हैं…",
  try_again: "फिर कोशिश करें।",

  // ---- Home ----
  home_owe_over: (amt) => `आप पर ${amt} बाकी है · सीमा पार`,
  home_owe: (amt) => `आप पर ${amt} बाकी है — चुकाने के लिए नकद जमा करें।`,
  duty_label: "Ride91 ड्यूटी",
  on_duty_for: (dur) => `ड्यूटी पर · ${dur}`,
  end_duty: "ड्यूटी ख़त्म करें",
  start_duty: "ड्यूटी शुरू करें",
  online_on: "इन ऐप पर ऑनलाइन",
  start_duty_to_enable: "  · चालू करने के लिए ड्यूटी शुरू करें",
  on: "चालू",
  off: "बंद",
  not_online: "किसी भी ऐप पर ऑनलाइन नहीं",
  shift: "शिफ़्ट",

  // ---- Earnings ----
  earnings: "कमाई",
  settled: "पक्का",
  pending: "बाकी",
  period_yesterday: "कल",
  period_week: "इस हफ़्ते",
  period_month: "इस महीने",
  earn_sub: (label, pct, gross) => `${label} · कुल ${gross} किराये में से आपका ${pct}%`,
  earn_days: (n) => ` · ${n} दिन`,
  yesterdays_cash: "कल का नकद",
  platform_cash: (name) => `${name} नकद`,
  cash_collected: "नकद लिया",
  deposited: "जमा किया",
  cash_to_settle: "कल का बाकी नकद",
  your_balance: "आपका हिसाब",
  in_credit: "आपका जमा",
  you_owe: "आप पर बाकी",
  over_limit_deposit: (limit) => `₹${limit} से ज़्यादा — अभी जमा करें`,
  pay_dues: (amt) => `₹${amt} बकाया UPI / कार्ड से चुकाएँ`,

  // ---- Collection QR ----
  collect_payment: "पेमेंट लें",
  qr_not_setup: "अभी चालू नहीं है — ऑफ़िस से अपना QR चालू करवाएँ।",
  qr_not_ready: "आपका QR अभी तैयार नहीं है। रीफ़्रेश के लिए नीचे खींचें।",
  show_to_rider: "UPI से भुगतान के लिए सवारी को यह दिखाएँ",
  tap_enlarge: "बड़ा करने के लिए दबाएँ",
  received: (amt) => `✓ ${amt} मिले`,
  collected_today: "आज मिला",
  pays: (n) => `${n} पेमेंट`,
  no_payments_today: "आज अभी कोई पेमेंट नहीं — सवारी के भुगतान करते ही यहाँ दिखेगा।",
  tap_close: "बंद करने के लिए कहीं भी दबाएँ",

  // ---- Payouts ----
  payouts: "भुगतान",
  payouts_sub: "फ़्लीट से आपके बैंक में भेजा गया पैसा। ऑफ़िस के भेजते ही यहाँ दिखेगा। पहले प्रोफ़ाइल में अपना बैंक / UPI जोड़ें।",
  payouts_error: "भुगतान लोड नहीं हुए। रीफ़्रेश के लिए नीचे खींचें।",
  no_payouts: "अभी कोई भुगतान नहीं।",
  payout_status: {
    processed: "भुगतान हुआ",
    processing: "प्रक्रिया में",
    queued: "कतार में",
    pending: "बाकी",
    reversed: "वापस हुआ",
    failed: "असफल",
    cancelled: "रद्द",
    rejected: "अस्वीकृत",
  },

  // ---- Rewards: this week ----
  this_week: "इस हफ़्ते 🏆",
  on_top_30: "आपके 30% के ऊपर",
  days_operated: "गाड़ी कितने दिन चली",
  loading: "लोड हो रहा है…",
  tier_daily: "दिन की टॉप गाड़ी",
  tier_car_week: "हफ़्ते की टॉप गाड़ी",
  tier_driver_week: "हफ़्ते का टॉप ड्राइवर",
  note_daily: "कल की कमाई",
  note_car_week: (n) => `इस हफ़्ते · सभी ${n} दिन ज़रूरी`,
  note_driver_week: "इस हफ़्ते आपकी कमाई",

  // ---- Rewards: loyalty wallet ----
  wallet_title: "लॉयल्टी वॉलेट 💰",
  wallet_hint: "हर ड्यूटी वाले दिन बढ़ता है",
  wallet_from_days: (amt, days) => `${days} दिनों से ${amt}`,
  wallet_milestones: (amt) => ` + ${amt} माइलस्टोन`,
  wallet_paid: (amt) => ` · ${amt} मिल चुके`,
  wallet_note: "कमाई के माइलस्टोन का बोनस भी यहीं आता है। ऑफ़िस देता है — साथ बने रहने पर आपका है, छोड़ने पर चला जाता है।",

  // ---- Rewards: how to win ----
  how_to_win: "कैसे जीतें",
  tip_all_days: "• गाड़ी पूरे 7 दिन चलाएँ।",
  tip_safe: "• टॉप ड्राइवर के लिए सुरक्षित ड्राइविंग और अच्छी सेवा गिनी जाती है।",
  tip_on_top: "इनाम आपकी 30% कमाई के ऊपर मिलते हैं।",

  // ---- Attendance ----
  att_title: "हाज़िरी बोनस 📅",
  att_month: monthLabel(MONTHS_HI),
  att_counted_days: "गिने गए दिन",
  att_bonus: "बोनस",
  att_paid: "इस महीने का बोनस मिल चुका है।",
  att_qualified: "आप बोनस के हक़दार हो गए हैं। महीना ख़त्म होने पर ऑफ़िस बोनस देगा।",
  att_out_of_reach: (need, left) =>
    `इस महीने अब नहीं हो पाएगा: ${need} दिन और चाहिए, पर सिर्फ़ ${left} दिन बचे हैं। अगले महीने नई गिनती शुरू होगी।`,
  att_need: (need) => `${need} दिन और चाहिए`,
  att_left: (left) => ` · इस महीने ${left} दिन बचे हैं`,
  att_days_done_gross: (amt) => `दिन पूरे हो गए। बोनस के लिए इस महीने ${amt} और कमाएँ।`,
  att_days_done: "दिन पूरे हो गए।",
  att_day_counts: "दिन तब गिना जाएगा जब आप",
  att_rule_earn: (amt) => `उस दिन ${amt} या उससे ज़्यादा किराया कमाएँ`,
  att_rule_no_shift: "समय पर ड्यूटी शुरू करें। आपके हब ने अभी आपका शिफ़्ट समय तय नहीं किया है। हब से तय करवाएँ, वरना आपके दिन नहीं गिने जा सकते।",
  att_rule_start_by: (cutoff, shift, grace) =>
    `${cutoff} तक ड्यूटी शुरू करें` + (grace > 0 ? ` (आपकी ${shift} की शिफ़्ट + ${grace} मिनट)` : " (आपका शिफ़्ट समय)"),
  att_rule_on_time: (grace) => `समय पर ड्यूटी शुरू करें${grace > 0 ? ` (शिफ़्ट के ${grace} मिनट के अंदर)` : ""}`,
  att_to_get_bonus: "बोनस पाने के लिए",
  att_rule_days: (n) => `इस महीने ${n} गिने गए दिन पूरे करें`,
  att_rule_month_gross: (min, at) => `इस महीने ${min} किराया कमाएँ (अभी ${at})`,
  att_note: "कल का दिन तब जुड़ता है जब ऑफ़िस आपकी कमाई दर्ज करता है। बोनस आपके हिस्से के ऊपर है और ऑफ़िस देता है।",

  // ---- Loyalty milestones ----
  loy_title: "लॉयल्टी माइलस्टोन 🎖️",
  loy_tenure: (days) => {
    if (days < 60) return `${days} दिन`;
    if (days < 365) return `${Math.floor(days / 30)} महीने`;
    const y = Math.floor(days / 365);
    const mo = Math.floor((days % 365) / 30);
    return mo ? `${y} साल ${mo} महीने` : `${y} साल`;
  },
  loy_with_ride91: (tenure) => `Ride91 के साथ ${tenure}`,
  loy_total_earned: "कुल कमाई",
  loy_bonus_unlocked: "मिला हुआ बोनस",
  loy_reached: (done, total) => `${total} में से ${done} माइलस्टोन पूरे`,
  loy_none: "अभी कोई माइलस्टोन तय नहीं है।",
  loy_label: (_label, amount) => `${amount} की कमाई`,
  loy_unlocked: "मिल गया · आपके वॉलेट में जुड़ा",
  loy_lost: "पूरा हुआ, पर छोड़ने से चला गया",
  loy_to_go: (amt) => `${amt} और बाकी`,
  loy_unlocks_at: (amt) => `${amt} की कमाई पर मिलेगा`,
  loy_all_done: "आपने सभी माइलस्टोन पूरे कर लिए। धन्यवाद!",
  loy_note: "बोनस आपके लॉयल्टी वॉलेट में आता है और ऑफ़िस देता है। माइलस्टोन तभी मिलते हैं जब आप काम पर बने रहें।",

  // ---- Profile: vehicle ----
  vehicle: "गाड़ी",
  veh_number: "नंबर",
  veh_model: "मॉडल",
  veh_battery: "बैटरी",
  home_hub: "होम हब",
  hub_not_set: "हब तय नहीं है",

  // ---- Profile: shift alarm ----
  shift_alarm: "शिफ़्ट अलार्म",
  alarm_ready: "अलार्म तैयार",
  alarm_preview_only: "सिर्फ़ प्रीव्यू",
  alarm_sub: "शिफ़्ट शुरू होने से 1 घंटा पहले आपका फ़ोन जगाता है, और फिर तब जब हब लौटने का समय हो।",
  set_by_hub: "आपके हब ने तय किया",
  start_alarm: "शिफ़्ट शुरू का अलार्म",
  next_shift: "अगली शिफ़्ट",
  not_scheduled: "तय नहीं है",
  fires_at: "अलार्म बजेगा",
  alarm_state: (state) => ALARM_STATE_HI[state] ?? state,
  end_alarm: "हब वापसी का अलार्म",
  shift_ends: "शिफ़्ट ख़त्म",
  distance_to_hub: "हब तक दूरी",
  eta: "पहुँचने में समय",
  eta_min: (min) => `${min} मिनट`,
  eta_avg: (kmph) => `  ·  औसत ${kmph} km/h`,
  alarm_at: "अलार्म बजेगा",
  fire_window: "🟠 अलार्म का समय हो गया",
  set_home_hub: "हब वापसी का अलार्म चालू करने के लिए होम हब तय करवाएँ।",
  hub_sets_time: "आपके जागने का समय हब तय करता है। अलार्म अपने आप लग जाता है — बदलने के लिए अपने हब से बात करें।",
  schedule_shift: "शिफ़्ट तय करें",
  alarm_scheduled: "अलार्म लग गया",
  alarm_not_scheduled: "अलार्म नहीं लगा — फिर कोशिश करें",
  when_next_shift: "आपकी अगली शिफ़्ट कब है?",
  how_long_shift: "आपकी शिफ़्ट कितनी लंबी है?",
  starts_at: (when) => `शुरू: ${when}`,
  ends_at: (when) => `ख़त्म: ${when}`,
  shift_presets: ["2 घंटे में (दिन)", "5 घंटे में (दिन)", "कल सुबह 6 बजे", "आज रात 10 बजे (रात)"],
  duration_hours: (h) => `${h} घंटे`,
  no_end_alarm: "वापसी का अलार्म नहीं",

  // ---- Profile: documents ----
  documents: "दस्तावेज़",
  docs_attention: (n) => `${n} पर ध्यान दें`,
  docs_all_valid: "सब सही हैं",
  doc_status: { expired: "समाप्त", expiring_soon: "30 दिन में रिन्यू करें", ok: "सही", missing: "नहीं है" },
  doc_label: (type, label) => DOC_HI[type] ?? label,
  doc_expires: (date) => `${date} को समाप्त`,
  doc_no_expiry: "समाप्ति तारीख़ दर्ज नहीं",
  doc_fallback: "दस्तावेज़",
  doc_number: "दस्तावेज़ नंबर",
  doc_expiry_field: "समाप्ति तारीख़ (YYYY-MM-DD)",
  doc_image_chosen: "फ़ोटो चुन ली · बदलने के लिए दबाएँ",
  doc_attach: "दस्तावेज़ की फ़ोटो जोड़ें",
  doc_perm_title: "फ़ोटो की अनुमति चाहिए",
  doc_perm_body: "दस्तावेज़ की फ़ोटो अपलोड करने के लिए फ़ोटो गैलरी की अनुमति दें।",
  doc_expiry_bad: "समाप्ति तारीख़ YYYY-MM-DD में लिखें",

  // ---- Profile: payout destination ----
  bank_title: "भुगतान कहाँ भेजें",
  bank_verified: "जाँच पूरी",
  bank_pending: "जाँच बाकी",
  bank_sub: "Ride91 आपका सोमवार का भुगतान यहाँ भेजता है। बैंक ट्रांसफ़र (IMPS) या UPI — जो आप चुनें।",
  bank_type: "प्रकार",
  bank_kind_bank: "बैंक खाता (IMPS)",
  bank_kind_upi: "UPI (VPA)",
  bank_holder: "खाताधारक",
  bank_account: "खाता",
  bank_upi_id: "UPI ID",
  bank_none: "अभी कोई बैंक / UPI नहीं जोड़ा गया।",
  bank_update: "जानकारी बदलें",
  bank_add: "बैंक / UPI जोड़ें",
  bank_tab_bank: "बैंक (IMPS)",
  bank_holder_name: "खाताधारक का नाम",
  bank_holder_ph: "जैसा पासबुक में है",
  bank_acc_number: "खाता नंबर",
  bank_acc_ph: "6–26 अंक",
  bank_acc_confirm: "खाता नंबर दोबारा लिखें",
  bank_acc_confirm_ph: "दोबारा लिखें",
  bank_upi_field: "UPI ID (VPA)",
  bank_upi_help: "आपके UPI भुगतान यहाँ आएँगे। पैसा कुछ ही मिनटों में पहुँच जाता है।",
  bank_err_holder: "खाताधारक का नाम लिखें।",
  bank_err_acc: "खाता नंबर 6–26 अंकों का होना चाहिए।",
  bank_err_match: "दोनों खाता नंबर मेल नहीं खाते।",
  bank_err_ifsc: "IFSC ग़लत लग रहा है (जैसे HDFC0001234)।",
  bank_err_upi: "सही UPI ID लिखें (जैसे name@upi)।",
  bank_check: "जानकारी जाँचें",
  bank_save_failed: "सहेजा नहीं जा सका",
  bank_bad_ifsc: "IFSC ग़लत लग रहा है। दोबारा जाँचें।",
  bank_bad_upi: "यह UPI ID ग़लत लग रही है।",

  // ---- Profile: consents ----
  consents: "सहमतियाँ",
  consents_sub: "आप कोई भी सहमति कभी भी वापस ले सकते हैं। हर बदलाव का पूरा रिकॉर्ड रखा जाता है।",
  consent_label: (kind, label) => CONSENT_HI[kind] ?? label,
  consent_changed: (granted, date) => `${date} को ${granted ? "दी गई" : "वापस ली गई"}`,
  consent_undecided: "अभी तय नहीं किया",
  consent_withdraw_q: "सहमति वापस लें?",
  consent_withdraw_body: (label) =>
    `आप यह सहमति वापस ले रहे हैं: ${label}। इस पर चलने वाली कुछ सुविधाएँ तब तक बंद रहेंगी जब तक आप दोबारा सहमति नहीं देते।`,
  consent_withdraw: "वापस लें",
};

/** Card copy in the driver's language — Hindi when selected, English otherwise. */
export const useCardText = (): CardText => {
  const { lang } = useI18n();
  return lang === "hi" ? hi : en;
};
