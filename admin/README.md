# Ride91 · Admin panel

Standalone React (Vite) web app for the fleet ops team.

## Local development

```bash
cd /app/admin
yarn install          # first time only
yarn dev              # http://localhost:5173
```

The dev server proxies `/api/*` to `http://localhost:8001` so no CORS setup is needed while iterating locally.

## Environment

- `VITE_API_URL` — optional. Set to the fully-qualified backend URL if you're not fronting the admin site with a reverse proxy that already routes `/api/*` to FastAPI. Example: `https://api.ride91.green`. If unset, the app hits `/api/*` on the same origin.

## Login

Credentials live in `backend/.env`:

```
ADMIN_USERNAME=admin
ADMIN_PASSWORD=ride91-admin-2026
```

Change these **before** pointing DNS at production. Tokens roll every 12 hours; each authed request extends the expiry.

## Build

```bash
yarn build
# → /app/admin/dist  (static assets)
```

`dist/` is ready to serve from any static host — Vercel, Netlify, Cloudflare Pages, S3+CloudFront, or a plain nginx.

## Deploying to `admin.ride91.green`

The admin site is a **separate deployment** from the driver app. The Emergent driver-app deploy at `fleet-mobile-16.emergent.host` won't serve it.

Suggested paths:

1. **Vercel / Netlify (fastest)**
   1. Push `/app/admin/` as its own repo (or set the project root to `admin/`).
   2. Framework preset: Vite.
   3. Env: `VITE_API_URL=https://<your-backend-host>` (probably the Emergent backend URL, or a CNAMEd `api.ride91.green`).
   4. Domain: add `admin.ride91.green` — Vercel/Netlify will give you DNS instructions.
2. **Same origin as backend**
   1. `yarn build` locally.
   2. In FastAPI, mount `dist/` at `/`: `app.mount("/", StaticFiles(directory="/path/to/dist", html=True))`.
   3. Point `admin.ride91.green` at the backend host.

## Modules

- **Dashboard** — 4 tiles hitting `GET /api/admin/summary`.
- **Drivers** — `GET /api/admin/drivers` (on-duty status, cash-in-hand, last ping).
- **Live map** — `GET /api/admin/vehicles/live` on OpenStreetMap tiles (no Google Maps key needed).
- **Capture reviews** — `/api/admin/captures/pending` + media + approve/reject.
- **Document reviews** — `/api/admin/documents/pending` + media + approve/reject.
