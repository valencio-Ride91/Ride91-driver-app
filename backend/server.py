"""Ride91 driver-app backend (FastAPI + MongoDB).

All routes are prefixed with /api. Mutating routes accept a `client_action_id`
UUID from the mobile client and dedupe per (driver_id, client_action_id) so the
offline sync worker can safely retry.

The duty_states collection is append-only: current state is always the most
recent row per driver, never stored on the driver document. Admin corrections
are new rows with source='admin_correction'.
"""
from __future__ import annotations

import logging
import os
import random
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, status
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

app = FastAPI(title="Ride91 Driver API")
api = APIRouter(prefix="/api")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("ride91")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
PLATFORMS = {"ride91", "uber", "rapido", "ola"}
NON_PLATFORM_STATES = {"offline", "shift_end"}
ALL_STATES = PLATFORMS | NON_PLATFORM_STATES
CASH_LIMIT = 1500  # ₹
DRIVER_SHARE = 0.30
DEMO_DRIVER_PHONE = "+919900000001"
DEMO_OTP = "123456"  # any OTP works; this one is guaranteed


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class OtpRequest(BaseModel):
    phone: str


class OtpVerify(BaseModel):
    phone: str
    code: str
    client_action_id: str


class DriverOut(BaseModel):
    id: str
    name: str
    phone: str
    vehicle_id: str
    vehicle_number: str
    qr_code: str


class DutyStateIn(BaseModel):
    state: Literal["ride91", "uber", "rapido", "ola", "offline", "shift_end"]
    started_at: str  # ISO from device
    lat: float
    lng: float
    source: Literal["driver", "admin_correction", "system"] = "driver"
    client_action_id: str


class CloseOutIn(BaseModel):
    platform: Literal["ride91", "uber", "rapido", "ola"]
    from_ts: str
    to_ts: str
    trips: int
    gross_amount: float
    cash_collected: float
    client_action_id: str


class RequestIn(BaseModel):
    type: Literal["advance", "holiday", "extra_hours"]
    payload: Dict[str, Any]
    client_action_id: str


class HeartbeatIn(BaseModel):
    ts: str
    permission_ok: bool
    network_up: bool
    battery_pct: Optional[float] = None


class VehiclePingIn(BaseModel):
    vehicle_id: str
    recorded_at: str
    lat: float
    lng: float
    speed_kmph: float
    ignition: bool
    soc_pct: float
    accuracy_m: float


class InspectionIn(BaseModel):
    dashboard_photo_b64: str          # data URL or raw base64 of the JPEG
    exterior_video_b64: str           # data URL or raw base64 of the mp4/webm
    exterior_video_mime: str = "video/mp4"
    client_action_id: str


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------
async def get_driver(authorization: Optional[str] = Header(default=None)) -> Dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing token")
    token = authorization.split(" ", 1)[1]
    session = await db.sessions.find_one({"token": token}, {"_id": 0})
    if not session:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid token")
    driver = await db.drivers.find_one({"id": session["driver_id"]}, {"_id": 0})
    if not driver:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "driver missing")
    return driver


# ---------------------------------------------------------------------------
# AUTH
# ---------------------------------------------------------------------------
@api.post("/auth/otp/request")
async def request_otp(body: OtpRequest):
    code = DEMO_OTP if body.phone == DEMO_DRIVER_PHONE else f"{random.randint(100000, 999999)}"
    await db.otp_codes.update_one(
        {"phone": body.phone},
        {"$set": {"code": code, "expires_at": iso(now_utc() + timedelta(minutes=10))}},
        upsert=True,
    )
    logger.info("OTP for %s = %s", body.phone, code)
    # For demo: return the code in response as well so it's discoverable.
    return {"sent": True, "debug_code": code}


