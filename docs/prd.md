# Ride91 — Product requirements

Last updated: 2026-11-10 (commit after `0db37f1`). Replaces the old `memory/PRD.md` (17 Sep), which described only the first driver app.

## What Ride91 is

Ride91 runs a fleet of company-owned electric cars (Citroën ëC3) in Indian cities (Ahmedabad and Pune so far). Drivers are employees. They drive the fleet's cars on Uber, Rapido and Ola, and on Ride91's own bookings. Riders often pay cash, so each driver holds cash that belongs to the company until it is deposited.

Three people use the system:

| Who | Uses | What for |
|---|---|---|
| Driver | Driver app (Android) | Start and end duty, say which platform they are on, see earnings and salary, deposit cash, withdraw salary, see rewards, answer shift alarms, upload documents |
| Hub manager | Hub app (Android) | Run one hub day to day: who is driving, who is late, cars, handovers, typed-in earnings, cash received, salary withdrawals, messages |
| Office (manager, owner) | Admin panel (web) | Everything across all hubs: drivers, cars, hubs, money, payouts, rewards, settings, users, audit |

## Driver app (`frontend/app`, package `com.ride91.driver`)

Signed in with phone number and a password the hub sets. Stays signed in for 30 days, and stays signed in without signal (only a 401/403 from the server signs out).

Tabs:
1. **Home** — map, duty status, Start/End duty, platform switcher (Uber, Rapido, Ola, Ride91, not online, to charger, charging), the day's duty stripe, distance today, battery, shift alarm card, attendance card.
2. **Money** — today's earnings by platform, the driver's share, cash held against the cash limit (₹1,500 default), deposit cash by Razorpay QR or payment link, salary balance and withdrawal to bank/UPI, weekly chart, **Payment history** (lifetime totals and month by month).
3. **Rewards** — weekly and daily reward targets, "Who is winning" (top 3 drivers and top 3 cars of the week), loyalty milestones, loyalty wallet, attendance bonus progress.
4. **Profile** — driver and car details, documents (licence etc.) with expiry, consents, bank account, change password, language (English, Hindi; Kannada for the core screens), sign out.

Other screens: requests (advance, holiday, extra hours), notifications, daily inspection, shift alarm, payment history.

Must work offline: every action is queued on the phone and sent when the network is back; the server ignores repeats (`client_action_id`).

## Hub app (`frontend/hub-app`, package `com.ride91.hub`)

For roles hub_manager and above; a hub manager sees only their own hub. Viewers are refused.

Tabs:
1. **Today** — who is on duty, not started, late, not coming, no answer to the alarm; tracking stopped; attention list first.
2. **Drivers** — search by name, phone or plate; add a driver (one step, with shift start time and car); driver page with duty, money, messages; remove (archive) or delete for good (manager+ only, only if no money history).
3. **Cars** — battery and how old the reading is, who drives it, open damage; car page with drivers, give to / remove from a driver, handovers with photos and odometer, damage "mark repaired", service log, car checks.
4. **Money** — cash received from drivers (undo within 48 h), QR collections, salary withdrawals to pay or reject, typed-in earnings (Uber cash may exceed fares because Uber collects old dues; hub managers can change the last 7 days only).
5. **Inbox** — messages and requests from drivers; broadcast to the hub.

Settings: removed drivers and removed cars (bring back), shift times, language.

## Admin panel (`admin/`, Vite + React)

Pages: Drivers, Vehicles, Hubs, Bookings, Messages, Cash, Collections, Rewards, Loyalty, Daily earnings, Requests, Live map, Review (go-online captures, documents, inspections), Shift alarms, Payouts, Audit log, Settings, Users (owner only). Owners also see the database storage card (warns from 70% full).

## Money, in one paragraph

Earnings are entered per driver per platform per business day (typed by hubs or imported from the Uber payments CSV). The driver's share (30% default) of settled earnings before today, minus payouts and pending withdrawals, is their salary balance. Cash collected on rides is owed to the company; it is cleared only by trusted deposits (Razorpay, a manual entry by the office, a hub QR collection). Salary withdrawals go straight to the bank through RazorpayX when direct withdrawal is on, otherwise the hub pays. Full rules: [rules.md](rules.md).

## Not in scope now

- iOS, public app stores for drivers (APKs are installed by hand; a Play bundle is built too).
- Rider-facing app.
- Real vehicle trackers (`/vehicles/pings/ingest` is a stub; phone GPS is used).
