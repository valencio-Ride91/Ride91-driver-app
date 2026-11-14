# Driver Referrals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A referrer earns 2% of a referred driver's final fares on every day those fares reach ₹2,500 or more. Earnings show daily (bonus only, never fares) and are added to withdrawable salary from the 6th of the next month, locked the first time anything reads a due month.

**Architecture:** All rules live in `backend/server.py`, next to the calendar block (`_day_calendar`) and the salary code (`_salary_state`).
- New collections: `referrals` (who referred whom, from/to dates) and `referral_months` (a locked monthly payment with the exact days paid).
- New endpoints serve the driver app, the Hub app and the admin panel.
- No scheduler: locks are written lazily, and a unique index makes them idempotent.

**Tech Stack:** FastAPI + Motor (MongoDB), Expo/React Native (driver app `frontend/app`, Hub app `frontend/hub-app`, shared `frontend/src`), Vite + React (admin `admin/src`).

**Spec:** `docs/superpowers/specs/2026-11-14-driver-referrals-design.md`

## Global Constraints

- Settings defaults: `referral_enabled: True`, `referral_rate: 0.02` (0–1), `referral_daily_min: 2500` (₹, ≥ 0), `referral_pay_day: 6` (1–28). Owner-editable via `PUT /admin/settings`.
- A month is **due** (locked and paid) once `business_date_now() >= f"{month_after}-{pay_day:02d}"`. Before that it shows as "to be paid on 6 Dec".
- The driver sees only bonus amounts, never the friend's fares.
- A day qualifies when fares ≥ `referral_daily_min` (₹2,500.00 qualifies; ₹2,499.99 does not). Amount = `round(fares × referral_rate, 2)`.
- Fares are `gross_amount`, falling back to `cash_amount`, summed over all platforms. A day is final when the driver has ≥ 1 `platform_cash` row for it and every row is `settled`. Only days before `business_date_now()` count.
- Business day: 04:00–03:59 IST. Use `business_date_now()`, `_bd_of`, `_month_after`.
- Never backdate: a referrer set on an existing driver counts from today's business date.
- Changing the referrer: **owner only** (`require_owner`). Setting it at creation: any role that can create a driver (`require_ops`).
- The referred driver's fares are never sent to the referrer's app.
- Old apps must keep working: new response fields are additive.
- English and Hindi strings; Kannada falls back to English.
- Tests run offline against mongomock (pattern: `scratchpad/t/check_calendar.py`, run with `PYTHONIOENCODING=utf-8` in the scratchpad venv). Never against production.
- The repo is public: commit nothing secret. Stage files explicitly (`git add <paths>`); never `git add -A`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The same month read twice at once** (driver app and admin page together): exactly one `referral_months` row, and salary counts it once.
2. **A day that becomes final after its month was locked** (an Uber report on the 2nd for the 31st): it is paid in the next lock, never twice and never lost.
3. **The referrer changed mid-month:** days before the change go to the old referrer, days from the change to the new one, with no overlap.
4. **The referrer or the referred driver removed (archived):** days on or after `archived_at` don't count, for either side.
5. **Hard delete of a driver with a ₹0 lock:** allowed. With a paid lock (as referrer or as a referred driver inside `days`): refused with `has_financial_history`.

---

## File Structure

| File | Change |
|---|---|
| `backend/server.py` | Settings keys; `referrals` / `referral_months` helpers; lock; salary + history wiring; endpoints; indexes; hard-delete rule |
| `scratchpad/t/check_referrals.py` | New offline test script (not committed; same as the existing check scripts) |
| `admin/src/api.ts` | Types and calls for referral endpoints and settings |
| `admin/src/pages/Referrals.tsx` | New page |
| `admin/src/App.tsx`, `admin/src/components/Layout.tsx` | Route and nav item |
| `admin/src/pages/Drivers.tsx` | "Referred by" picker in the Add driver form |
| `admin/src/pages/DriverDetail.tsx` | Referrer line plus Change control (manager/owner) |
| `admin/src/pages/Settings.tsx` | Referral switch, rate (%), daily minimum |
| `frontend/src/i18n/referrals.ts` | New strings (en/hi) |
| `frontend/app/referrals.tsx` | New driver screen |
| `frontend/app/(tabs)/money.tsx` | Referral card (only when the driver has referrals) |
| `frontend/app/_layout.tsx` | `referrals` in `isAuthedRoute` and as a Stack.Screen |
| `frontend/hub-app/driver/[id].tsx` | "Referred by …" line |
| `docs/task.md`, `docs/memory.md`, `docs/rules.md` | Decision, rule and done entries |

