# Driver referrals — design

Date: 2026-11-14. Status: agreed with the owner in conversation; waiting for the owner to approve this write-up.

## Why

Ride91 needs more drivers. Drivers who bring in a friend should get a share of that friend's good days, for as long as both keep driving for Ride91. That gives every driver a lasting reason to recruit.

## The rule (owner's decisions)

- When the office adds a new driver, it can record which existing driver **referred** them. Referrals are recorded **only by the office**; there is no "refer a friend" button in the driver app.
- On any business day when the referred driver's **final** fares across all apps reach **₹2,500**, the referrer earns **2% of that day's whole fares**. Example: a ₹3,000 day earns ₹60; a ₹2,400 day earns nothing.
- It pays **for as long as both drivers stay with Ride91**. It stops from the day either one is removed.
- ₹2,500, 2% and an on/off switch are **admin Settings** (owner-editable, no update needed).
- A driver has **one referrer** at a time and cannot refer themselves.
- The referrer can be set or changed on an existing driver later, **by the owner only**. A change counts from the day it is made and is never backdated. Managers and hub managers can't change it.
- Earned **daily**, shown daily as "Referral earnings", **paid after the 5th of the next month**. From the 6th (`referral_pay_day`, a setting, default 6), the month's total is added to the salary the referrer can withdraw, and it counts under "Bonus won" for that month. The wait lets late fares (Uber reports, hub corrections) come in first.
- The referrer is shown **only the bonus amount**, never the friend's fares (owner, 2026-11-14).
- If a hub corrects a day's fares, that day is worked out again until its month is paid.

## Goals

- The office can record a referral when adding a driver, and a manager or owner can change it later.
- Drivers see their referral earnings day by day and the month's total in the driver app.
- Each month's referral earnings are added to the salary exactly once, with nothing run on a schedule.
- The admin panel lists every referral with this month's, lifetime and due figures. The Hub app shows who referred a driver.

## Non-goals

- No in-app referral leads, invite links or codes (the owner chose the office-only option).
- No reward for the new driver.
- No WhatsApp or push message about referral earnings (could come later).
- No referral line in the day-by-day calendar (could come later).
- No change to the salary redesign still being worked out (cash-owed block, advances, bonuses). Referral money goes into salary through the existing `_salary_state` "earned" figure.

## Anti-goals (would be a failure even if it "works")

- A month paid twice, or a paid month changing afterwards.
- Changing the referrer, the rate or the threshold changing money already paid.
- Anyone but the owner able to point referrals at a driver of their choosing after the fact.
- The friend's daily fares shown to the referrer. Only the referral amount is shown, though fares can be worked out from 2%; the owner accepted that.

## Constraints

- MongoDB Atlas M0 (512 MB): little extra data, nothing per ping or per request.
- No scheduler: Cloud Run only. The owner deploys by hand from Cloud Shell.
- Old app versions stay on phones for days, so new server fields must be additive.
- A business day runs 04:00–03:59 IST (`business_date_now()`). A day is **final** for a driver when they have `platform_cash` rows for it and all of them are `settled`; this matches the calendar's "fares not in yet" rule.
- Fares for a day are `gross_amount`, falling back to `cash_amount`, summed over all platforms, as everywhere else.

## Approaches considered

| | How | Trade-off |
|---|---|---|
| **A (chosen)** | Work out referral earnings from fares whenever they are shown. The first time anything reads a finished month, lock it with one record per referrer per month that adds to salary. | No scheduler and very few writes, and hub corrections show at once. A correction made after the lock isn't included (late days are handled below). |
| B | Write a referral record every time fares are entered, edited, imported or undone. | Many write paths, so missing one gives silent wrong money; more writes. |
| C | A Cloud Scheduler job on the 1st pays everyone. | New infrastructure the owner must set up; if it fails one month, nobody is paid. |

The owner picked **A**.

## Design

### Data

**`referrals` collection**: one row per referral link, kept for ever.

```
{ id, referred_id, referrer_id,
  from_bd,            # first business date that counts (YYYY-MM-DD)
  to_bd: null|str,    # first business date that no longer counts (set when the link is changed)
  created_at, created_by, ended_at?, ended_by? }
```
- At most one open row (`to_bd: null`) per `referred_id`; enforce with a unique partial index or a check in code.
- At driver creation `from_bd` is the business date of creation.
- Setting a referrer on an existing driver uses today's business date. Changing one closes the old row (`to_bd = today`) and opens a new one from today. Removing a referrer closes the row.

**`referral_months` collection**: the monthly lock, one row per referrer per month.
```
{ id, driver_id (referrer), month: "YYYY-MM",
  amount, rate, daily_min,
  days: [ { referred_id, date, fares, amount } ],   # exactly which days were paid
  created_at }
```
- Unique on `(driver_id, month)` so it cannot be written twice. On a duplicate-key race, re-read and return the existing row.
- `days` records each referred-driver day paid, so a day is never paid twice across months.
- This is its own collection, not `reward_payouts`. Zero-amount months are written here as well, and `reward_payouts` is a "has money history" signal for hard delete (server.py ~line 4070). A ₹0 lock must not block deleting a driver.

**Hard delete** (`DELETE /admin/drivers/{id}?hard=1`): refuse with `has_financial_history` when the driver is the referrer on a `referral_months` row with amount > 0, or a `referred_id` inside one. Otherwise delete their `referrals` rows and zero `referral_months` rows with them.

