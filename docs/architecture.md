# Ride91 — Architecture

Last updated: 2026-11-10.

## Pieces

```
 Driver app (Android)  ─┐
 Hub app (Android)     ─┼──HTTPS /api──►  ride91-api (FastAPI, Cloud Run) ──► MongoDB Atlas (M0, 512 MB)
 Admin panel (web)     ─┘                       │
   served by ride91-admin (Cloud Run)           ├──► Razorpay (QR codes, payment links, webhooks)
                                                ├──► RazorpayX (salary payouts, webhooks)
                                                └──► WhatsApp (Meta API or Kapso proxy)
```

| Piece | Code | Tech | Runs on |
|---|---|---|---|
| API | `backend/server.py` (~10,000 lines, one file), `backend/jobs.py` | FastAPI 0.110, Motor 3.3 (async Mongo), Pydantic 2 | Cloud Run service `ride91-api`, region asia-south1, scales to zero |
| Database | — | MongoDB Atlas M0 (free tier, 512 MB limit) | Atlas |
| Driver app | `frontend/app`, `frontend/src` | Expo 57, React Native 0.86, expo-router, TypeScript | Android, `com.ride91.driver` |
| Hub app | `frontend/hub-app`, `frontend/src/hub` | Same Expo project, built with `APP_VARIANT=hub` | Android, `com.ride91.hub` |
| Admin panel | `admin/` | Vite 5, React 18, react-router 6 | Cloud Run service `ride91-admin` |
| Scripts | `backend/scripts/` | Python | Run by the owner in Cloud Shell |

Cloud Run egress goes through Cloud NAT with a static IP (for the RazorpayX IP allow-list).

## One Expo project, two apps

`frontend/app.config.js` reads `APP_VARIANT`. Without it the app is the driver app (routes in `frontend/app`); with `APP_VARIANT=hub` it is the Hub app (routes in `frontend/hub-app`). Each has its own native Android folder: `frontend/android` (driver) and `frontend/android-hub` (hub). To build the Hub app the folders are swapped so the hub one is named `android`, then swapped back.

## API

All routes are under `/api`. Groups:

| Prefix | For |
|---|---|
| `/auth/*` | Driver sign-in (phone + password), sign-out, `me`, change password |
| `/duty/*`, `/close-out`, `/tracking/*` | Duty states, the day's segments, GPS pings and heartbeats |
| `/money/*` | Today, week, salary, withdraw, deposit link, collection QR, rewards, loyalty, history |
| `/payments/razorpay/*`, `/payouts/*` | Driver-side payments and bank account |
| `/requests`, `/notifications`, `/documents`, `/consents`, `/inspection`, `/shift-alarm/*` | Driver features |
| `/admin/*` | Hub app and admin panel (role-checked) |
| `/webhooks/razorpay`, `/webhooks/razorpayx`, `/webhooks/whatsapp` | Incoming webhooks (signature-checked) |
| `/health` | Health check |

Access control is by FastAPI dependencies: `get_driver` (driver token), `get_admin`, `require_ops` (hub_manager+), `require_write` (manager+), `fleet_admin` (not hub-scoped), `require_owner`. A hub manager is limited to their hub with `hub_scope()`, `_assert_driver_in_scope`, `_assert_vehicle_in_scope`.

Sessions: driver tokens in `sessions` (30 days), admin tokens in `admin_sessions` (12 hours). Six failed logins in 15 minutes lock the account for 15 minutes (`login_attempts`).

Settings live in one `settings` document, cached in memory (`load_settings`), editable by the owner in the admin panel. Defaults are `SETTINGS_DEFAULTS` in `server.py`. Secret values are never returned by the API.

## Database (MongoDB collections)

| Area | Collections |
|---|---|
| People | `drivers`, `admin_users`, `sessions`, `admin_sessions`, `login_attempts` |
| Fleet | `hubs`, `vehicles`, `handovers`, `handover_photos` (45-day TTL), `car_checks`, `car_services`, `vehicle_pings`, `phone_pings`, `heartbeats` |
| Duty | `duty_states` (append-only), `close_outs`, `shift_schedules`, `alarm_arming`, `alarm_responses` |
| Money | `platform_cash` (earnings + cash per platform per day), `collections`, `qr_payments`, `razorpay_qrs`, `razorpay_orders`, `deposit_links`, `driver_collection_qrs`, `salary_withdrawals`, `payouts`, `reward_payouts`, `advances`, `driver_bank_accounts`, `webhook_events` |
| Driver records | `documents`, `consent_events`, `inspections`, `go_online_captures`, `requests`, `notifications`, `whatsapp_messages`, `bookings` |
| System | `settings`, `counters`, `admin_audit` |

Indexes are created at start-up (`_prepare_database`). If the database refuses writes (for example when full), the server still starts so reads keep working.

Owners can see how full the database is: `GET /admin/storage` and the storage card in admin Settings.

## Offline-first clients

- Driver app (`src/sync.ts`): every action is saved to a queue on the phone (`ride91.sync.queue`) with a `client_action_id`, tagged with the driver's id, and sent in order. It is retried every 60 s and when the app comes back. Network errors, 5xx, 401, 403, 408 and 429 keep the item; another 4xx drops it after 3 tries; a 5xx drops it after 72 hours.
- The server stores each action once per `(driver_id, client_action_id)` (unique index), so a retry never duplicates.
- `src/api.ts` gives up on a request after 20 s (longer for uploads, up to 10 minutes).
- `src/auth.ts` keeps the token in secure storage and the last profile in `ride91.driver.profile`.
- Hub app (`src/hub/session.tsx`): session in `ride91.hub.session`, re-checked with `/admin/me` on open, on return to the app and on any 403. Today reloads every 20 s.

## Time

Everything is stored in UTC. The **business day** runs 04:00 to 03:59 IST (`BUSINESS_DAY_OFFSET_HOURS = 4`), so a night shift belongs to the day it started. Helpers: `business_date_now()`, `business_date_from_dt()`, `business_day_bounds()`.

## Deploy and build

See [CLOUDRUN.md](../CLOUDRUN.md) and [DEPLOYMENT.md](../DEPLOYMENT.md). In short:

```bash
gcloud run deploy ride91-api --source backend --region asia-south1 --allow-unauthenticated
gcloud run deploy ride91-admin --source admin --region asia-south1 --allow-unauthenticated
```

Android APKs and Play bundles are built locally with Gradle (`assembleRelease bundleRelease`) and signed with the upload key, which is kept outside the repo.
