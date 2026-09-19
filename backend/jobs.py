"""Portable scheduled jobs — replaces Emergent's `.emergent/cron`.

Run one job:  python jobs.py <name>

Each host schedules these with its own cron (Render cron services in
render.yaml, a system crontab, or a CI schedule) — no dependency on
Emergent's cron API. Jobs reuse the app's Mongo connection and helpers from
server.py, so they see exactly the same data and business rules.

Available jobs:
  close_expired_qrs   Mark single-use deposit QRs past their close_by as
                      expired (a safety sweep for any the qr_code.closed
                      webhook missed).
  expire_stale_otps   Delete OTP codes past their 10-minute expiry.
"""
from __future__ import annotations

import asyncio
import sys

from server import db, now_utc, iso


async def close_expired_qrs() -> dict:
    now_ts = int(now_utc().timestamp())
    res = await db.razorpay_qrs.update_many(
        {"status": "active", "close_by": {"$lt": now_ts}},
        {"$set": {"status": "expired", "expired_at": iso(now_utc())}},
    )
    return {"job": "close_expired_qrs", "expired": res.modified_count}


async def expire_stale_otps() -> dict:
    # expires_at is a UTC ISO string; lexicographic compare is valid for a
    # consistent isoformat, so a string $lt is correct here.
    res = await db.otp_codes.delete_many({"expires_at": {"$lt": iso(now_utc())}})
    return {"job": "expire_stale_otps", "deleted": res.deleted_count}


# Register new jobs here as they are ported (e.g. refresh_pending_payouts,
# import_uber_report). Keep each idempotent — cron may double-fire.
JOBS = {
    "close_expired_qrs": close_expired_qrs,
    "expire_stale_otps": expire_stale_otps,
}


async def _main() -> None:
    name = sys.argv[1] if len(sys.argv) > 1 else ""
    if name not in JOBS:
        print(f"unknown job '{name}'. available: {', '.join(JOBS)}")
        sys.exit(2)
    result = await JOBS[name]()
    print(result)


if __name__ == "__main__":
    asyncio.run(_main())
