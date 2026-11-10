# Ride91 — Tasks

Last updated: 2026-11-10, after commit `0db37f1`. Tick items off here as they land, with the commit.

## Now (owner)

- [ ] Deploy `ride91-api` and `ride91-admin` with commit `0db37f1`.
- [ ] Admin → Settings → **Database storage**: note how full it is and the biggest collections.
- [ ] If `inspections` / `go_online_captures` are large: run `python3 backend/scripts/purge_inspection_media.py --from-cloud-run ride91-api` (dry run), review, then add `--apply`.
- [ ] Hand out driver app **v21** (versionCode 8) and Hub app **v15** (versionCode 15).
- [ ] Check the logs after the deploy (no 5xx, no warnings).

## Decisions waiting on the owner

- [ ] **Advance requests:** approving an advance moves no money. Should it create a payable for the hub, or stay a yes/no?
- [ ] **Removing a driver who owes cash:** block it, warn, or allow? Today it is allowed, and the debt then drops out of hub Today and admin Cash.
- [ ] **Location pings:** `phone_pings` and `vehicle_pings` have no expiry (about 2,500 a day, written twice). How long to keep them?
- [ ] **Old Razorpay QR codes** (about 75, made before QR notes existed): payments to them credit no driver. Link each to a driver, or close them?
- [ ] **Withdrawal policy:** direct payouts on hub-typed earnings; whether today's cash should be held; what a change of driver share does to past days; whether every payout counts as salary.

## Open faults — money (from the cash audit, 2026-11-08)

High:
- [ ] `/webhooks/razorpay` treats any error saving its dedup marker as "already seen" and answers 200, so Razorpay stops retrying. When the database is full every QR payment is lost. Fix: only a duplicate key is a repeat; on a processing error remove the marker and answer 500.
- [ ] Payments made during the 30–31 Oct outage may not be recorded. Add an admin "sync from Razorpay" that replays each collection QR's payments (safe to repeat).
- [ ] Legacy QR codes credit nobody (see decision above).

Medium:
- [ ] Undo a cash entry, then enter the same receipt again → "receipt used".
- [ ] Earnings edit audit leaves out the cash amount and the old value (partly fixed for hub edits).

Low:
- [ ] Undo claims before insert; a double tap gives a duplicate-key "failed"; no warning when cash entered is more than owed; Razorpay refunds are not handled.

## Open faults — withdrawals (2026-11-08)

- [ ] Paid twice if RazorpayX succeeds, the reply is lost, and the hub then pays or rejects by hand.
- [ ] `/webhooks/razorpayx` has the same dedup-on-any-error fault as above.
- [ ] A failed payout leaves the withdrawal marked "paid".
- [ ] The app does not tell the driver why a withdrawal was not instant.

## RazorpayX set-up (paused by the owner)

- [x] Static outgoing IP for `ride91-api` (Cloud NAT).
- [ ] Activate RazorpayX and add funds; allow-list the static IP.
- [ ] Add the payout webhook (`/api/webhooks/razorpayx`). The dashboard showed no `payout.*` events, so API payouts may not be enabled on the account. If they stay unavailable, poll payout status from the server instead.
- [ ] Enter payout credentials in admin Settings → Test.
- [ ] Until the withdrawal faults are fixed, consider turning **direct withdrawal off**.

## Open faults — other (from the full audit, 2026-11-09)

- [ ] The Hub app requests Today twice when it opens.
- [ ] `_segments_for_day` reads every duty state a driver has ever had.
- [ ] Admin panel: signs out on any error from `/admin/me`; `JSON.parse` throws on an HTML error page; an expired session is not handled cleanly.
- [ ] Hub Inbox shows only the latest 100 messages.
- [ ] Drivers removed before commit `2cf3b44` have no hub, so they are missing from Hub → Removed drivers (only the admin panel shows them).
- [ ] `admin/src/pages/Dashboard.tsx` is not routed anywhere; remove it or route it.
- [ ] Measure Hub Today speed again after a day of use (it was p50 0.7 s, p90 1.5 s before the parallel fetch).

## Done recently

| Commit | What |
|---|---|
| `0db37f1` | Driver stays signed in offline; queued taps never lost; on-time judged by arrival from 10 Nov; database storage report; inspection media clean-up script |
| `a5cb9fe` | Drivers tab: search by phone/plate, delete driver |
| `2cf3b44` | Hub minor audit items |
| `1200a79`, `762860b` | Cars tab: remove driver from car, damage repaired, removed cars, battery age |
| `685d856` | Driver app payment history (lifetime + monthly) |
| `b7faddd` | Rewards: top 3 drivers and cars of the week |
| `32e103e` | Uber cash may exceed fares |
| `ff51611` | Hub audit fixes 1–4, 6–9 |