@api.post("/auth/otp/verify")
async def verify_otp(body: OtpVerify):
    row = await db.otp_codes.find_one({"phone": body.phone}, {"_id": 0})
    # Accept the demo OTP for anyone, or the stored code.
    ok = body.code == DEMO_OTP or (row and row.get("code") == body.code)
    if not ok:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "bad_otp")
    driver = await db.drivers.find_one({"phone": body.phone}, {"_id": 0})
    if not driver:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "driver_not_found")
    vehicle = await db.vehicles.find_one({"id": driver["vehicle_id"]}, {"_id": 0})
    # Reuse token per client_action_id to keep verify idempotent under retry.
    existing = await db.sessions.find_one({"client_action_id": body.client_action_id}, {"_id": 0})
    token = existing["token"] if existing else str(uuid.uuid4())
    if not existing:
        await db.sessions.insert_one(
            {
                "token": token,
                "driver_id": driver["id"],
                "client_action_id": body.client_action_id,
                "created_at": iso(now_utc()),
            }
        )
    return {
        "token": token,
        "driver": DriverOut(
            id=driver["id"],
            name=driver["name"],
            phone=driver["phone"],
            vehicle_id=driver["vehicle_id"],
            vehicle_number=vehicle["number"] if vehicle else "",
            qr_code=driver.get("qr_code", ""),
        ).model_dump(),
    }


@api.get("/auth/me")
async def me(driver: Dict = Depends(get_driver)):
    vehicle = await db.vehicles.find_one({"id": driver["vehicle_id"]}, {"_id": 0})
    return {
        "driver": DriverOut(
            id=driver["id"],
            name=driver["name"],
            phone=driver["phone"],
            vehicle_id=driver["vehicle_id"],
            vehicle_number=vehicle["number"] if vehicle else "",
            qr_code=driver.get("qr_code", ""),
        ).model_dump(),
        "vehicle": {k: v for k, v in (vehicle or {}).items()},
    }


# ---------------------------------------------------------------------------
# PRE-SHIFT INSPECTION
# ---------------------------------------------------------------------------
def _ist_day_key() -> str:
    """Calendar day in IST as YYYY-MM-DD — matches the 'today' scoping used
    everywhere else."""
    ist = timezone(timedelta(hours=5, minutes=30))
    return now_utc().astimezone(ist).strftime("%Y-%m-%d")


@api.post("/inspection")
async def create_inspection(body: InspectionIn, driver: Dict = Depends(get_driver)):
    # Dedup on client_action_id (sync-queue retry safe)
    existing = await db.inspections.find_one(
        {"driver_id": driver["id"], "client_action_id": body.client_action_id},
        {"_id": 0},
    )
    if existing:
        return {"completed": True, "id": existing["id"], "created_at": existing["created_at"]}
    day_key = _ist_day_key()
    # Also dedup per (driver_id, day_key) — one inspection per day
    dup = await db.inspections.find_one(
        {"driver_id": driver["id"], "day_key": day_key}, {"_id": 0}
    )
    if dup:
        return {"completed": True, "id": dup["id"], "created_at": dup["created_at"]}
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver["id"],
        "vehicle_id": driver["vehicle_id"],
        "day_key": day_key,
        "dashboard_photo_b64": body.dashboard_photo_b64,
        "exterior_video_b64": body.exterior_video_b64,
        "exterior_video_mime": body.exterior_video_mime,
        "created_at": iso(now_utc()),
        "client_action_id": body.client_action_id,
    }
    await db.inspections.insert_one(row.copy())
    return {"completed": True, "id": row["id"], "created_at": row["created_at"]}


@api.get("/inspection/today")
async def inspection_today(driver: Dict = Depends(get_driver)):
    day_key = _ist_day_key()
    row = await db.inspections.find_one(
        {"driver_id": driver["id"], "day_key": day_key},
        {"_id": 0, "dashboard_photo_b64": 0, "exterior_video_b64": 0},
    )
    if not row:
        return {"completed": False, "day_key": day_key}
    return {"completed": True, "id": row["id"], "created_at": row["created_at"], "day_key": day_key}


