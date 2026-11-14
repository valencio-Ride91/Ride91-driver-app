# Ride91 — Rules

Last updated: 2026-11-10. Two parts: the business rules the code enforces, and the working rules for changing and running the system.

Most numbers below are defaults that the owner can change in admin Settings (`SETTINGS_DEFAULTS` in `backend/server.py`).

---

## Part 1 — Business rules

### Business day
- A business day runs **04:00 to 03:59 IST**. Earnings, duty, attendance and rewards are all counted by business day.
- "Today" never counts toward salary or cash owed until it is over: balances use settled days **before** today.

### Roles
| Role | Rank | Can |
|---|---|---|
| viewer | 0 | Read the admin panel. Cannot use the Hub app. |
| hub_manager | 1 | Run **their own hub** only, in the Hub app and admin panel. |
| manager | 2 | Change anything across hubs; delete a driver for good. |
| owner | 3 | Everything, plus users, settings, secrets and database storage. |

- A hub manager may change typed-in earnings for the **last 7 days** only (today and the 6 days before).
- A hub manager may undo a cash entry of their hub within **48 hours**.
- Deleting a driver for good needs manager or owner, and is refused if the driver has any money history (earnings, deposits, withdrawals, payouts, reward payouts). Otherwise remove (archive) them.

### Duty and time
- `duty_states` is **append-only**. The current state is the latest row. Corrections are new rows.
- Each tap keeps the time the phone gave it, so taps queued offline stay in order. A time in the future (more than 2 minutes ahead) is replaced by the server's time; a time with no zone is read as UTC; text that is not a time is refused (400).
- **On time**: from business date 2026-11-10, if a Start duty reached the server more than **5 minutes** after the time it claims, its arrival time counts for lateness (stops setting the phone clock back). Earlier days are judged as before.
- Grace for "on time" is **30 minutes** after the driver's own shift start.

### Money
- **Driver share**: 30% of gross earnings.
- **Salary balance** = share of settled earnings before today − payouts − pending withdrawals.
- **Cash owed** = cash collected on settled days before today − trusted deposits. Trusted deposit sources are only `razorpay`, `admin_manual` and `qr_collection`; anything a driver reports alone does not clear cash.
- **Cash limit**: ₹1,500 held; above it the driver is flagged.
- **Cash collected must not exceed fares**, except on **Uber**, where Uber makes drivers collect past dues.
- **Withdrawals**: minimum ₹100. Salary equal to cash still owed is held back. With direct withdrawal on, up to ₹10,000 a day goes straight to the bank through RazorpayX; above that, or with it off, the hub pays.
- Payouts in `failed`, `reversed`, `cancelled` or `rejected` do not count as paid.

### Rewards and bonuses
- Top car of the day: ₹300, if the car made at least ₹4,000.
- Top car of the week: ₹1,000, at least ₹28,000 gross in the week (the car's day and night drivers together). The number of days the car ran is not a condition.
- Top driver of the week: ₹1,000, at least ₹17,500 driver earnings in the week.
- Yearly, per hub: top driver ₹50,000, top car ₹40,000.
- Loyalty milestones: ₹2,000 / ₹4,000 / ₹8,000 / ₹15,000 at ₹1 / 3 / 6 / 12 lakh earned.
- Loyalty wallet: ₹25 per day with at least ₹1,500 gross, from 2026-10-01; forfeited if the driver leaves.
- Attendance bonus: ₹3,000 for a month with 27 "good days" (on time and at least ₹2,500 gross).
- Referrals: the office records who referred a new driver when adding them. On every day the referred driver's final fares (all apps) reach ₹2,500 or more, the referrer earns 2% of that day's fares, for as long as both stay with Ride91 (it stops from the day either is removed). Each month is locked and added to the referrer's salary from the 6th of the next month; days whose fares arrive after that are paid with the next month. The driver sees only the bonus, never the friend's fares. Only the owner can change a referrer later; a change counts from that day and is never backdated. Rate, minimum, pay day and an on/off switch are in admin Settings.

### Cars and handovers
- One driver per shift slot per car; giving a car to a driver whose slot is taken needs `replace`.
- A retired car or an archived driver cannot be assigned.
- A hub has a car capacity; adding or restoring a car checks it.
- Handover photos are shrunk to 1024 px JPEG and deleted after **45 days**.
- An odometer jump over **1,500 km** must be confirmed.

### Security
- A password reset or a change of password signs the person out everywhere else.
- Drivers are signed out only when the server says so (401/403), never because the phone is offline.
- Webhooks are accepted only with a valid signature.
- Secrets (Razorpay, RazorpayX, WhatsApp keys) are set by the owner in admin Settings or in Secret Manager, and the API never returns them.

---

## Part 2 — Working rules

### Production data and money
1. **Never permanently delete production data from a development session.** Clean-up scripts (`backend/scripts/purge_inspection_media.py`, `purge_test_data.py`) are dry runs by default; the owner reads the dry run and runs `--apply` themselves.
2. **Never move money** from a development session (no payouts, no refunds, no test payments on production).
3. Never type passwords, tokens or keys into production, and never paste them into chat. Secrets go into admin Settings or Secret Manager, entered by the owner.
4. Do not read the `MONGO_URL` secret. Redact Mongo URLs and tokens from any output.
5. Test logins and test payments are used only on local test servers (localhost) with made-up accounts.

### The repo is public
6. Commit nothing secret: no keys, passwords, connection strings, signing keys or Maps keys. The signing key and its password live outside the repo.
7. No real driver names, phone numbers or payment ids in docs or commits.
8. Check `git status` and add files by name; never commit a deletion you did not mean.

### Deploying
9. Deploy from Cloud Shell, in the clone `~/Ride91-driver-app`, to the production project only (never the old `ride91-509114` project).
10. Order: commit and push → deploy → check the logs for errors and 5xx → then hand out new app builds.
11. A server change must keep working with the apps already on drivers' phones (old app versions stay in use for days).
12. Changes to rules that affect pay (like the on-time rule) take effect from a stated business date, so days already counted do not change.

### Changing code
13. Test against an in-memory Mongo (`mongomock-motor`) before committing; never against production.
14. A new driver-app screen must be added to `isAuthedRoute` in `frontend/app/_layout.tsx`, or the app sends the driver back to Home.
15. Every user-facing string goes in the text files in English **and** Hindi (`frontend/src/i18n`, `frontend/src/hub/text.ts`). Kannada covers the driver app's core screens only; missing Kannada text falls back to English.
16. Every driver action sent to the server carries a `client_action_id`, and the server must store it once only.
17. Bump `versionCode` for every APK handed out.
