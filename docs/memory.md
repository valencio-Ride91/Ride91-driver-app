# Ride91 — Decisions and lessons

Last updated: 2026-11-10. Why things are the way they are. Newest first within each section. Add an entry when a decision is made, with the date and commit.

## Decisions

| Date | Decision | Why | Commit |
|---|---|---|---|
| 2026-11-14 | Driver referrals: 2% of a referred driver's final fares on every ₹2,500+ day, for as long as both stay; recorded by the office only; changed by the owner only, from that day; paid into salary from the 6th of the next month by a lazy monthly lock (`referral_months`, one row per referrer per month with the exact days paid). The referrer sees only the bonus. | Bring in new drivers. The lock needs no scheduler and can't pay a day twice; waiting until the 6th lets late Uber reports and hub corrections land first. | see git log |
| 2026-11-13 | Day-by-day calendar for drivers and hub managers. A day is "covered" when its cash fares are matched by QR payments and cash handed in **that day**; "cash kept" otherwise; "fares not in yet" until every app's fares for the day are settled (today is always this). The end-of-day balance uses the balance rule, so today's figure equals the Money tab. The calendar and payment history start on the onboarding day (`joined_at`, else `created_at`), or an earlier record if one exists, so no money is hidden. | Drivers and hubs could not see QR money against each day's work. | see git log |
| 2026-11-10 | Top car of the week needs only ₹28,000 weekly gross; the "all 7 days" condition is removed (server, apps, admin Settings). | The owner's rule: the gross is the only qualifier. | see git log |
| 2026-11-10 | On-time is judged by when Start duty **reached the server** if it arrived more than 5 min late, from business date 2026-11-10 only. Taps keep their own time. | Drivers could set the phone clock back to look on time. Restamping the taps themselves put offline queues out of order, so only the on-time check uses arrival. Past days were not re-judged. | `0db37f1` |
| 2026-11-10 | Drivers are signed out only on 401/403. The profile is cached on the phone. | A driver who opened the app with no signal was signed out and could not work. | `0db37f1` |
| 2026-11-10 | Queued taps are kept through network errors and server errors; dropped only after 3 refusals (4xx) or 72 h of server errors. | Taps were being dropped on the first error, losing duty starts. One bad tap must not block the queue for ever either. | `0db37f1` |
| 2026-11-10 | Old inspection media is cleaned by a script the **owner** runs (dry run first). | Photos/videos filled the 512 MB database. Deleting production data is the owner's call. | `0db37f1` |
| 2026-11-09 | Only a manager or owner can delete a driver for good, and only with no money history. Hub managers remove (archive). | Deleting a driver with money history would break balances and audits. | `2cf3b44`, `a5cb9fe` |
| 2026-11-09 | Hub managers may change earnings for the last 7 days only; edits keep the old values in the audit. | Stop late changes to weeks already paid. | `ff51611` |
| 2026-11-09 | Uber cash collected may exceed the day's fares. | Uber has drivers collect a rider's past dues. | `32e103e` |
| 2026-11-09 | Handover photos are stored shrunk (1024 px JPEG) and expire after 45 days. | Database space. | `ff51611` |
| 2026-11-09 | Rewards tab shows the top 3 drivers and top 3 cars of the week in the driver's hub. | Drivers should see who is winning. | `b7faddd` |
| 2026-11-08 | WhatsApp messages are sent in the background, through Meta or Kapso, with retries. | Sending held up requests; Kapso is a fallback. | `229dda6`, `c498649` |
| 2026-11-03 | The pre-duty photo and video inspection is switched off. | Its media (2–10 MB each) filled the database and caused the 30–31 Oct outage. | `84372a7` |
| 2026-10-08 | "Today" everywhere follows the 04:00 IST business day. | Night shifts belong to the day they started. | `0623827` |
| 2026-10-03 | Retention: loyalty wallet, earnings-based loyalty milestones, attendance and monthly bonus. Attendance default 27 days. | Keep drivers; the numbers are live settings. | `200abd6`, `8f43f14`, `01055dd`, `a3dc1f5` |
| 2026-10-03 | Hubs own cars, cash, rewards, requests, alarms and payouts; hub managers see only their hub. | Each hub runs its own day. | `ce8724d`, `0a35bcf` |
| 2026-10-02 | Razorpay and RazorpayX keys are set in admin Settings, not only env vars. | Rotate keys without a redeploy. | `f4003df`, `e1e897a` |
| 2026-09-22 | A driver may be online on Uber, Rapido and Ola at the same time. | That is how drivers actually work. | `43b0ba8` |
| 2026-09-22 | Reward thresholds live in Settings. | Change them without a redeploy. | `c80933f` |
| 2026-09-20 | Drivers sign in with phone + a password the office sets (OTP removed). | No SMS provider; office controls access. | `9710209` |
| 2026-09 | MongoDB instead of PostgreSQL; `duty_states` append-only. | Owner's choice; append-only keeps a full record and makes corrections visible. | — |
| 2026-09-19 | Moved off the Emergent platform to Google Cloud Run (asia-south1) and Atlas M0. | Free at low traffic, close to drivers, no platform lock-in. | `0e91b00`, `29da21a` |

## Incidents

- **30–31 Oct 2026, database full.** Atlas M0 hit 512 MB, mostly inspection photos and videos (about 140 MB saved 15 Oct–3 Nov; uploads near 12 MB were refused). Writes failed for about 31 hours; Razorpay webhooks got 500/503, so some QR payments in that window may be missing. Actions: inspection media off (`84372a7`), server starts even if the database refuses writes, storage card (`0db37f1`), clean-up script. Still open: replay missed payments, webhook dedup fix (see [task.md](task.md)).

## Lessons

- Anything that grows per driver per day (photos, video, pings) needs an expiry or a size cap before it ships. M0 is only 512 MB.
- Phones are offline often. Never sign out, drop a queued action, or trust the phone's clock for pay without thinking about the queue.
- Changing a pay rule must not change days already counted: give it a start date.
- A webhook must answer an error (so it is retried) when it could not record the payment. Answering 200 on failure loses money silently.
- New driver-app screens must be added to the signed-in route list in `app/_layout.tsx`.
- Old app versions stay on phones for days; the server must keep working with them.