# ---------------------------------------------------------------------------
# DUTY STATES (append-only)
# ---------------------------------------------------------------------------
@api.post("/duty/state")
async def append_duty_state(body: DutyStateIn, driver: Dict = Depends(get_driver)):
    if body.state not in ALL_STATES:
        raise HTTPException(400, "bad_state")
    existing = await db.duty_states.find_one(
        {"driver_id": driver["id"], "client_action_id": body.client_action_id}, {"_id": 0}
    )
    if existing:
        return existing
    # HARD GATE: going on-duty on any working platform requires today's
    # inspection. Offline / shift_end are always allowed.
    if body.state in PLATFORMS:
        day_key = _ist_day_key()
        insp = await db.inspections.find_one(
            {"driver_id": driver["id"], "day_key": day_key}, {"_id": 0}
        )
        if not insp:
            raise HTTPException(status.HTTP_409_CONFLICT, "inspection_required")
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver["id"],
        "vehicle_id": driver["vehicle_id"],
        "state": body.state,
        "started_at": body.started_at,
        "lat": body.lat,
        "lng": body.lng,
        "source": body.source,
        "client_action_id": body.client_action_id,
        "synced_at": iso(now_utc()),
    }
    await db.duty_states.insert_one(row.copy())
    row.pop("_id", None)
    return row


def _start_of_day_utc(offset_hours: int = 5, offset_minutes: int = 30) -> datetime:
    """Return the current IST day's 00:00 as UTC."""
    ist = timezone(timedelta(hours=offset_hours, minutes=offset_minutes))
    now_ist = now_utc().astimezone(ist)
    midnight_ist = now_ist.replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight_ist.astimezone(timezone.utc)


def _parse_iso(s: str) -> datetime:
    # tolerate trailing Z
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


async def _segments_for_day(driver_id: str, day_start: datetime, day_end: datetime) -> List[Dict]:
    """Build [ {state, from, to, seconds} ] from append-only duty_states."""
    cursor = db.duty_states.find(
        {"driver_id": driver_id}, {"_id": 0}
    ).sort("started_at", 1)
    rows = [r async for r in cursor]
    # Filter to those relevant to the day window.
    parsed = []
    for r in rows:
        try:
            parsed.append((_parse_iso(r["started_at"]), r))
        except Exception:
            continue
    segments: List[Dict] = []
    for i, (ts, row) in enumerate(parsed):
        seg_start = ts
        seg_end = parsed[i + 1][0] if i + 1 < len(parsed) else now_utc()
        # clip to day window
        s = max(seg_start, day_start)
        e = min(seg_end, day_end)
        if e <= s:
            continue
        segments.append(
            {
                "state": row["state"],
                "from_ts": iso(s),
                "to_ts": iso(e),
                "seconds": int((e - s).total_seconds()),
            }
        )
    return segments


@api.get("/duty/today")
async def duty_today(driver: Dict = Depends(get_driver)):
    day_start = _start_of_day_utc()
    day_end = day_start + timedelta(days=1)
    segs = await _segments_for_day(driver["id"], day_start, day_end)
    totals: Dict[str, int] = {}
    for s in segs:
        totals[s["state"]] = totals.get(s["state"], 0) + s["seconds"]
    shift_seconds = sum(totals.get(p, 0) for p in PLATFORMS) + totals.get("offline", 0)
    working_seconds = sum(totals.get(p, 0) for p in PLATFORMS)
    current = segs[-1]["state"] if segs else None
    # Distance today from vehicle_pings, filtered by accuracy_m <= 30
    distance_km = await _distance_today(driver["vehicle_id"], day_start, day_end)
    return {
        "segments": segs,
        "totals_seconds": totals,
        "shift_seconds": shift_seconds,
        "working_seconds": working_seconds,
        "current_state": current,
        "distance_km": round(distance_km, 2),
        "day_start": iso(day_start),
        "server_ts": iso(now_utc()),
    }


# ---------------------------------------------------------------------------
# CLOSE-OUTS
# ---------------------------------------------------------------------------
@api.post("/close-out")
async def close_out(body: CloseOutIn, driver: Dict = Depends(get_driver)):
    existing = await db.close_outs.find_one(
        {"driver_id": driver["id"], "client_action_id": body.client_action_id}, {"_id": 0}
    )
    if existing:
        return existing
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver["id"],
        "platform": body.platform,
        "from_ts": body.from_ts,
        "to_ts": body.to_ts,
        "trips": body.trips,
        "gross_amount": body.gross_amount,
        "cash_collected": body.cash_collected,
        "client_action_id": body.client_action_id,
        "created_at": iso(now_utc()),
    }
    await db.close_outs.insert_one(row.copy())
    row.pop("_id", None)
    return row


