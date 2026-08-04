# Ride91 Driver App — PRD

## Purpose
Android-only private driver app for Ride91, an EV ride-hailing fleet in India. Drivers are employees driving company-owned Citroën ëC3 cars. Not distributed via public app store.

## Stack
- **App**: Expo (React Native, Android target), TypeScript, expo-router, react-native-maps (Google provider), expo-location, @react-native-community/netinfo, expo-secure-store.
- **Backend**: FastAPI + MongoDB (spec asked for PostgreSQL; user chose Mongo). All duty/tracking data is modelled append-only with the same semantics.
- **Auth**: phone + OTP (mocked, `123456` accepted). Session token in secure storage.
- **Languages**: English, Hindi, Kannada. Selector lives in the header.

## The spine — duty_states
`duty_states` collection is append-only. `state ∈ {ride91, uber, rapido, ola, offline, shift_end}`.
No current-state column anywhere — always derived from the latest row per driver. Admin corrections are new rows with `source='admin_correction'`.

Endpoints:
- `POST /api/duty/state` — append a state change (idempotent on `(driver_id, client_action_id)`).
- `GET /api/duty/today` — segments + totals + current state + distance today.

## Screens
1. **Home** — Map (Google provider on native, soft placeholder on web preview) + Status bar (current platform, on-duty, distance today, battery SOC, range) + Duty stripe (proportional bar coloured by platform, offline hatched) + Platform selector sheet + Close-out sheet on switch away.
2. **Money** — Today's gross broken down per platform, 30% driver share, cash held with ₹1,500 limit flag, expandable settlement rows (Share / Cash / Advance / Payable) that show their inputs, "Deposit cash" QR sheet, weekly earnings bar chart.
3. **Requests** — Unified table of Advance / Holiday / Extra hours requests with pending/approved/rejected/paid states; create new via FAB.
4. **Profile** — Driver + vehicle info, logout.

## Offline-first
- Every mutating action goes into a persistent AsyncStorage queue with a client-generated UUID before being POSTed.
- Sync worker drains when NetInfo says online.
- Server dedupes on `(driver_id, client_action_id)`.
- Header shows unsynced count + reassuring banner.

## Tracking health
- Foreground 4-minute balanced-accuracy `expo-location` pings.
- 60-second heartbeat with `permission_ok` + `network_up`.
- Health pill in header: synced / no_network / location_off. Tapping location_off re-prompts.

## Mock hardware tracker
- `vehicle_pings` collection seeded with ~1 day of pings for the demo vehicle.
- `POST /api/vehicles/pings/ingest` is a **clearly-marked stub** for the real feed.
- Distance today is computed server-side, filtering out any ping with `accuracy_m > 30`.

## Not built (per spec)
- Automated login to Uber/Rapido/Ola.
- Screen capture, notification scraping.
- Sleep tracking.
- iOS.
- Quests, tiers, wait-time pay.

## Definition of done check
1. ✅ Log in → pick platform → duty stripe fills.
2. ✅ Switching platforms triggers close-out sheet and money updates.
3. ✅ Offline: queue persists, drains on reconnect (dedup by `client_action_id`).
4. ✅ Settlement number expands to its inputs on tap.
5. ✅ Every screen works in en/hi/kn via header selector.
6. ✅ `duty_states` contains an append-only ordered history.