**Deviation from spec (builder's call):** the spec said to add `referred_by` to `GET /admin/drivers/{id}`. The Hub driver page doesn't call that endpoint; it loads `/duty` and `/notifications`. So both apps use one small new endpoint, `GET /admin/drivers/{id}/referral`.

---

### Task 1: Settings, data and the day rule (server)

**Files:**
- Modify: `backend/server.py`, at `SETTINGS_DEFAULTS` (~line 113), `SettingsIn` (~line 863), `admin_put_settings` (~line 2618), and the index creation (~line 10399). Place the new helpers in a new "REFERRALS" block just before `DIRECT_ACTOR`, after the calendar block.
- Test: `scratchpad/t/check_referrals.py`

**Interfaces:**
- Produces:
  - `async def _referral_days(referrer_id: str, lo: str, hi: str) -> List[Dict]`: qualifying days with `lo ≤ date < hi`. Each item is `{"referred_id", "name", "date", "fares", "amount"}`, sorted by date then name. It applies all five rules from the spec ("Which days count"). Returns `[]` when `referral_enabled` is off.
  - `async def _referral_links(referrer_id: str) -> List[Dict]`: the `referrals` rows where this driver is the referrer.
  - `async def _open_referral(referred_id: str) -> Optional[Dict]`: the row with `to_bd: None`.
- Indexes:
  - `referrals`: `(referred_id, to_bd)` and `(referrer_id)`.
  - `referral_months`: unique `(driver_id, month)`.

- [ ] **Step 1: Write the failing tests** in `check_referrals.py` (same setup header as `check_calendar.py`). Seed:
  - referrer `R` (hub H1), referred `F` (hub H2), link `from_bd = bd(10)`;
  - `F` platform_cash for these days:
    - `bd(5)`: uber 2000 + rapido 500, both settled → 2500 exactly;
    - `bd(4)`: 2499.99 settled;
    - `bd(3)`: 3000 with one row pending;
    - `bd(2)`: 4000 settled;
    - `today`: 5000 settled.

  ```python
  days = run(S._referral_days("R", bd(30), S._month_after(today[:7]) + "-01"))
  check("exact 2500 qualifies", [d["date"] for d in days] == [bd(5), bd(2)], days)
  check("2% amount", days[0]["amount"] == 50.0 and days[1]["amount"] == 80.0, days)
  check("not final -> excluded", bd(3) not in [d["date"] for d in days])
  check("today never counts", today not in [d["date"] for d in days])
  check("no fares leak in names", set(days[0]) == {"referred_id", "name", "date", "fares", "amount"})
  ```
  Also seed an archived variant:
  ```python
  # F archived from bd(3): bd(2) drops out
  check("referred removed -> stops", [d["date"] for d in run(S._referral_days("R", bd(30), today))] == [bd(5)])
  # restore F, archive R from bd(4) instead
  check("referrer removed -> stops", [d["date"] for d in run(S._referral_days("R", bd(30), today))] == [])
  # restore R; close the link at bd(3) and open R2 -> F from bd(3)
  check("change mid-month: old keeps before", [d["date"] for d in run(S._referral_days("R", bd(30), today))] == [bd(5)])
  check("change mid-month: new gets from", [d["date"] for d in run(S._referral_days("R2", bd(30), today))] == [bd(2)])
  # settings
  S._settings_cache["referral_enabled"] = False   # use the module's real settings cache name
  check("switch off -> nothing", run(S._referral_days("R2", bd(30), today)) == [])
  ```
  Keep the date seeds within one month when `today` allows, as `check_calendar.py` does; otherwise build `lo` from the earliest seeded day.
- [ ] **Step 2: Run, expect FAIL** (`AttributeError: _referral_days`).
  Run: `PYTHONIOENCODING=utf-8 "<scratchpad>/venv/Scripts/python" "<scratchpad>/t/check_referrals.py"`
- [ ] **Step 3: Implement** the settings keys (defaults, `SettingsIn` with `referral_rate: Optional[float] = Field(None, ge=0, le=1)`, `referral_daily_min: Optional[int] = Field(None, ge=0)`, `referral_enabled: Optional[bool]`, and saving in `admin_put_settings`), the indexes, and the three helpers. Approach for `_referral_days`:
  - one `platform_cash` aggregate grouped by `(driver_id, business_date)` over all referred ids in `[lo, hi)`, returning the fares sum, the row count and the settled count;
  - then filter in Python against each link's `[from_bd, to_bd)`, each driver's `archived_at` business date (`_bd_of`), and `< today`.
- [ ] **Step 4: Run, expect ALL PASS.** Then re-run `check_calendar.py` and `check_history.py`: still ALL PASS.
- [ ] **Step 5: Commit** `backend/server.py` with the message "Referrals: settings, links and the qualifying-day rule".

### Task 2: Monthly lock, salary and history (server)

**Files:**
- Modify: `backend/server.py`: the REFERRALS block; `_salary_state` (~line 8785); `_history_timed_rows` (~line 8943); the hard delete (~line 4060).
- Test: `scratchpad/t/check_referrals.py` (append)

**Interfaces:**
- Consumes: `_referral_days`, `_referral_links`.
- Produces:
  - `async def _referral_lock(referrer_id: str) -> None`: writes the missing `referral_months` rows for every **due** month (see Global Constraints) from the month of the earliest link's `from_bd`. Each row:
    `{id, driver_id, month, amount, rate, daily_min, days:[{referred_id, date, fares, amount}], created_at}`.
    A month's `days` = qualifying days in that month, plus earlier qualifying days not in any earlier row's `days` (match on `(referred_id, date)`). The row is written even when the amount is 0. On a duplicate key, do nothing. When `referral_enabled` is off, write nothing.
  - `async def _referral_paid_total(driver_id: str) -> float`.
  - `_salary_state(...)` returns an added `"referral_paid": float`, and `earned` includes it.

- [ ] **Step 1: Write the failing tests.**
  - Seed a link from a previous month with qualifying days there, and one day in that month left `pending`.
  - Call `GET /api/money/salary` twice, then:
  ```python
  rows = run(db.referral_months.find({"driver_id": "R"}).to_list(None))
  check("one lock per finished month", len([r for r in rows if r["month"] == prev]) == 1)
  check("current month not locked", not any(r["month"] == today[:7] for r in rows))
  # patch business_date_now to the 5th of next month: last month still not due; to the 6th: due
  check("not paid on the 5th", ...); check("paid from the 6th", ...)
  check("salary includes locked only", sal["referral_paid"] == locked_amt and sal["earned"] == share + locked_amt, sal)
  ```
  - Late day: settle the pending previous-month day, delete only the current-month lock if any, and simulate the next month by calling `_referral_lock` with the current month treated as finished. Patch `S.business_date_now` to return the 6th of next month; restore it afterwards.
  ```python
  check("late-final day paid in next lock", any(d["date"] == late_day for d in next_row["days"]))
  check("late day not paid twice", sum(1 for r in all_rows for d in r["days"] if d["date"] == late_day) == 1)
  ```
  - Race: run `asyncio.gather(_referral_lock("R"), _referral_lock("R"))` on a fresh month. Expect `count == 1` and no exception.
  - History: the `/api/money/history` rewards include a `referral` entry for the month with amount > 0, and none for a ₹0 month.
  - Hard delete: as owner, `DELETE /api/admin/drivers/Z?hard=1` returns 200 for a driver with only a ₹0 lock, and 409 `has_financial_history` for `R` and for `F` (who appears in paid `days`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - `_salary_state` calls `_referral_lock(did)` first, then adds `_referral_paid_total`.
  - `_history_timed_rows` adds `{"kind": "reward", "type": "referral", "month", "amount", "date": "<month+1>-01"}` for rows with amount > 0. Use the same keys the existing reward entries use.
  - Hard delete: check paid locks on both sides. Otherwise delete the driver's `referrals` rows (both sides) and ₹0 `referral_months` rows.
- [ ] **Step 4: Run, expect ALL PASS**, along with `check_calendar.py` and `check_history.py`.
- [ ] **Step 5: Commit** with the message "Referrals: monthly lock into salary and payment history".

### Task 3: Endpoints (server)

**Files:**
- Modify: `backend/server.py`: `DriverCreateIn` (~line 504) and `admin_create_driver` (~line 3216); new endpoints in the REFERRALS block.
- Test: `scratchpad/t/check_referrals.py` (append)

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces (exact paths and response keys; the apps rely on these):
  - `DriverCreateIn.referred_by: Optional[str] = None`. On create, it opens a link with `from_bd = business_date_now()`. Refuse with 400 `self_referral` (not reachable at create, but keep the check shared), 404 `referrer_not_found`, or 409 `referrer_inactive` (archived or `active: False`).
  - `PUT /admin/drivers/{driver_id}/referrer`, body `{"referrer_id": str | null}`, `Depends(require_owner)`. Closes the open row (`to_bd = today`, `ended_at`, `ended_by`). Opens a new one unless null; if the new link has the same referrer, do nothing. Same refusals as above. Writes `_audit(admin, "set_referrer", driver_id, {"from": old, "to": new})`. Returns `{"ok": True, "referred_by": {...} | None}`.
  - `GET /admin/drivers/{driver_id}/referral`, `require_ops` + `_assert_driver_in_scope`. Returns `{"referred_by": {"id", "name", "since"} | None, "referrals_made": int}`.
  - `GET /admin/referrals?month=YYYY-MM` (`_month_or_400`), `require_ops`. A hub manager sees links where either driver is in their hub. Runs `_referral_lock` for each referrer listed. Returns:
    ```
    {"month", "enabled", "rate", "daily_min", "pay_date": "<month+1>-01",
     "rows": [{"referrer": {id,name,hub_name}, "referred": {id,name,hub_name},
               "since", "until", "month_amount", "month_days", "month_paid": bool,
               "lifetime_paid"}],
     "totals": {"month_amount", "lifetime_paid"}}
    ```
  - `GET /money/referrals?month=YYYY-MM`, `get_driver`. Runs `_referral_lock`. Returns:
    ```
    {"month", "first_month", "enabled", "rate", "daily_min",
     "total", "paid": bool, "pay_date",
     "people": [{"name", "since", "active"}],
     "days": [{"date", "name", "amount"}]}
    ```
    A locked month reads from its row's `days`; otherwise from `_referral_days`. Never include `fares`. `first_month` is the month of the earliest link (else the current month). `people` is empty when the driver referred nobody.

- [ ] **Step 1: Write the failing tests:**
  - create with `referred_by` → link row `from_bd == today`;
  - create referring an archived driver → 409;
  - `PUT` as hub manager → 403; as manager → 403; as owner → 200; the old row's `to_bd == today`;
  - `PUT` to self → 400;
  - `GET /money/referrals`: response has no `fares` key anywhere (`"fares" not in json.dumps(r)`); a past month gives `paid: True`;
  - `GET /admin/referrals`: a hub manager of H3 sees 0 rows, a hub manager of H2 sees the R→F row;
  - `GET /admin/drivers/F/referral` → `referred_by.id == "R"`;
  - a driver with no referrals → `people == []`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the endpoints.
- [ ] **Step 4: Run, expect ALL PASS**, plus `check_calendar.py`, `check_history.py` and `check_no_days.py`.
- [ ] **Step 5: Commit** with the message "Referrals: admin and driver endpoints".

### Task 4: Admin panel

**Files:**
- Create: `admin/src/pages/Referrals.tsx`
- Modify: `admin/src/api.ts`, `admin/src/App.tsx` (route `/referrals`, available to every role like `/rewards`), `admin/src/components/Layout.tsx` (nav `{ to: "/referrals", label: "Referrals", hub: true }` after Loyalty), `admin/src/pages/Drivers.tsx`, `admin/src/pages/DriverDetail.tsx`, `admin/src/pages/Settings.tsx`

**Interfaces:**
- Consumes: the Task 3 endpoints and the settings keys from Task 1.
- Produces:
  - Drivers form: a searchable "Referred by (optional)" select of active, non-archived drivers (name · phone). It sends `referred_by` in `createDriver`.
  - DriverDetail: a `Stat` "Referred by" showing name and since. A "Change" button shows only when `admin.role === "owner"`; it opens an inline select with a "None" option and calls `PUT …/referrer`.
  - Referrals page: a month picker (‹ ›, bounded at the current month), totals, and a table: Referrer · Referred · Since · This month (₹, days) · Paid? · Lifetime.
  - Settings: "Referrals on" checkbox, "Rate %" (UI shows 2, sends 0.02), "Daily minimum ₹", "Pay on day" (of the next month).

- [ ] **Step 1: Build:** `cd admin && npm run build`. Expect no type errors.
- [ ] **Step 2: Check in the browser.**
  - Run the local seeded server (`serve_calendar.py` pattern, extended with referral seed data in a copy `serve_referrals.py`).
  - Serve `admin/dist` and open it in the in-app browser.
  - Log in as the local test owner. Add a driver with a referrer, change it on the driver page, and see the Referrals page and the Settings fields.
  - As the local hub manager and a local manager, there is no Change button.
- [ ] **Step 2b: Screenshots for the owner:** Add driver form with Referred by, driver page with Change, Referrals page, Settings. Save them to the scratchpad and send them with SendUserFile.
- [ ] **Step 3: Commit** the listed admin files with the message "Admin: referrals page, referred-by on add and driver page, settings".

### Task 5: Driver app and Hub app

**Files:**
- Create: `frontend/src/i18n/referrals.ts` (`useReferralText()`, en + hi, same shape as `calendar.ts`), `frontend/app/referrals.tsx`
- Modify: `frontend/app/(tabs)/money.tsx`, `frontend/app/_layout.tsx`, `frontend/hub-app/driver/[id].tsx`

**Interfaces:**
- Consumes: `GET /money/referrals`, `GET /admin/drivers/{id}/referral`.
- Produces:
  - Money tab: a card with `testID="open-referrals"`, placed below the "Day by day" card. It renders only when `people.length > 0`, reading `/money/referrals` with the tab's existing refresh. Content: "🤝 Referral earnings", this month's total, and "To be paid on 6 Dec" (or "Paid" for a locked month).
  - `referrals.tsx`: a month header with ‹ › bounded `first_month..current`. It shows the total and the paid / to-be-paid line, the people list (with "left Ride91" when inactive), and the day list "12 Nov · Ravi · +₹60". An empty month shows "No referral earnings this month". It also explains the rule: "You earn {rate}% of a friend's fares on every day they reach ₹{min}. Paid into your salary after the 5th of the next month."
  - Hub driver page: "🤝 Referred by {name} (since {date})" under the calendar button, only when set. Loaded in the existing `load()` `Promise.all`. A failure there must not break the page (catch, then null).

- [ ] **Step 1: Type-check:** `cd frontend && npx tsc --noEmit`. Expect no new errors.
- [ ] **Step 2: Check on the web.**
  - Driver: `npx expo export --platform web`, served against the local seeded server, in the in-app browser on the mobile preset. Log in as the local test driver who referred someone: the card shows, the screen opens, month arrows work, Hindi switches. A driver with no referrals sees no card.
- [ ] **Step 2b: Screenshots for the owner:** Money tab card, referral screen (this month and a paid month), Hub driver page. Send them with SendUserFile.
  - Hub: build with `APP_VARIANT=hub` and open the referred driver's page to see the line.
- [ ] **Step 3: Commit** the listed frontend files with the message "Apps: referral earnings card and screen; Hub shows referred-by".

### Task 6: Docs, APKs and hand-off

**Files:**
- Modify: `docs/rules.md` (referral rule), `docs/memory.md` (decision row 2026-11-14), `docs/task.md` (done entry, owner steps)
- Build: driver v24 (`frontend/android`, versionCode 11), Hub v17 (`frontend/android-hub`, versionCode 17)

- [ ] **Step 1: Docs.** Add the rule text from the spec's "The rule" to `rules.md`, the decision with its why to `memory.md`, and a done entry plus owner deploy/install steps to `task.md`.
- [ ] **Step 2: Run all offline checks once more:** referrals, calendar, history, no_days. Expect ALL PASS.
- [ ] **Step 3: Commit the docs and push** `main`.
- [ ] **Step 4: Build signed APK and AAB** for both apps as before: bump versionCode, Gradle release, and for the Hub app swap folders. Verify each with `aapt` (versionCode) and `apksigner` (signer SHA-1 `41eaa101d10b62d5b2067cf7acc4029521cc2685`). Copy them to Downloads as `ride91-driver-2026-11-14-v24.apk` / `ride91-hub-2026-11-14-v17.apk` plus the `.aab` files. Commit the versionCode bumps.
- [ ] **Step 5: Hand-off.** Give the owner the Cloud Shell commands to deploy `ride91-api` and `ride91-admin`, then verify after "deployed, verify".