# ---------------------------------------------------------------------------
# MONEY
# ---------------------------------------------------------------------------
async def _money_for_range(driver_id: str, start: datetime, end: datetime) -> Dict:
    cursor = db.close_outs.find({"driver_id": driver_id}, {"_id": 0})
    per_platform: Dict[str, Dict[str, float]] = {
        p: {"gross": 0.0, "trips": 0, "cash": 0.0} for p in PLATFORMS
    }
    total_cash = 0.0
    for row in [r async for r in cursor]:
        try:
            ts = _parse_iso(row["to_ts"])
        except Exception:
            continue
        if not (start <= ts < end):
            continue
        p = row["platform"]
        if p not in per_platform:
            continue
        per_platform[p]["gross"] += row["gross_amount"]
        per_platform[p]["trips"] += row["trips"]
        per_platform[p]["cash"] += row["cash_collected"]
        total_cash += row["cash_collected"]
    gross = sum(v["gross"] for v in per_platform.values())
    return {"per_platform": per_platform, "gross": gross, "cash_collected": total_cash}


@api.get("/money/today")
async def money_today(driver: Dict = Depends(get_driver)):
    day_start = _start_of_day_utc()
    day_end = day_start + timedelta(days=1)
    today = await _money_for_range(driver["id"], day_start, day_end)
    advance = await db.advances.find_one({"driver_id": driver["id"]}, {"_id": 0})
    advance = advance or {"principal": 0, "daily_recovery": 0, "days_remaining": 0}
    driver_share = round(today["gross"] * DRIVER_SHARE, 2)
    advance_recovery_today = min(advance.get("daily_recovery", 0), driver_share)
    cash_held = round(today["cash_collected"], 2)
    payable = round(driver_share - cash_held - advance_recovery_today, 2)
    return {
        "date": iso(day_start),
        "gross_by_platform": today["per_platform"],
        "gross": round(today["gross"], 2),
        "driver_share": driver_share,
        "share_rate": DRIVER_SHARE,
        "cash_held": cash_held,
        "cash_limit": CASH_LIMIT,
        "cash_over_limit": cash_held > CASH_LIMIT,
        "advance": advance,
        "advance_recovery_today": advance_recovery_today,
        "payable": payable,
    }


@api.get("/money/weekly")
async def money_weekly(driver: Dict = Depends(get_driver)):
    day_start = _start_of_day_utc()
    days = []
    for i in range(6, -1, -1):
        s = day_start - timedelta(days=i)
        e = s + timedelta(days=1)
        m = await _money_for_range(driver["id"], s, e)
        days.append(
            {
                "date": iso(s),
                "gross": round(m["gross"], 2),
                "share": round(m["gross"] * DRIVER_SHARE, 2),
            }
        )
    return {"days": days}


# ---------------------------------------------------------------------------
# REQUESTS
# ---------------------------------------------------------------------------
@api.post("/requests")
async def create_request(body: RequestIn, driver: Dict = Depends(get_driver)):
    existing = await db.requests.find_one(
        {"driver_id": driver["id"], "client_action_id": body.client_action_id}, {"_id": 0}
    )
    if existing:
        return existing
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver["id"],
        "type": body.type,
        "payload": body.payload,
        "state": "pending",
        "created_at": iso(now_utc()),
        "decided_at": None,
        "client_action_id": body.client_action_id,
    }
    await db.requests.insert_one(row.copy())
    row.pop("_id", None)
    return row


@api.get("/requests")
async def list_requests(driver: Dict = Depends(get_driver)):
    cursor = db.requests.find({"driver_id": driver["id"]}, {"_id": 0}).sort("created_at", -1)
    return {"items": [r async for r in cursor]}


# ---------------------------------------------------------------------------
# TRACKING (phone side)
# ---------------------------------------------------------------------------
@api.post("/tracking/ping")
async def phone_ping(
    body: Dict[str, Any], driver: Dict = Depends(get_driver)
):
    # Just record — this is the phone's own 4-min ping, not the tracker feed.
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver["id"],
        "vehicle_id": driver["vehicle_id"],
        "recorded_at": body.get("recorded_at") or iso(now_utc()),
        "received_at": iso(now_utc()),
        "lat": body.get("lat"),
        "lng": body.get("lng"),
        "source": "phone",
    }
    await db.phone_pings.insert_one(row)
    return {"ok": True}


