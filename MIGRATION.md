# Ride91 — Moving off Emergent

The code is already Emergent-free: the LLM/OCR hook, the Google-OAuth broker,
and the cron mechanism have all been removed or replaced. What remains is
standing up the infrastructure elsewhere and pointing everything at it.

Because the current data is dummy, **there is no data migration** — a fresh
database seeds itself on first boot (`_seed_if_empty`).

## Target stack

| Piece | Moves to |
|---|---|
| Database | MongoDB Atlas |
| Backend API + jobs | Google Cloud Run (Docker, from `backend/Dockerfile`) — see `CLOUDRUN.md` |
| Admin panel | Netlify or Vercel (static, config already present) |
| Driver app | Google Play internal track (see `DEPLOYMENT.md`) |

---

## 1. MongoDB Atlas

1. Create a free M0 cluster, region Mumbai `ap-south-1`.
2. Database access → add a user (username + strong password).
3. Network access → `0.0.0.0/0` to start (Cloud Run has no fixed egress IPs on
   the base tier; lock down later with VPC egress if needed).
4. Copy the SRV connection string:
   `mongodb+srv://<user>:<pass>@<cluster>/?retryWrites=true&w=majority`
   The app reads `DB_NAME` separately (default `ride91`).

## 2. Backend on Cloud Run

Full commands in **`CLOUDRUN.md`**. In short: put the secrets in Secret
Manager, then `gcloud run deploy ride91-api --source backend --region
asia-south1 --allow-unauthenticated`. The two housekeeping jobs run as Cloud
Run Jobs + Cloud Scheduler (also in `CLOUDRUN.md`).

## 3. Verify

```bash
curl https://<cloud-run-url>/api/health
# -> {"ok": true, "db": true}
```

The app seeds a demo driver + vehicle on first boot, so the admin dashboard has
data immediately. Log into the admin panel and confirm the dashboard,
drivers, and bookings load.

## 4. Repoint the clients

- **Driver app**: `frontend/eas.json` → each build profile's
  `EXPO_PUBLIC_BACKEND_URL`. Rebuild (EAS) — the URL is baked into the JS bundle.
- **Admin panel**: `admin/.env` → `VITE_API_URL`. Rebuild + redeploy.
- **Razorpay webhooks**: in the Razorpay + RazorpayX dashboards, change the
  webhook URLs to `https://<new-host>/api/webhooks/razorpay` and
  `/api/webhooks/razorpayx`.

## 5. Domain (ride91.com)

Point subdomains once the services are up:

| Subdomain | Points at |
|---|---|
| `api.ride91.com` | Cloud Run (`gcloud run domain-mappings create` prints the records) |
| `ops.ride91.com` | Netlify/Vercel admin deploy |
| `ride91.com` | Landing + `/privacy` (Play requires a privacy policy URL) |

After adding `api.ride91.com`, update `EXPO_PUBLIC_BACKEND_URL` / `VITE_API_URL`
to the clean domain and rebuild, then lock the backend CORS
(`allow_origins`) from `*` to the admin origin.

## 6. Decommission Emergent

Once the new stack is verified and DNS has propagated, shut down the Emergent
project. Nothing in the codebase references it any more; `.emergent/emergent.yml`
and `.emergent/markers` are inert off-platform and can be deleted.

---

## Still required for real production (independent of the move)

- **SMS/OTP provider** — OTP is currently mocked (`123456` accepted, code
  returned in the response). Wire MSG91/Twilio and stop echoing the code.
- **Per-user admin accounts + roles** — the panel uses one shared password;
  `recorded_by` on cash hand-ins is only meaningful once staff have their own logins.
- **Real Razorpay/RazorpayX keys** and verified webhook secrets.
- **Google Maps API key** — replace the placeholder in `app.json`.
- **Google sign-in** — removed. If you want it back later, implement your own
  Google OAuth (not through Emergent).
