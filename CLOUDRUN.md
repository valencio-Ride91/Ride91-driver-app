# Ride91 backend on Google Cloud Run

Free at low traffic (scales to zero, pay-per-request), Mumbai region
(`asia-south1`), deploys the existing `backend/Dockerfile` unchanged. Cloud
Run injects `$PORT` (8080) and the Dockerfile already binds uvicorn to it.

## Prerequisites (once)

```bash
# gcloud CLI installed + logged in
gcloud auth login
gcloud projects create ride91-prod            # or reuse an existing project
gcloud config set project ride91-prod
# billing must be linked to the project (required even for the free tier)

gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com \
  cloudscheduler.googleapis.com
```

## Secrets (Secret Manager — never on the command line history in prod)

```bash
# MONGO_URL from Atlas; repeat printf|create for each secret
printf '%s' 'mongodb+srv://ride91app:<pwd>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority' \
  | gcloud secrets create MONGO_URL --data-file=-
printf '%s' '<strong-admin-password>' | gcloud secrets create ADMIN_PASSWORD --data-file=-
printf '%s' '<razorpay_key_secret>'   | gcloud secrets create RAZORPAY_KEY_SECRET --data-file=-
printf '%s' '<razorpay_webhook>'      | gcloud secrets create RAZORPAY_WEBHOOK_SECRET --data-file=-
printf '%s' '<razorpayx_key_secret>'  | gcloud secrets create RAZORPAYX_KEY_SECRET --data-file=-
printf '%s' '<razorpayx_webhook>'     | gcloud secrets create RAZORPAYX_WEBHOOK_SECRET --data-file=-
```

## Deploy the API

```bash
gcloud run deploy ride91-api \
  --source backend \
  --region asia-south1 \
  --allow-unauthenticated \
  --min-instances 0 \
  --set-env-vars DB_NAME=ride91,ADMIN_USERNAME=ride91ops,RAZORPAY_KEY_ID=<id>,RAZORPAYX_ACCOUNT_NUMBER=<acct>,RAZORPAYX_KEY_ID=<id> \
  --set-secrets MONGO_URL=MONGO_URL:latest,ADMIN_PASSWORD=ADMIN_PASSWORD:latest,RAZORPAY_KEY_SECRET=RAZORPAY_KEY_SECRET:latest,RAZORPAY_WEBHOOK_SECRET=RAZORPAY_WEBHOOK_SECRET:latest,RAZORPAYX_KEY_SECRET=RAZORPAYX_KEY_SECRET:latest,RAZORPAYX_WEBHOOK_SECRET=RAZORPAYX_WEBHOOK_SECRET:latest
```

`--source backend` runs Cloud Build against `backend/Dockerfile` — no manual
image push. It prints the service URL, e.g. `https://ride91-api-xxxxx-el.a.run.app`.

## Verify

```bash
curl https://<service-url>/api/health     # -> {"ok":true,"db":true}
```

## Scheduled jobs (replaces the render.yaml crons)

Cloud Run **Jobs** + Cloud Scheduler run `backend/jobs.py` on a timer, all in
the free tier:

```bash
# one Job that can run any job name (override the arg per schedule)
gcloud run jobs deploy ride91-jobs \
  --source backend --region asia-south1 \
  --set-secrets MONGO_URL=MONGO_URL:latest \
  --set-env-vars DB_NAME=ride91 \
  --command python --args jobs.py,close_expired_qrs

# schedule it (every 10 min). Second job/schedule for expire_stale_otps hourly.
gcloud scheduler jobs create http ride91-close-expired-qrs \
  --location asia-south1 --schedule "*/10 * * * *" \
  --uri "https://asia-south1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/ride91-prod/jobs/ride91-jobs:run" \
  --http-method POST --oauth-service-account-email <run-invoker-sa>@ride91-prod.iam.gserviceaccount.com
```

(The two housekeeping jobs are non-critical — fine to add after the API is live.)

## Custom domain

Map `api.ride91.com` to the service:

```bash
gcloud run domain-mappings create --service ride91-api \
  --domain api.ride91.com --region asia-south1
```

It prints the DNS records (a CNAME / A+AAAA set) to add in GoDaddy. Google
issues the TLS cert automatically once DNS resolves.

## Updating later

Re-run `gcloud run deploy ride91-api --source backend --region asia-south1`.
Each deploy is a new immutable revision with instant rollback in the console.