**Settings** (in `SETTINGS_DEFAULTS`, `SettingsIn`, admin Settings page):
- `referral_enabled`: True
- `referral_rate`: 0.02 (0–1)
- `referral_daily_min`: 2500 (₹, ≥ 0; a day of ₹2,500 or more counts)
- `referral_pay_day`: 6 (1–28; a month is locked and paid from this day of the next month)

### Which days count

A day `d` of referred driver `F` earns for referrer `R` when all of these hold:
1. A `referrals` row links `F` to `R` with `from_bd ≤ d` and (`to_bd` is null or `d < to_bd`).
2. `d` is before today and is final for `F`.
3. `F`'s fares for `d` are at least `referral_daily_min`.
4. Neither `F` nor `R` was removed on or before `d`. Use the current `archived_at` business date: days on or after it don't count. (Builder's call: a restore clears `archived_at`, so after a restore the gap simply counts again. The referred driver has no fares while removed, so this only matters for the referrer.)
5. `referral_enabled` is on when the figure is worked out or locked.

Amount = `round(fares × referral_rate, 2)`.

### The monthly lock (paid "at the end of the month")

`_referral_lock(referrer)`: for every month that is due (the current business date is on or after day `referral_pay_day` of the following month, back to the referrer's first referral `from_bd`) with no `referral_months` row:
- Collect every qualifying day of that month. Also collect any **earlier** day that qualifies now but is not in any earlier lock's `days`. This catches days that became final late, such as an Uber report arriving after the 1st; they are paid in the next lock instead of being lost.
- Write the lock row, even when the amount is 0, so the month is never worked out again.

Before the pay day the month shows as "to be paid on 6 Dec". A lock runs whenever any of these is read: the driver's salary (`/money/salary`, `_salary_state`), the driver's referral screen, the admin Referrals page (which locks all referrers), or a withdrawal or payment check. It must be cheap when nothing is due, which is one indexed read for the lock row.

After a lock, corrections to that month's days are not paid. They will be rare: hubs can only edit the last 7 days and the lock waits until the 6th.

### Salary

- In `_salary_state`, run the lock first, then `earned += sum(referral_months.amount where driver_id = R)`.
- Report `referral_paid` (lifetime) as an extra field so apps can show it.
- The current month's unpaid referral earnings are **not** withdrawable.
- `_history_timed_rows` adds `referral_months` rows with amount > 0 to `rewards` ("Referral bonus — October 2026"), dated the 1st of the following month.

### API

- `POST /admin/drivers` takes an optional `referred_by` (driver id). Any role that can add a driver may set it at creation (see calls below). Refuse self-referral, an unknown or removed driver, or an inactive one.
- `PUT /admin/drivers/{id}/referrer` with `{referrer_id | null}`, **owner only** (`require_owner`). It closes the open row and opens a new one from today, and writes an audit entry.
- `GET /admin/referrals?month=`, `require_ops`. Hub managers see only links where the referrer or the referred driver is in their hub. Runs locks, then lists one row per link: referrer, referred, hub, since, this month so far, lifetime paid, and what will be paid on the 1st.
- `GET /admin/drivers/{id}` adds `referred_by: {id, name, since}` and `referrals_made: n`. The Hub driver page uses this.
- `GET /money/referrals?month=` (driver). Returns `{month, enabled, rate, daily_min, total, paid: bool, pay_date, people: [{name, since, active}], days: [{date, name, amount}]}`, defaulting to the current month. A paid month reads from its lock row. Fares are never returned.

### Driver app

- On the Money tab, a "Referral earnings" card shows **only when the driver has referred someone**. It shows this month's total, "paid on 1 Dec", and a tap opens a screen with day-by-day lines ("Ravi · +₹60"), previous months and whether each was paid. Add the screen to `isAuthedRoute` in `app/_layout.tsx`.
- English and Hindi strings (Kannada falls back to English), in a new `src/i18n/referrals.ts`.

### Hub app

- On the driver page, "Referred by Ravi (since 3 Nov)" when set. Read only.

### Admin panel

- Add driver form: a "Referred by" driver picker (searchable by name or phone, active drivers only).
- Driver detail: shows the referrer, with a Change button for the owner only.
- A new **Referrals** page (nav item) with the list described above and a month picker.
- Settings: the referral on/off switch, rate (%) and daily minimum.

## Calls I made (for the owner to check)

1. A hub manager **may** pick "Referred by" when adding a driver (that is the onboarding moment). Only the owner may change it afterwards (owner, 2026-11-14).
2. The referrer may be in **another hub**.
3. Days that become final after their month was locked (after the 5th) are paid in the **next** month's lock, not lost.
4. A change to the rate or threshold applies to every day not yet locked, including earlier days of the current month. Locked months keep their rate.
5. Turning referrals off stops display and locking. Turning them on again counts the days in between; no history of the switch is kept.
6. Referral money adds to salary even before the wider salary changes (cash-owed block, advances) are built.

## Left to the builder

Index choices, helper names, query shape, UI layout within the existing design system (`docs/design.md`), and tests. Tests run against mongomock as in `scratchpad/t/check_calendar.py`; they must cover the threshold edge (₹2,499.99 / ₹2,500), self-referral, a change of referrer mid-month, removal, a late-final day, the double-lock race, and salary including locked months only.