@api.post("/tracking/heartbeat")
async def heartbeat(body: HeartbeatIn, driver: Dict = Depends(get_driver)):
    await db.heartbeats.insert_one(
        {
            "driver_id": driver["id"],
            "ts": body.ts,
            "received_at": iso(now_utc()),
            "permission_ok": body.permission_ok,
            "network_up": body.network_up,
            "battery_pct": body.battery_pct,
        }
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# VEHICLE PINGS — real feed stub + distance computation from mock data
# ---------------------------------------------------------------------------
@api.post("/vehicles/pings/ingest")
async def vehicle_ping_ingest(body: VehiclePingIn):
    """STUB endpoint for the real hardware tracker feed.

    The real integration will POST here with a shared secret; for now we accept
    unauthenticated writes so the demo seed / mock ingester can populate the
    collection. Filter `accuracy_m > 30` at read time.
    """
    row = body.model_dump()
    row["id"] = str(uuid.uuid4())
    row["received_at"] = iso(now_utc())
    await db.vehicle_pings.insert_one(row)
    return {"ok": True, "id": row["id"]}


async def _distance_today(vehicle_id: str, start: datetime, end: datetime) -> float:
    cursor = db.vehicle_pings.find({"vehicle_id": vehicle_id}, {"_id": 0}).sort("recorded_at", 1)
    prev = None
    total_m = 0.0
    async for p in cursor:
        try:
            ts = _parse_iso(p["recorded_at"])
        except Exception:
            continue
        if ts < start or ts >= end:
            continue
        if p.get("accuracy_m", 0) > 30:
            continue
        if prev is not None:
            total_m += _haversine_m(prev["lat"], prev["lng"], p["lat"], p["lng"])
        prev = p
    return total_m / 1000.0


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    from math import radians, sin, cos, asin, sqrt

    r = 6371000.0
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return 2 * r * asin(sqrt(a))


@api.get("/vehicles/{vehicle_id}/latest")
async def vehicle_latest(vehicle_id: str, driver: Dict = Depends(get_driver)):
    row = await db.vehicle_pings.find_one(
        {"vehicle_id": vehicle_id}, {"_id": 0}, sort=[("recorded_at", -1)]
    )
    return row or {}


# ---------------------------------------------------------------------------
# SEEDING
# ---------------------------------------------------------------------------
async def _seed_if_empty() -> None:
    if await db.drivers.count_documents({}) > 0:
        return
    driver_id = str(uuid.uuid4())
    vehicle_id = str(uuid.uuid4())
    await db.vehicles.insert_one(
        {
            "id": vehicle_id,
            "number": "KA-01-EV-0091",
            "model": "Citroën ëC3",
            "current_soc": 62,
            "current_range_km": 195,
        }
    )
    await db.drivers.insert_one(
        {
            "id": driver_id,
            "name": "Ravi Kumar",
            "phone": DEMO_DRIVER_PHONE,
            "vehicle_id": vehicle_id,
            "qr_code": f"RIDE91-DEPOSIT-{driver_id[:8].upper()}",
            "active": True,
        }
    )
    await db.advances.insert_one(
        {
            "driver_id": driver_id,
            "principal": 8000,
            "daily_recovery": 200,
            "days_remaining": 21,
        }
    )
    # Seed a plausible day of vehicle_pings around Bengaluru.
    day_start = _start_of_day_utc()
    # 1 ping every 90 seconds over the last ~8 hours before now.
    base_lat, base_lng = 12.9716, 77.5946  # MG Road
    now = now_utc()
    t = max(day_start, now - timedelta(hours=8))
    lat, lng, soc = base_lat, base_lng, 90.0
    heading = 0.0
    pings = []
    i = 0
    while t < now:
        # random walk (very rough)
        heading += random.uniform(-0.4, 0.4)
        step = 0.00025 * random.uniform(0.4, 1.6)  # ~28m
        import math

        lat += step * math.cos(heading)
        lng += step * math.sin(heading)
        soc -= 0.03  # slow drain
        pings.append(
            {
                "id": str(uuid.uuid4()),
                "vehicle_id": vehicle_id,
                "recorded_at": iso(t),
                "received_at": iso(t + timedelta(seconds=2)),
                "lat": round(lat, 6),
                "lng": round(lng, 6),
                "speed_kmph": round(random.uniform(0, 45), 1),
                "ignition": True,
                "soc_pct": round(max(soc, 20), 1),
                "accuracy_m": round(random.uniform(6, 24), 1),
            }
        )
        t += timedelta(seconds=90)
        i += 1
    if pings:
        await db.vehicle_pings.insert_many(pings)
    # Seed a demo duty timeline (shift started 5h ago on ride91, switched around)
    shift_start = now - timedelta(hours=5)
    duty_events = [
        (shift_start, "ride91"),
        (shift_start + timedelta(hours=1, minutes=20), "uber"),
        (shift_start + timedelta(hours=2, minutes=40), "offline"),
        (shift_start + timedelta(hours=3, minutes=10), "rapido"),
        (shift_start + timedelta(hours=4, minutes=15), "ride91"),
    ]
    for ts, state in duty_events:
        await db.duty_states.insert_one(
            {
                "id": str(uuid.uuid4()),
                "driver_id": driver_id,
                "vehicle_id": vehicle_id,
                "state": state,
                "started_at": iso(ts),
                "lat": base_lat,
                "lng": base_lng,
                "source": "driver",
                "client_action_id": str(uuid.uuid4()),
                "synced_at": iso(ts + timedelta(seconds=3)),
            }
        )
    # Seed close-outs for each block that ended (all except the last).
    for i in range(len(duty_events) - 1):
        (ts_from, state), (ts_to, _next) = duty_events[i], duty_events[i + 1]
        if state in NON_PLATFORM_STATES:
            continue
        gross = round(random.uniform(180, 480), 2)
        cash = round(gross * random.uniform(0.2, 0.6), 2)
        await db.close_outs.insert_one(
            {
                "id": str(uuid.uuid4()),
                "driver_id": driver_id,
                "platform": state,
                "from_ts": iso(ts_from),
                "to_ts": iso(ts_to),
                "trips": random.randint(2, 6),
                "gross_amount": gross,
                "cash_collected": cash,
                "client_action_id": str(uuid.uuid4()),
                "created_at": iso(ts_to),
            }
        )
    # Seed a couple of requests
    await db.requests.insert_many(
        [
            {
                "id": str(uuid.uuid4()),
                "driver_id": driver_id,
                "type": "advance",
                "payload": {"amount": 3000, "reason": "school fees"},
                "state": "approved",
                "created_at": iso(now - timedelta(days=2)),
                "decided_at": iso(now - timedelta(days=1)),
                "client_action_id": str(uuid.uuid4()),
            },
            {
                "id": str(uuid.uuid4()),
                "driver_id": driver_id,
                "type": "holiday",
                "payload": {"date": iso(now + timedelta(days=5)), "reason": "family function"},
                "state": "pending",
                "created_at": iso(now - timedelta(hours=6)),
                "decided_at": None,
                "client_action_id": str(uuid.uuid4()),
            },
        ]
    )
    logger.info("Seeded demo driver %s vehicle %s with %d pings", driver_id, vehicle_id, len(pings))


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@api.get("/")
async def health():
    return {"ok": True, "service": "ride91", "ts": iso(now_utc())}


app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _on_startup() -> None:
    await db.duty_states.create_index([("driver_id", 1), ("started_at", 1)])
    await db.duty_states.create_index([("driver_id", 1), ("client_action_id", 1)], unique=True)
    await db.close_outs.create_index([("driver_id", 1), ("client_action_id", 1)], unique=True)
    await db.requests.create_index([("driver_id", 1), ("client_action_id", 1)], unique=True)
    await db.vehicle_pings.create_index([("vehicle_id", 1), ("recorded_at", 1)])
    await db.sessions.create_index([("token", 1)], unique=True)
    await db.inspections.create_index([("driver_id", 1), ("day_key", 1)], unique=True)
    await db.inspections.create_index(
        [("driver_id", 1), ("client_action_id", 1)], unique=True
    )
    await _seed_if_empty()


@app.on_event("shutdown")
async def _on_shutdown() -> None:
    client.close()
