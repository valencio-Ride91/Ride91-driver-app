#!/usr/bin/env python3
"""Clear the photos and videos out of old car inspections, keeping the records.

Until 3 Nov 2026 every daily car inspection saved a dashboard photo and a
walk-round video (2-10 MB each) inside the database, whose free plan holds
512 MB; that is the most likely cause of the 30-31 Oct outage. Inspections
are switched off now, but the media already saved stays until it is removed.

This removes only the media fields. Each inspection row (who, which car, when,
and any notes) stays, marked with `media_purged_at`. Old "go online" captures
(a selfie and a walk-round video) are cleared the same way.

DRY RUN BY DEFAULT: without --apply nothing is written; the script only prints
how many rows carry media and how much space it takes. Review that, then run
again with --apply. Removing the media cannot be undone.

Connection: MONGO_URL and DB_NAME from the environment, or
  --from-cloud-run SERVICE [--region REGION]
to read them from the Cloud Run service's own configuration (needs gcloud),
so the connection string never has to be typed or shown.

Example
  python3 backend/scripts/purge_inspection_media.py --from-cloud-run ride91-api
  ...review...  then add  --apply
  Keep the last 30 days of media:  --older-than-days 30
"""
import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

from pymongo import MongoClient

# collection -> (media fields, the timestamp field used for --older-than-days)
TARGETS = {
    "inspections": (["dashboard_photo_b64", "exterior_video_b64"], "created_at"),
    "go_online_captures": (["selfie_photo_b64", "walkaround_video_b64"], "created_at"),
}


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


def query_for(fields, ts_field, older_than_days):
    q = {"$or": [{f: {"$nin": [None, ""]}} for f in fields]}
    if older_than_days > 0:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=older_than_days)).isoformat()
        q = {"$and": [q, {ts_field: {"$lt": cutoff}}]}
    return q


def media_mb(coll, fields, q) -> float:
    """How much text the media fields hold in the matching rows (MB)."""
    size = {"$add": [{"$strLenBytes": {"$ifNull": [f"${f}", ""]}} for f in fields]}
    try:
        rows = list(coll.aggregate([{"$match": q}, {"$group": {"_id": None, "b": {"$sum": size}}}]))
    except Exception as e:          # the estimate is only for the printout
        print(f"  (could not measure the size: {type(e).__name__})")
        return 0.0
    return round((rows[0]["b"] if rows else 0) / 1048576, 1)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from-cloud-run", metavar="SERVICE", help="read MONGO_URL/DB_NAME from this Cloud Run service")
    ap.add_argument("--region", default="asia-south1")
    ap.add_argument("--older-than-days", type=int, default=0,
                    help="only clear media older than this many days (default: all of it)")
    ap.add_argument("--apply", action="store_true", help="actually clear the media (default is a dry run)")
    args = ap.parse_args()

    if args.from_cloud_run:
        env_from_cloud_run(args.from_cloud_run, args.region)
    if not os.environ.get("MONGO_URL") or not os.environ.get("DB_NAME"):
        sys.exit("MONGO_URL / DB_NAME not set (export them, or use --from-cloud-run).")
    db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]

    print("DRY RUN - nothing will change.\n" if not args.apply else "APPLYING - media will be removed.\n")
    total = 0.0
    for name, (fields, ts_field) in TARGETS.items():
        coll = db[name]
        q = query_for(fields, ts_field, args.older_than_days)
        n = coll.count_documents(q)
        mb = media_mb(coll, fields, q) if n else 0.0
        total += mb
        print(f"{name:22} {n:5} rows with media  ~{mb} MB  (rows in total: {coll.count_documents({})})")
        if args.apply and n:
            res = coll.update_many(q, {"$unset": {f: "" for f in fields},
                                       "$set": {"media_purged_at": datetime.now(timezone.utc).isoformat()}})
            print(f"{'':22} cleared {res.modified_count} rows")
    print(f"\nMedia {'removed' if args.apply else 'that would be removed'}: about {round(total, 1)} MB.")
    if not args.apply:
        print("Run again with --apply to remove it.")
    else:
        print("The admin panel's Database storage card shows the new size. The free space is "
              "reused for new data straight away, even where the database's on-disk size takes "
              "a while to shrink.")


if __name__ == "__main__":
    main()
