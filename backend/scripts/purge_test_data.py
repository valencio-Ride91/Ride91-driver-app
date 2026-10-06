#!/usr/bin/env python3
"""Permanently remove test drivers and everything recorded against them.

The admin panel refuses to hard-delete a driver that has any financial history
(deposits, platform cash, payouts) so the audit trail of a real driver can't be
lost by a click. Test accounts created while building the system have exactly
that kind of history, so they need this deliberate, out-of-band purge instead.

DRY RUN BY DEFAULT: without --apply nothing is written; the script only prints
what it would delete. Review that output, then re-run with --apply.

Targets
  --phones  P1,P2,...   drivers to purge, by login phone (exact match)
  --orphans             also purge rows whose driver no longer exists
                        (left behind by test drivers deleted earlier)

Connection: MONGO_URL and DB_NAME from the environment, or
  --from-cloud-run SERVICE [--region REGION]
to read them from the Cloud Run service's own configuration (needs gcloud),
so the connection string never has to be typed or shown.

Example
  python3 backend/scripts/purge_test_data.py --from-cloud-run ride91-api \\
      --phones +917777777001,+919900000001 --orphans
  ...review...  then add  --apply

Not touched: hubs, vehicles, settings, admin users, the admin audit log,
bookings, and the driver-code counter. Razorpay itself is not called — the QR
codes of purged drivers are listed at the end so they can be closed there.
"""
import argparse
import json
import os
import subprocess
import sys

from pymongo import MongoClient

# Every collection whose rows belong to a driver via `driver_id`.
DRIVER_KEYED = [
    "advances", "alarm_responses", "close_outs", "collections", "consent_events",
    "documents", "driver_bank_accounts", "driver_collection_qrs", "duty_states",
    "go_online_captures", "heartbeats", "inspections", "notifications", "payouts",
    "phone_pings", "platform_cash", "qr_payments", "razorpay_orders", "razorpay_qrs",
    "requests", "reward_payouts", "sessions", "shift_schedules", "vehicle_pings",
]


def env_from_cloud_run(service: str, region: str) -> None:
    out = subprocess.run(
        ["gcloud", "run", "services", "describe", service, "--region", region, "--format=json"],
        check=True, capture_output=True, text=True,
    ).stdout
    env = json.loads(out)["spec"]["template"]["spec"]["containers"][0].get("env", [])
    for e in env:
        if e["name"] in ("MONGO_URL", "DB_NAME"):
            if "value" not in e:
                sys.exit(f"{e['name']} is a secret reference on {service}; export it yourself instead.")
            os.environ[e["name"]] = e["value"]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phones", default="", help="comma-separated driver phones to purge")
    ap.add_argument("--orphans", action="store_true", help="also purge rows of drivers that no longer exist")
    ap.add_argument("--from-cloud-run", metavar="SERVICE", help="read MONGO_URL/DB_NAME from this Cloud Run service")
    ap.add_argument("--region", default="asia-south1")
    ap.add_argument("--apply", action="store_true", help="actually delete (default is a dry run)")
    args = ap.parse_args()

    if args.from_cloud_run:
        env_from_cloud_run(args.from_cloud_run, args.region)
    if not os.environ.get("MONGO_URL") or not os.environ.get("DB_NAME"):
        sys.exit("MONGO_URL / DB_NAME not set (export them, or use --from-cloud-run).")
    db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]

    phones = [p.strip() for p in args.phones.split(",") if p.strip()]
    if not phones and not args.orphans:
        sys.exit("Nothing to do: give --phones and/or --orphans.")

    targets = list(db.drivers.find({"phone": {"$in": phones}}, {"_id": 0, "id": 1, "name": 1, "phone": 1, "archived": 1}))
    missing = sorted(set(phones) - {d["phone"] for d in targets})
    if missing:
        sys.exit(f"No driver with phone(s): {', '.join(missing)} — nothing changed.")

    mode = "APPLY — deleting" if args.apply else "DRY RUN — nothing will be deleted"
    print(f"== {mode} ==  database: {db.name}\n")

    total = 0

    def purge(label: str, ids: list) -> None:
        nonlocal total
        if not ids:
            return
        print(label)
        for coll in DRIVER_KEYED:
            q = {"driver_id": {"$in": ids}}
            n = db[coll].count_documents(q)
            if n:
                print(f"    {coll:24s} {n}")
                total += n
                if args.apply:
                    db[coll].delete_many(q)

    qr_ids = [r["qr_code_id"] for r in db.driver_collection_qrs.find(
        {"driver_id": {"$in": [d["id"] for d in targets]}}, {"_id": 0, "qr_code_id": 1}) if r.get("qr_code_id")]

    for d in targets:
        flag = "archived" if d.get("archived") else "ACTIVE"
        purge(f"Driver {d.get('name')} ({d['phone']}, {flag})", [d["id"]])
        print("    drivers                  1")
        total += 1
        if args.apply:
            db.drivers.delete_one({"id": d["id"]})

    if args.orphans:
        # Drivers still present after the purge above (in a dry run the targets
        # are still in the collection, so exclude them here by hand).
        gone = {d["id"] for d in targets}
        known = {d["id"] for d in db.drivers.find({}, {"_id": 0, "id": 1})} - gone
        orphan_ids = set()
        for coll in DRIVER_KEYED:
            for did in db[coll].distinct("driver_id"):
                if did and did not in known and did not in gone:
                    orphan_ids.add(did)
        qr_ids += [r["qr_code_id"] for r in db.driver_collection_qrs.find(
            {"driver_id": {"$in": sorted(orphan_ids)}}, {"_id": 0, "qr_code_id": 1}) if r.get("qr_code_id")]
        if orphan_ids:
            purge(f"Orphan rows of {len(orphan_ids)} driver(s) that no longer exist", sorted(orphan_ids))
        else:
            print("No orphan rows.")

    print(f"\n{'Deleted' if args.apply else 'Would delete'} {total} record(s).")
    if qr_ids:
        print("\nRazorpay collection QR codes of the purged drivers (close these in Razorpay):")
        for q in qr_ids:
            print(f"    {q}")
    if not args.apply:
        print("\nDry run only. Re-run with --apply to delete.")


if __name__ == "__main__":
    main()
