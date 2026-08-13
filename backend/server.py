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
import math
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
# Ride91 is the employment layer — NOT a dispatch platform. The platform list
# is Uber / Rapido / Ola only.
PLATFORMS = {"uber", "rapido", "ola"}
NON_PLATFORM_STATES = {"offline", "shift_end", "charging"}
DUTY_LAYER = {"start_duty", "end_duty"}
PLATFORM_LAYER = {"uber", "rapido", "ola", "not_online"}
ALL_STATES = PLATFORMS | NON_PLATFORM_STATES | DUTY_LAYER | PLATFORM_LAYER
CASH_LIMIT = 1500  # ₹
DRIVER_SHARE = 0.30
DEMO_DRIVER_PHONE = "+919900000001"
DEMO_OTP = "123456"  # any OTP works; this one is guaranteed

# Business day runs 04:00 IST to 03:59 IST next day. Matches Uber's cut-off.
IST = timezone(timedelta(hours=5, minutes=30))
BUSINESS_DAY_OFFSET_HOURS = 4


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def business_date_from_dt(dt: datetime) -> str:
    """Every timestamp bucketed by business day uses this. 04:00-03:59 IST."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    shifted = dt.astimezone(IST) - timedelta(hours=BUSINESS_DAY_OFFSET_HOURS)
    return shifted.strftime("%Y-%m-%d")


def business_date_now() -> str:
    return business_date_from_dt(now_utc())


def business_day_bounds(business_date: str) -> tuple[datetime, datetime]:
    """UTC bounds for a business-date key ('YYYY-MM-DD')."""
    d = datetime.strptime(business_date, "%Y-%m-%d")
    # 04:00 IST on that date
    start_ist = d.replace(hour=BUSINESS_DAY_OFFSET_HOURS, tzinfo=IST)
    end_ist = start_ist + timedelta(days=1)
    return start_ist.astimezone(timezone.utc), end_ist.astimezone(timezone.utc)


def week_bounds_for_business_date(business_date: str) -> tuple[str, str, int]:
    """Return (mon_key, next_mon_key, days_until_next_mon).
    A Ride91 week is Mon 04:00 → next Mon 03:59, keyed by business_date.
    """
    d = datetime.strptime(business_date, "%Y-%m-%d").date()
    weekday = d.weekday()  # Mon=0
    mon = d - timedelta(days=weekday)
    next_mon = mon + timedelta(days=7)
    days_remaining = (next_mon - d).days
    return mon.strftime("%Y-%m-%d"), next_mon.strftime("%Y-%m-%d"), days_remaining


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
    hub_name: Optional[str] = None
    hub_lat: Optional[float] = None
    hub_lng: Optional[float] = None


class DutyStateIn(BaseModel):
    # Two separate rows land here:
    #   Duty layer:     start_duty / end_duty
    #   Platform layer: uber / rapido / ola / not_online
    #   Support:        offline / charging  (kept for backwards-compat)
    state: Literal[
        "start_duty", "end_duty",
        "uber", "rapido", "ola", "not_online",
        "offline", "shift_end", "charging",
    ]
    started_at: str
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


# ---------------------------------------------------------------------------
# Shift alarms (Part 8)
# ---------------------------------------------------------------------------
# Reason codes are stored as CODES, not free text, so they aggregate.
ALARM_REASONS = {
    "unwell", "family_emergency", "vehicle_problem",
    "transport_problem", "personal", "other",
}


class ShiftScheduleIn(BaseModel):
    """The next shift the driver is expected on. Start alarm fires 1h before.
    End alarm fires dynamically based on driver's live GPS ETA back to hub.
    """
    shift_start: str            # ISO
    shift_type: Literal["day", "night"] = "day"
    hub_id: Optional[str] = None
    shift_end: Optional[str] = None       # ISO — enables shift-end alarm
    end_buffer_min: int = 10              # extra minutes on top of ETA
    client_action_id: str


class AlarmResponseIn(BaseModel):
    schedule_id: str
    phase: Literal["start", "end"] = "start"
    response: Literal["awake", "not_coming", "snooze", "heading_back", "delayed"]
    reason_code: Optional[str] = None       # required if response=not_coming
    reason_note: Optional[str] = None       # free text if reason_code='other'
    back_by: Optional[str] = None           # optional YYYY-MM-DD (start)
    eta_minutes: Optional[float] = None     # optional (end)
    fired_at: str
    responded_at: str
    client_action_id: str


class PlatformCashIn(BaseModel):
    """Screenshot-uploaded, provisional cash figure for one platform/day."""
    platform: Literal["uber", "rapido", "ola"]
    cash_amount: float
    business_date: Optional[str] = None      # defaults to today
    image_ref: Optional[str] = None
    confidence: Optional[float] = None
    client_action_id: str


class QrPaymentIn(BaseModel):
    """Razorpay-tracked payments. Fares vs deposits are tagged apart."""
    amount: float
    type: Literal["fare", "deposit"]
    reference: str
    platform: Optional[Literal["uber", "rapido", "ola"]] = None
    occurred_at: Optional[str] = None
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
    soc_pct: Optional[float] = None      # NULLABLE — device not on every car yet
    odometer_km: Optional[float] = None  # NULLABLE
    accuracy_m: float


class InspectionIn(BaseModel):
    dashboard_photo_b64: str          # data URL or raw base64 of the JPEG
    exterior_video_b64: str           # data URL or raw base64 of the mp4/webm
    exterior_video_mime: str = "video/mp4"
    client_action_id: str


class GoOnlineCaptureIn(BaseModel):
    """The 20s guided walk-around video + one selfie, captured once per
    business day before the driver picks their first platform. Includes
    GPS at capture start and end so ops can detect fraudulent submissions
    where the driver isn't near the vehicle.
    """
    walkaround_video_b64: str         # data URL or raw base64 of the mp4/webm
    walkaround_video_mime: str = "video/mp4"
    selfie_photo_b64: str             # data URL or raw base64 of the JPEG
    walkaround_started_at: str        # ISO
    walkaround_ended_at: str          # ISO
    start_lat: float
    start_lng: float
    end_lat: float
    end_lng: float
    client_action_id: str


# ---------------------------------------------------------------------------
# Documents & consents (Part 9)
# ---------------------------------------------------------------------------
# Document types the ops team currently tracks for every driver. We seed
# empty placeholders on first login so the UI always has a row per type.
DOCUMENT_TYPES = {
    "driving_licence",
    "vehicle_rc",
    "insurance",
    "puc",
    "permit",
    "aadhaar",
    "pan",
}

# Consent kinds the driver can grant / withdraw individually.
CONSENT_KINDS = {
    "location_tracking",
    "camera_and_video",
    "cash_handling",
    "communications",
    "terms_of_service",
}


class DocumentUpsertIn(BaseModel):
    type: Literal[
        "driving_licence", "vehicle_rc", "insurance", "puc", "permit", "aadhaar", "pan"
    ]
    number: Optional[str] = None
    expires_on: Optional[str] = None       # YYYY-MM-DD
    image_b64: Optional[str] = None        # data URL or raw base64
    client_action_id: str


class ConsentIn(BaseModel):
    kind: Literal[
        "location_tracking", "camera_and_video", "cash_handling",
        "communications", "terms_of_service",
    ]
    granted: bool
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


def _driver_out(driver: Dict, vehicle: Optional[Dict]) -> Dict:
    return DriverOut(
        id=driver["id"],
        name=driver["name"],
        phone=driver["phone"],
        vehicle_id=driver["vehicle_id"],
        vehicle_number=vehicle["number"] if vehicle else "",
        qr_code=driver.get("qr_code", ""),
        hub_name=driver.get("hub_name"),
        hub_lat=driver.get("hub_lat"),
        hub_lng=driver.get("hub_lng"),
    ).model_dump()


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
        "driver": _driver_out(driver, vehicle),
    }


@api.get("/auth/me")
async def me(driver: Dict = Depends(get_driver)):
    vehicle = await db.vehicles.find_one({"id": driver["vehicle_id"]}, {"_id": 0})
    return {
        "driver": _driver_out(driver, vehicle),
        "vehicle": {k: v for k, v in (vehicle or {}).items()},
    }


# ---------------------------------------------------------------------------
# PRE-SHIFT INSPECTION
# ---------------------------------------------------------------------------
def _ist_day_key() -> str:
    """Business day (04:00–03:59 IST) used everywhere as the daily bucket."""
    return business_date_now()


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
# GO-ONLINE CAPTURE (Part 7) — 20 s guided walkaround + selfie + GPS gate.
# One capture per business day per driver. The client (Home tab) hard-gates
# platform selection on this endpoint's status.
# ---------------------------------------------------------------------------
HUB_HARD_BLOCK_KM = 30.0       # Beyond this, cannot go online at all.
HUB_WARN_KM = 3.0              # Beyond this, UI warns; still allowed.
CAPTURE_MAX_MOVEMENT_M = 60.0  # Between start and end of the 20s recording.


@api.post("/go-online-capture")
async def create_go_online_capture(
    body: GoOnlineCaptureIn, driver: Dict = Depends(get_driver)
):
    # Dedup on client_action_id — the sync queue may retry.
    existing = await db.go_online_captures.find_one(
        {"driver_id": driver["id"], "client_action_id": body.client_action_id},
        {"_id": 0, "walkaround_video_b64": 0, "selfie_photo_b64": 0},
    )
    if existing:
        return {"completed": True, **existing}
    day_key = _ist_day_key()
    dup = await db.go_online_captures.find_one(
        {"driver_id": driver["id"], "day_key": day_key},
        {"_id": 0, "walkaround_video_b64": 0, "selfie_photo_b64": 0},
    )
    if dup:
        return {"completed": True, **dup, "already_done_today": True}
    # Duration must be within a sane range (18–30s inclusive of jitter).
    try:
        started = _parse_iso(body.walkaround_started_at)
        ended = _parse_iso(body.walkaround_ended_at)
    except Exception:
        raise HTTPException(400, "bad_timestamps")
    duration_s = (ended - started).total_seconds()
    if duration_s < 15 or duration_s > 60:
        raise HTTPException(400, "duration_out_of_range")
    # Movement between endpoints — anti-fraud check.
    movement_m = _haversine_m(body.start_lat, body.start_lng, body.end_lat, body.end_lng)
    # Distance from home hub (if known).
    hub_lat = driver.get("hub_lat")
    hub_lng = driver.get("hub_lng")
    distance_from_hub_km: Optional[float] = None
    if hub_lat is not None and hub_lng is not None:
        distance_from_hub_km = round(
            _haversine_km(body.start_lat, body.start_lng, hub_lat, hub_lng), 3
        )
        if distance_from_hub_km > HUB_HARD_BLOCK_KM:
            raise HTTPException(
                403,
                {
                    "code": "too_far_from_hub",
                    "hub_km": distance_from_hub_km,
                    "limit_km": HUB_HARD_BLOCK_KM,
                },
            )
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver["id"],
        "vehicle_id": driver["vehicle_id"],
        "day_key": day_key,
        "walkaround_video_b64": body.walkaround_video_b64,
        "walkaround_video_mime": body.walkaround_video_mime,
        "selfie_photo_b64": body.selfie_photo_b64,
        "walkaround_started_at": body.walkaround_started_at,
        "walkaround_ended_at": body.walkaround_ended_at,
        "duration_s": round(duration_s, 2),
        "start_lat": body.start_lat,
        "start_lng": body.start_lng,
        "end_lat": body.end_lat,
        "end_lng": body.end_lng,
        "movement_m": round(movement_m, 2),
        "distance_from_hub_km": distance_from_hub_km,
        "hub_warn": bool(distance_from_hub_km is not None and distance_from_hub_km > HUB_WARN_KM),
        "review_flag_movement": movement_m > CAPTURE_MAX_MOVEMENT_M,
        "created_at": iso(now_utc()),
        "client_action_id": body.client_action_id,
    }
    await db.go_online_captures.insert_one(row.copy())
    row.pop("_id", None)
    # Never echo the base64 back — clients only need the meta.
    row.pop("walkaround_video_b64", None)
    row.pop("selfie_photo_b64", None)
    return {"completed": True, **row}


@api.get("/go-online-capture/today")
async def go_online_capture_today(driver: Dict = Depends(get_driver)):
    day_key = _ist_day_key()
    row = await db.go_online_captures.find_one(
        {"driver_id": driver["id"], "day_key": day_key},
        {"_id": 0, "walkaround_video_b64": 0, "selfie_photo_b64": 0},
    )
    if not row:
        return {"completed": False, "day_key": day_key}
    return {"completed": True, **row}


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
    # HARD GATE: starting duty requires today's inspection. Platform switches
    # do NOT gate — they only make sense once on-duty anyway, and the client
    # blocks them until on-duty.
    if body.state == "start_duty":
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
        "business_date": business_date_from_dt(_parse_iso(body.started_at) if body.started_at else now_utc()),
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
    # Business day 04:00 IST → 03:59 next day.
    today_bd = business_date_now()
    day_start, day_end = business_day_bounds(today_bd)
    segs = await _segments_for_day(driver["id"], day_start, day_end)
    totals: Dict[str, int] = {}
    for s in segs:
        totals[s["state"]] = totals.get(s["state"], 0) + s["seconds"]
    working_seconds = sum(totals.get(p, 0) for p in PLATFORMS)
    # On-duty time = anything after start_duty and before end_duty. Simpler:
    # the sum of platform + not_online + charging segments once start_duty
    # has been seen for the day.
    on_duty_seconds = (
        working_seconds
        + totals.get("not_online", 0)
        + totals.get("charging", 0)
    )
    # Current state = most recent row across the day.
    current = segs[-1]["state"] if segs else None
    # Is the driver ON DUTY? Yes iff most recent start_duty is more recent
    # than most recent end_duty within the business day.
    on_duty = False
    for s in reversed(segs):
        if s["state"] == "end_duty":
            on_duty = False
            break
        if s["state"] == "start_duty":
            on_duty = True
            break
    # Current platform (of the four) is the most recent platform row if it
    # came after the last start_duty.
    current_platform = None
    if on_duty:
        for s in reversed(segs):
            if s["state"] == "start_duty":
                break
            if s["state"] in PLATFORMS or s["state"] == "not_online":
                current_platform = s["state"]
                break
    distance_km = await _distance_today(driver["vehicle_id"], day_start, day_end)
    return {
        "segments": segs,
        "totals_seconds": totals,
        "on_duty": on_duty,
        "current_platform": current_platform,
        "on_duty_seconds": on_duty_seconds,
        "working_seconds": working_seconds,
        "current_state": current,
        "distance_km": round(distance_km, 2),
        "business_date": today_bd,
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
async def _fetch_platform_cash(
    driver_id: str, from_bd: str, to_bd: str
) -> List[Dict]:
    """platform_cash rows falling within [from_bd, to_bd] (business dates)."""
    cursor = db.platform_cash.find(
        {
            "driver_id": driver_id,
            "business_date": {"$gte": from_bd, "$lt": to_bd},
        },
        {"_id": 0},
    ).sort("business_date", 1)
    return [r async for r in cursor]


async def _fetch_qr_payments(
    driver_id: str, from_bd: str, to_bd: str
) -> List[Dict]:
    cursor = db.qr_payments.find(
        {
            "driver_id": driver_id,
            "business_date": {"$gte": from_bd, "$lt": to_bd},
        },
        {"_id": 0},
    )
    return [r async for r in cursor]


# ---------------------------------------------------------------------------
# SHIFT ALARMS (Part 8) — server contract for the native Android AlarmManager
# module. Native side fires locally; server records schedule + responses.
# ---------------------------------------------------------------------------
@api.post("/shift-alarm/schedule")
async def schedule_shift_alarm(body: ShiftScheduleIn, driver: Dict = Depends(get_driver)):
    existing = await db.shift_schedules.find_one(
        {"driver_id": driver["id"], "client_action_id": body.client_action_id},
        {"_id": 0},
    )
    if existing:
        return existing
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver["id"],
        "shift_start": body.shift_start,
        "shift_type": body.shift_type,
        "hub_id": body.hub_id,
        "alarm_fires_at": iso(_parse_iso(body.shift_start) - timedelta(hours=1)),
        "state": "scheduled",             # scheduled | responded | no_response
        # End-alarm fields — populated only when shift_end is provided.
        "shift_end": body.shift_end,
        "end_buffer_min": body.end_buffer_min if body.shift_end else None,
        "end_state": "scheduled" if body.shift_end else "na",
        "created_at": iso(now_utc()),
        "client_action_id": body.client_action_id,
    }
    await db.shift_schedules.insert_one(row.copy())
    row.pop("_id", None)
    return row


@api.get("/shift-alarm/next")
async def next_shift_alarm(driver: Dict = Depends(get_driver)):
    """Native side calls this on app open / boot to (re)schedule the alarm.
    Returns the MOST RECENTLY created schedule that still has an active
    phase (start or end). This mirrors the driver's mental model — the
    latest schedule overrides an older stale one on the same day.
    """
    row = await db.shift_schedules.find_one(
        {
            "driver_id": driver["id"],
            "$or": [
                {"state": {"$in": ["scheduled", "no_response"]}},
                {"end_state": {"$in": ["scheduled", "no_response"]}},
            ],
        },
        {"_id": 0},
        sort=[("created_at", -1)],
    )
    return row or {}


# ---------------------------------------------------------------------------
# Shift-end ETA — recomputed on each poll from live GPS to hub.
# Alarm fires when (shift_end - now) <= eta_minutes + end_buffer_min.
# ---------------------------------------------------------------------------


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371.0088
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(a))


# Conservative Bengaluru city assumption — used when we don't have a fresh
# average from the driver's own recent pings.
DEFAULT_ETA_SPEED_KMPH = 22.0
MIN_ETA_SPEED_KMPH = 12.0
MAX_ETA_SPEED_KMPH = 45.0


async def _avg_speed_from_pings(vehicle_id: str) -> float:
    """Average of the last 20 non-zero-speed pings for this vehicle.
    Falls back to DEFAULT_ETA_SPEED_KMPH when we don't have enough data."""
    cursor = db.vehicle_pings.find(
        {"vehicle_id": vehicle_id, "speed_kmph": {"$gt": 3}},
        {"_id": 0, "speed_kmph": 1},
    ).sort("recorded_at", -1).limit(20)
    speeds = [p["speed_kmph"] async for p in cursor]
    if len(speeds) < 5:
        return DEFAULT_ETA_SPEED_KMPH
    avg = sum(speeds) / len(speeds)
    return max(MIN_ETA_SPEED_KMPH, min(MAX_ETA_SPEED_KMPH, avg))


@api.get("/shift-alarm/end-eta")
async def shift_end_eta(
    lat: Optional[float] = None,
    lng: Optional[float] = None,
    driver: Dict = Depends(get_driver),
):
    row = await db.shift_schedules.find_one(
        {
            "driver_id": driver["id"],
            "shift_end": {"$ne": None},
            "end_state": {"$in": ["scheduled", "no_response"]},
        },
        {"_id": 0},
        sort=[("created_at", -1)],
    )
    if not row:
        return {"has_end_alarm": False}
    hub_lat = driver.get("hub_lat")
    hub_lng = driver.get("hub_lng")
    if hub_lat is None or hub_lng is None:
        return {
            "has_end_alarm": True,
            "has_hub": False,
            "schedule_id": row["id"],
            "shift_end": row["shift_end"],
        }
    # Live position: query param > last vehicle ping > hub itself (0km).
    cur_lat = lat
    cur_lng = lng
    if cur_lat is None or cur_lng is None:
        last = await db.vehicle_pings.find_one(
            {"vehicle_id": driver["vehicle_id"]},
            {"_id": 0},
            sort=[("recorded_at", -1)],
        )
        if last:
            cur_lat = last["lat"]
            cur_lng = last["lng"]
    if cur_lat is None or cur_lng is None:
        cur_lat = hub_lat
        cur_lng = hub_lng
    distance_km = _haversine_km(cur_lat, cur_lng, hub_lat, hub_lng)
    avg_speed = await _avg_speed_from_pings(driver["vehicle_id"])
    eta_min = (distance_km / avg_speed) * 60 if avg_speed > 0 else 0
    buffer_min = row.get("end_buffer_min") or 10
    shift_end_dt = _parse_iso(row["shift_end"])
    alarm_at_dt = shift_end_dt - timedelta(minutes=eta_min + buffer_min)
    now_dt = now_utc()
    remaining_min = (shift_end_dt - now_dt).total_seconds() / 60
    return {
        "has_end_alarm": True,
        "has_hub": True,
        "schedule_id": row["id"],
        "shift_end": row["shift_end"],
        "hub_lat": hub_lat,
        "hub_lng": hub_lng,
        "hub_name": driver.get("hub_name"),
        "current_lat": cur_lat,
        "current_lng": cur_lng,
        "distance_km": round(distance_km, 3),
        "avg_speed_kmph": round(avg_speed, 1),
        "eta_minutes": round(eta_min, 1),
        "buffer_minutes": buffer_min,
        "remaining_minutes": round(remaining_min, 1),
        "alarm_at": iso(alarm_at_dt),
        "should_alarm_now": alarm_at_dt <= now_dt <= shift_end_dt,
    }


@api.post("/shift-alarm/response")
async def record_alarm_response(body: AlarmResponseIn, driver: Dict = Depends(get_driver)):
    if body.response == "not_coming":
        if not body.reason_code or body.reason_code not in ALARM_REASONS:
            raise HTTPException(400, "reason_required")
    # End-phase-specific response validation.
    if body.phase == "end" and body.response not in {"heading_back", "delayed", "snooze"}:
        raise HTTPException(400, "invalid_response_for_end_phase")
    if body.phase == "start" and body.response not in {"awake", "not_coming", "snooze"}:
        raise HTTPException(400, "invalid_response_for_start_phase")
    existing = await db.alarm_responses.find_one(
        {"driver_id": driver["id"], "client_action_id": body.client_action_id},
        {"_id": 0},
    )
    if existing:
        return existing
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver["id"],
        "schedule_id": body.schedule_id,
        "phase": body.phase,
        "response": body.response,
        "reason_code": body.reason_code,
        "reason_note": body.reason_note if body.reason_code == "other" else None,
        "back_by": body.back_by,
        "eta_minutes": body.eta_minutes,
        "fired_at": body.fired_at,
        "responded_at": body.responded_at,
        "created_at": iso(now_utc()),
        "client_action_id": body.client_action_id,
    }
    await db.alarm_responses.insert_one(row.copy())
    # Advance the correct phase's state on the schedule.
    if body.phase == "start" and body.response in ("awake", "not_coming"):
        await db.shift_schedules.update_one(
            {"id": body.schedule_id, "driver_id": driver["id"]},
            {"$set": {"state": "responded"}},
        )
    if body.phase == "end" and body.response in ("heading_back", "delayed"):
        await db.shift_schedules.update_one(
            {"id": body.schedule_id, "driver_id": driver["id"]},
            {"$set": {"end_state": "responded"}},
        )
    row.pop("_id", None)
    return row


@api.get("/shift-alarm/responses")
async def list_alarm_responses(driver: Dict = Depends(get_driver)):
    cursor = db.alarm_responses.find(
        {"driver_id": driver["id"]}, {"_id": 0}
    ).sort("responded_at", -1)
    return {"items": [r async for r in cursor]}


# ---------------------------------------------------------------------------
# DOCUMENT WALLET (Part 9)
# ---------------------------------------------------------------------------
DOCUMENT_LABELS = {
    "driving_licence": "Driving licence",
    "vehicle_rc": "Vehicle RC",
    "insurance": "Vehicle insurance",
    "puc": "Pollution certificate (PUC)",
    "permit": "Commercial permit",
    "aadhaar": "Aadhaar",
    "pan": "PAN card",
}


def _document_status(expires_on: Optional[str]) -> str:
    """`expired`, `expiring_soon` (<=30 days), `ok`, or `missing`."""
    if not expires_on:
        return "missing"
    try:
        exp = datetime.strptime(expires_on, "%Y-%m-%d").date()
    except ValueError:
        return "missing"
    today = now_utc().astimezone(IST).date()
    delta = (exp - today).days
    if delta < 0:
        return "expired"
    if delta <= 30:
        return "expiring_soon"
    return "ok"


async def _ensure_document_placeholders(driver_id: str) -> None:
    """Insert one row per required document type on first read, so the UI
    can always render a full grid. Never overwrites existing rows."""
    existing = {
        d["type"]
        async for d in db.documents.find(
            {"driver_id": driver_id}, {"_id": 0, "type": 1}
        )
    }
    to_add = DOCUMENT_TYPES - existing
    if not to_add:
        return
    now = iso(now_utc())
    await db.documents.insert_many(
        [
            {
                "id": str(uuid.uuid4()),
                "driver_id": driver_id,
                "type": t,
                "number": None,
                "expires_on": None,
                "image_b64": None,
                "verified": False,
                "created_at": now,
                "updated_at": now,
            }
            for t in to_add
        ]
    )


@api.get("/documents")
async def list_documents(driver: Dict = Depends(get_driver)):
    await _ensure_document_placeholders(driver["id"])
    cursor = db.documents.find({"driver_id": driver["id"]}, {"_id": 0})
    rows: List[Dict[str, Any]] = []
    async for r in cursor:
        r["label"] = DOCUMENT_LABELS.get(r["type"], r["type"])
        r["status"] = _document_status(r.get("expires_on"))
        # Never leak the base64 payload on list — it's large and clients
        # ask for the full record via GET /documents/{id}.
        r.pop("image_b64", None)
        rows.append(r)
    # Sort: expired first, then expiring_soon, then ok, then missing.
    order = {"expired": 0, "expiring_soon": 1, "ok": 2, "missing": 3}
    rows.sort(key=lambda r: (order.get(r["status"], 4), r.get("expires_on") or "z"))
    return {"items": rows}


@api.get("/documents/{document_id}")
async def get_document(document_id: str, driver: Dict = Depends(get_driver)):
    row = await db.documents.find_one(
        {"id": document_id, "driver_id": driver["id"]}, {"_id": 0}
    )
    if not row:
        raise HTTPException(404, "document_not_found")
    row["label"] = DOCUMENT_LABELS.get(row["type"], row["type"])
    row["status"] = _document_status(row.get("expires_on"))
    return row


@api.post("/documents")
async def upsert_document(body: DocumentUpsertIn, driver: Dict = Depends(get_driver)):
    # Idempotent: dedupe on (driver_id, client_action_id).
    prior = await db.documents.find_one(
        {"driver_id": driver["id"], "client_action_id": body.client_action_id},
        {"_id": 0},
    )
    if prior:
        prior["label"] = DOCUMENT_LABELS.get(prior["type"], prior["type"])
        prior["status"] = _document_status(prior.get("expires_on"))
        prior.pop("image_b64", None)
        return prior
    # Validate expires_on shape.
    if body.expires_on:
        try:
            datetime.strptime(body.expires_on, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(400, "expires_on_must_be_yyyy_mm_dd")
    existing = await db.documents.find_one(
        {"driver_id": driver["id"], "type": body.type}, {"_id": 0}
    )
    now = iso(now_utc())
    if existing:
        update = {
            "number": body.number if body.number is not None else existing.get("number"),
            "expires_on": body.expires_on if body.expires_on is not None else existing.get("expires_on"),
            "image_b64": body.image_b64 if body.image_b64 is not None else existing.get("image_b64"),
            "verified": False,   # Re-uploads require re-verification.
            "updated_at": now,
            "client_action_id": body.client_action_id,
        }
        await db.documents.update_one(
            {"id": existing["id"], "driver_id": driver["id"]}, {"$set": update}
        )
        row = {**existing, **update}
    else:
        row = {
            "id": str(uuid.uuid4()),
            "driver_id": driver["id"],
            "type": body.type,
            "number": body.number,
            "expires_on": body.expires_on,
            "image_b64": body.image_b64,
            "verified": False,
            "created_at": now,
            "updated_at": now,
            "client_action_id": body.client_action_id,
        }
        await db.documents.insert_one(row.copy())
        row.pop("_id", None)
    row["label"] = DOCUMENT_LABELS.get(row["type"], row["type"])
    row["status"] = _document_status(row.get("expires_on"))
    # Don't echo the base64 image payload back — it's already stored.
    row.pop("image_b64", None)
    return row


@api.get("/documents/expiring/summary")
async def documents_expiring_summary(driver: Dict = Depends(get_driver)):
    await _ensure_document_placeholders(driver["id"])
    counts = {"expired": 0, "expiring_soon": 0, "ok": 0, "missing": 0}
    cursor = db.documents.find({"driver_id": driver["id"]}, {"_id": 0, "expires_on": 1})
    async for r in cursor:
        counts[_document_status(r.get("expires_on"))] += 1
    counts["needs_attention"] = counts["expired"] + counts["expiring_soon"] + counts["missing"]
    return counts


# ---------------------------------------------------------------------------
# CONSENTS (Part 9)
# ---------------------------------------------------------------------------
CONSENT_LABELS = {
    "location_tracking": "Location tracking during duty",
    "camera_and_video": "Camera & video capture for inspections",
    "cash_handling": "Handling and reconciling cash on our behalf",
    "communications": "Operational SMS / WhatsApp / email",
    "terms_of_service": "Ride91 driver terms of service",
}


async def _record_consent(
    driver_id: str, kind: str, granted: bool, client_action_id: str
) -> Dict[str, Any]:
    """Append-only. Each grant / withdrawal is its own row so we retain
    the full audit trail. The 'current' state is the newest row per kind.
    """
    prior = await db.consent_events.find_one(
        {"driver_id": driver_id, "client_action_id": client_action_id}, {"_id": 0}
    )
    if prior:
        return prior
    now = iso(now_utc())
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver_id,
        "kind": kind,
        "granted": granted,
        "occurred_at": now,
        "client_action_id": client_action_id,
    }
    await db.consent_events.insert_one(row.copy())
    row.pop("_id", None)
    return row


async def _current_consents(driver_id: str) -> List[Dict[str, Any]]:
    # Get the newest event per kind by iterating newest-first once.
    cursor = db.consent_events.find(
        {"driver_id": driver_id}, {"_id": 0}
    ).sort("occurred_at", -1)
    seen: Dict[str, Dict[str, Any]] = {}
    async for e in cursor:
        if e["kind"] not in seen:
            seen[e["kind"]] = e
    out: List[Dict[str, Any]] = []
    for kind in CONSENT_KINDS:
        latest = seen.get(kind)
        out.append(
            {
                "kind": kind,
                "label": CONSENT_LABELS[kind],
                "granted": bool(latest and latest["granted"]),
                "last_change_at": latest["occurred_at"] if latest else None,
            }
        )
    # Sort ungranted-first so the driver sees anything they've withdrawn on top.
    out.sort(key=lambda x: (x["granted"], x["kind"]))
    return out


@api.get("/consents")
async def list_consents(driver: Dict = Depends(get_driver)):
    return {"items": await _current_consents(driver["id"])}


@api.post("/consents")
async def upsert_consent(body: ConsentIn, driver: Dict = Depends(get_driver)):
    await _record_consent(driver["id"], body.kind, body.granted, body.client_action_id)
    return {"items": await _current_consents(driver["id"])}


@api.get("/consents/history")
async def consent_history(driver: Dict = Depends(get_driver)):
    cursor = db.consent_events.find(
        {"driver_id": driver["id"]}, {"_id": 0}
    ).sort("occurred_at", -1)
    return {"items": [r async for r in cursor]}


# ---------------------------------------------------------------------------
# PLATFORM CASH (screenshot upload → provisional, or fleet job → settled)
# ---------------------------------------------------------------------------
@api.post("/platform-cash")
async def add_platform_cash(body: PlatformCashIn, driver: Dict = Depends(get_driver)):
    existing = await db.platform_cash.find_one(
        {"driver_id": driver["id"], "client_action_id": body.client_action_id},
        {"_id": 0},
    )
    if existing:
        return existing
    bd = body.business_date or business_date_now()
    start, end = business_day_bounds(bd)
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver["id"],
        "platform": body.platform,
        "cash_amount": round(body.cash_amount, 2),
        "business_date": bd,
        "window_start": iso(start),
        "window_end": iso(end),
        "source": "ocr",
        "status": "provisional",
        "image_ref": body.image_ref,
        "confidence": body.confidence,
        "client_action_id": body.client_action_id,
        "created_at": iso(now_utc()),
    }
    await db.platform_cash.insert_one(row.copy())
    row.pop("_id", None)
    return row


# ---------------------------------------------------------------------------
# QR PAYMENTS (Razorpay side effect). Deposits tagged apart from fares.
# ---------------------------------------------------------------------------
@api.post("/qr-payment")
async def add_qr_payment(body: QrPaymentIn, driver: Dict = Depends(get_driver)):
    existing = await db.qr_payments.find_one(
        {"driver_id": driver["id"], "client_action_id": body.client_action_id},
        {"_id": 0},
    )
    if existing:
        return existing
    occurred_at = body.occurred_at or iso(now_utc())
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver["id"],
        "amount": round(body.amount, 2),
        "type": body.type,          # 'fare' or 'deposit'
        "reference": body.reference,
        "platform": body.platform,
        "occurred_at": occurred_at,
        "business_date": business_date_from_dt(_parse_iso(occurred_at)),
        "client_action_id": body.client_action_id,
        "created_at": iso(now_utc()),
    }
    await db.qr_payments.insert_one(row.copy())
    row.pop("_id", None)
    return row


# ---------------------------------------------------------------------------
# MONEY
# ---------------------------------------------------------------------------
def _empty_platform_map() -> Dict[str, Dict]:
    return {p: {"cash_collected": 0.0, "status": "pending"} for p in PLATFORMS}


async def _cash_snapshot(driver_id: str, from_bd: str, to_bd: str) -> Dict:
    pc = await _fetch_platform_cash(driver_id, from_bd, to_bd)
    qr = await _fetch_qr_payments(driver_id, from_bd, to_bd)
    per_platform = _empty_platform_map()
    for r in pc:
        p = r["platform"]
        if p not in per_platform:
            continue
        per_platform[p]["cash_collected"] += r["cash_amount"]
        per_platform[p]["status"] = r["status"]
    total_cash_fares = sum(v["cash_collected"] for v in per_platform.values())
    qr_fares = sum(r["amount"] for r in qr if r["type"] == "fare")
    deposits = sum(r["amount"] for r in qr if r["type"] == "deposit")
    cash_in_hand = round(total_cash_fares - qr_fares - deposits, 2)
    return {
        "per_platform": per_platform,
        "total_cash_fares": round(total_cash_fares, 2),
        "qr_fares": round(qr_fares, 2),
        "deposits": round(deposits, 2),
        "cash_in_hand": cash_in_hand,
    }


@api.get("/money/today")
async def money_today(driver: Dict = Depends(get_driver)):
    today_bd = business_date_now()
    tomorrow_bd = (
        datetime.strptime(today_bd, "%Y-%m-%d").date() + timedelta(days=1)
    ).strftime("%Y-%m-%d")
    snap = await _cash_snapshot(driver["id"], today_bd, tomorrow_bd)
    cash = snap["cash_in_hand"]
    return {
        "business_date": today_bd,
        "per_platform": snap["per_platform"],       # includes 'status' per platform
        "total_cash_fares": snap["total_cash_fares"],
        "qr_fares": snap["qr_fares"],
        "deposits": snap["deposits"],
        "cash_in_hand": cash,
        "cash_limit": CASH_LIMIT,
        "cash_over_limit": cash > CASH_LIMIT,
        "you_owe": max(0.0, -cash),
    }


@api.get("/money/week")
async def money_week(driver: Dict = Depends(get_driver)):
    """Card 1 driver of the Money screen: the Monday payout view."""
    today_bd = business_date_now()
    mon_bd, next_mon_bd, days_remaining = week_bounds_for_business_date(today_bd)
    pc = await _fetch_platform_cash(driver["id"], mon_bd, next_mon_bd)

    # Aggregate per platform per business_date so we can label settled vs
    # provisional. Note: earnings gross is the FLEET statement number for
    # settled rows; for provisional rows we only have cash figures from OCR
    # (no gross), so gross==cash for provisional (best available approximation).
    per_platform: Dict[str, Dict] = {
        p: {"settled_gross": 0.0, "provisional_gross": 0.0} for p in PLATFORMS
    }
    for r in pc:
        p = r["platform"]
        if p not in per_platform:
            continue
        # If a settlement row has explicit gross use it, else fall back to cash
        gross = r.get("gross_amount", r["cash_amount"])
        if r["status"] == "settled":
            per_platform[p]["settled_gross"] += gross
        else:
            per_platform[p]["provisional_gross"] += gross

    total_settled = sum(v["settled_gross"] for v in per_platform.values())
    total_prov = sum(v["provisional_gross"] for v in per_platform.values())
    est_gross = total_settled + total_prov
    driver_share = round(est_gross * DRIVER_SHARE, 2)

    # Cash held right now (not window-scoped — deposits carry across days)
    today_snap = await _cash_snapshot(driver["id"], today_bd, next_mon_bd)
    cash_held = max(0.0, today_snap["cash_in_hand"])

    advance = await db.advances.find_one({"driver_id": driver["id"]}, {"_id": 0})
    advance = advance or {"principal": 0, "daily_recovery": 0, "days_remaining": 0}
    weekly_advance_recovery = min(
        advance.get("daily_recovery", 0) * 7, driver_share
    )
    payable_est = round(driver_share - cash_held - weekly_advance_recovery, 2)

    return {
        "week_start": mon_bd,
        "week_end_exclusive": next_mon_bd,
        "days_remaining": days_remaining,
        "per_platform": per_platform,
        "total_settled": round(total_settled, 2),
        "total_provisional": round(total_prov, 2),
        "estimated_gross": round(est_gross, 2),
        "driver_share": driver_share,
        "share_rate": DRIVER_SHARE,
        "cash_held": round(cash_held, 2),
        "advance": advance,
        "advance_recovery_week": round(weekly_advance_recovery, 2),
        "payable_estimate": payable_est,
    }


@api.get("/money/weekly")
async def money_weekly(driver: Dict = Depends(get_driver)):
    """7-day earnings bar-chart driver. Reads platform_cash bucketed by
    business_date. Never sums across midnight-based days."""
    today_bd = business_date_now()
    today_d = datetime.strptime(today_bd, "%Y-%m-%d").date()
    from_bd = (today_d - timedelta(days=6)).strftime("%Y-%m-%d")
    to_bd = (today_d + timedelta(days=1)).strftime("%Y-%m-%d")
    pc = await _fetch_platform_cash(driver["id"], from_bd, to_bd)
    by_day: Dict[str, float] = {}
    for r in pc:
        by_day.setdefault(r["business_date"], 0.0)
        by_day[r["business_date"]] += r.get("gross_amount", r["cash_amount"])
    days = []
    for i in range(6, -1, -1):
        d = today_d - timedelta(days=i)
        key = d.strftime("%Y-%m-%d")
        gross = round(by_day.get(key, 0.0), 2)
        days.append({"business_date": key, "gross": gross, "share": round(gross * DRIVER_SHARE, 2)})
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


# ---------------------------------------------------------------------------
# EARNINGS SCREENSHOT EXTRACTION (Gemini 3 Flash via emergentintegrations)
# ---------------------------------------------------------------------------
class EarningsExtractIn(BaseModel):
    platform: Literal["uber", "rapido"]
    image_base64: str          # raw base64 (no data URL prefix required)
    mime: str = "image/jpeg"
    client_action_id: str


@api.post("/earnings/extract")
async def earnings_extract(body: EarningsExtractIn, driver: Dict = Depends(get_driver)):
    """Read an Uber/Rapido earnings screenshot and return parsed numbers.

    Nothing is written to the ledger here — the client shows the driver a
    confirmation sheet with the extracted values, and on Save it POSTs to
    /api/close-out. This keeps the driver in control of what enters the books.
    """
    from emergentintegrations.llm.chat import LlmChat, UserMessage, ImageContent
    import json as _json
    import re as _re

    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise HTTPException(500, "llm_key_missing")

    # Strip data-URL prefix if the client sent one.
    b64 = body.image_base64
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[-1]

    system = (
        "You extract earnings numbers from Indian ride-hailing driver-app "
        "screenshots (Uber Driver, Rapido Captain). Reply with STRICT JSON "
        "only — no prose, no code fences. Numeric fields must be numbers, "
        "not strings. If a field is not visible, use null.\n\n"
        "Schema:\n"
        "{\n"
        '  "gross_amount": number|null,   // total earnings shown on the screen, in INR\n'
        '  "trips": number|null,          // total trips/rides count if visible\n'
        '  "cash_collected": number|null, // cash-collected total if visible (else null)\n'
        '  "period_hint": string|null,    // e.g. "Today", "Week", "24 Aug"\n'
        '  "platform_detected": string|null,  // "uber" | "rapido" | null\n'
        '  "confidence": number           // 0.0–1.0\n'
        "}"
    )
    prompt = (
        f"This is a {body.platform.upper()} driver-app screenshot. "
        "Extract today's or the visible period's earnings and reply as JSON."
    )
    chat = LlmChat(
        api_key=api_key,
        session_id=f"earnings-{body.client_action_id}",
        system_message=system,
    ).with_model("gemini", "gemini-3-flash-preview")

    try:
        resp = await chat.send_message(
            UserMessage(text=prompt, file_contents=[ImageContent(image_base64=b64)])
        )
    except Exception as e:
        logger.exception("earnings_extract llm call failed")
        raise HTTPException(502, f"llm_error: {type(e).__name__}")

    raw = resp if isinstance(resp, str) else str(resp)

    # Best-effort JSON extraction — strip fences if the model added them.
    text = raw.strip()
    m = _re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, _re.S)
    if m:
        text = m.group(1)
    else:
        m2 = _re.search(r"\{.*\}", text, _re.S)
        if m2:
            text = m2.group(0)
    try:
        parsed = _json.loads(text)
    except Exception:
        parsed = {}

    def _num(k: str):
        v = parsed.get(k)
        if v is None:
            return None
        try:
            return float(v)
        except Exception:
            return None

    result = {
        "platform": body.platform,
        "gross_amount": _num("gross_amount"),
        "trips": int(_num("trips")) if _num("trips") is not None else None,
        "cash_collected": _num("cash_collected"),
        "period_hint": parsed.get("period_hint"),
        "platform_detected": parsed.get("platform_detected"),
        "confidence": _num("confidence") or 0.0,
        "raw": raw,
    }
    # Persist the extraction attempt for audit (small doc, no blobs).
    await db.earnings_extractions.insert_one(
        {
            "id": str(uuid.uuid4()),
            "driver_id": driver["id"],
            "client_action_id": body.client_action_id,
            "platform": body.platform,
            "result": {k: v for k, v in result.items() if k != "raw"},
            "created_at": iso(now_utc()),
        }
    )
    return result


# ---------------------------------------------------------------------------
# VEHICLE PING helpers


async def _compute_distance(
    vehicle_id: str, start: datetime, end: datetime
) -> Dict[str, Any]:
    """Compute usable driven distance between `start` (incl) and `end` (excl).

    Filters applied (in order — each ping is counted in exactly one bucket):
      1. Accuracy filter: skip pings with `accuracy_m > 30` (GPS uncertainty
         swamps meaningful movement).
      2. Speed filter: skip pings whose reported `speed_kmph > 120` (spike
         from receiver glitches — a real EV is limited well below this).
      3. Implied-speed filter: for consecutive kept pings, if the great-circle
         speed between them exceeds 120 km/h, treat as a teleport and reset
         the anchor without adding to distance.
      4. Gap filter: if the time gap between the anchor and the next kept
         ping exceeds 5 minutes, we cannot trust the intervening path —
         reset the anchor without adding to distance.

    Returns a diagnostics dict so callers can display / test the numbers.
    """
    cursor = db.vehicle_pings.find({"vehicle_id": vehicle_id}, {"_id": 0}).sort(
        "recorded_at", 1
    )
    stats = {
        "points_total": 0,
        "points_kept": 0,
        "points_rejected_accuracy": 0,
        "points_rejected_speed": 0,
        "segments_rejected_teleport": 0,
        "segments_rejected_gap": 0,
        "distance_km": 0.0,
    }
    total_m = 0.0
    anchor: Optional[Dict[str, Any]] = None
    anchor_ts: Optional[datetime] = None
    async for p in cursor:
        try:
            ts = _parse_iso(p["recorded_at"])
        except Exception:
            continue
        if ts < start or ts >= end:
            continue
        stats["points_total"] += 1
        if p.get("accuracy_m", 0) > 30:
            stats["points_rejected_accuracy"] += 1
            continue
        if p.get("speed_kmph", 0) > 120:
            stats["points_rejected_speed"] += 1
            continue
        stats["points_kept"] += 1
        if anchor is not None and anchor_ts is not None:
            dt_s = (ts - anchor_ts).total_seconds()
            if dt_s > 300:
                # Gap too long — cannot infer path.
                stats["segments_rejected_gap"] += 1
                anchor = p
                anchor_ts = ts
                continue
            d_m = _haversine_m(anchor["lat"], anchor["lng"], p["lat"], p["lng"])
            implied_kmph = (d_m / dt_s) * 3.6 if dt_s > 0 else 0
            if implied_kmph > 120:
                stats["segments_rejected_teleport"] += 1
                anchor = p
                anchor_ts = ts
                continue
            total_m += d_m
        anchor = p
        anchor_ts = ts
    stats["distance_km"] = round(total_m / 1000.0, 3)
    return stats


async def _distance_today(vehicle_id: str, start: datetime, end: datetime) -> float:
    stats = await _compute_distance(vehicle_id, start, end)
    return float(stats["distance_km"])


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


@api.get("/vehicles/{vehicle_id}/distance")
async def vehicle_distance(
    vehicle_id: str,
    business_date: Optional[str] = None,
    from_iso: Optional[str] = None,
    to_iso: Optional[str] = None,
    driver: Dict = Depends(get_driver),
):
    """Filtered driven distance for a window.

    Provide EITHER `business_date=YYYY-MM-DD` (04:00–03:59 IST bucket) OR
    `from_iso=&to_iso=` (arbitrary UTC range). Defaults to today's business
    day when nothing is passed. Restricted to the caller's own vehicle to
    avoid leaking one driver's mileage to another.
    """
    if vehicle_id != driver["vehicle_id"]:
        raise HTTPException(403, "not_your_vehicle")
    if business_date:
        start, end = business_day_bounds(business_date)
    elif from_iso and to_iso:
        start = _parse_iso(from_iso)
        end = _parse_iso(to_iso)
    else:
        start, end = business_day_bounds(business_date_now())
    stats = await _compute_distance(vehicle_id, start, end)
    return {
        "vehicle_id": vehicle_id,
        "business_date": business_date or business_date_now(),
        "from": iso(start),
        "to": iso(end),
        **stats,
    }


# ---------------------------------------------------------------------------
# SEEDING
# ---------------------------------------------------------------------------
async def _seed_if_empty() -> None:
    # One-shot migration: backfill hub coords for drivers created before hubs
    # were introduced. Safe to run every boot — it's a no-op after the first.
    await db.drivers.update_many(
        {"hub_lat": {"$exists": False}},
        {"$set": {
            "hub_name": "Koramangala Hub",
            "hub_lat": 12.9352,
            "hub_lng": 77.6245,
        }},
    )
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
            "shift_type": "day",
            # Home hub (fleet garage) — used to compute shift-end alarm ETA.
            "hub_name": "Koramangala Hub",
            "hub_lat": 12.9352,
            "hub_lng": 77.6245,
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
    # Seed a plausible day of vehicle_pings around Bengaluru starting at
    # today's 04:00 IST business-day start.
    today_bd = business_date_now()
    day_start, _ = business_day_bounds(today_bd)
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
    # Seed a demo duty timeline (shift start 5h ago). Follows the new
    # duty/platform two-layer model.
    shift_start = now - timedelta(hours=5)
    duty_events = [
        (shift_start, "start_duty"),
        (shift_start + timedelta(minutes=2), "uber"),
        (shift_start + timedelta(hours=1, minutes=20), "not_online"),
        (shift_start + timedelta(hours=2, minutes=40), "rapido"),
        (shift_start + timedelta(hours=4, minutes=15), "uber"),
    ]
    for ts, state in duty_events:
        await db.duty_states.insert_one(
            {
                "id": str(uuid.uuid4()),
                "driver_id": driver_id,
                "vehicle_id": vehicle_id,
                "state": state,
                "started_at": iso(ts),
                "business_date": business_date_from_dt(ts),
                "lat": base_lat,
                "lng": base_lng,
                "source": "driver",
                "client_action_id": str(uuid.uuid4()),
                "synced_at": iso(ts + timedelta(seconds=3)),
            }
        )
    # Seed today's provisional platform_cash figures — one per platform.
    for platform, amount in [("uber", 640.0), ("rapido", 280.0), ("ola", 0.0)]:
        if amount <= 0:
            continue
        s, e = business_day_bounds(today_bd)
        await db.platform_cash.insert_one(
            {
                "id": str(uuid.uuid4()),
                "driver_id": driver_id,
                "platform": platform,
                "cash_amount": amount,
                "gross_amount": amount * 2.4,
                "business_date": today_bd,
                "window_start": iso(s),
                "window_end": iso(e),
                "source": "ocr",
                "status": "provisional",
                "image_ref": None,
                "confidence": 0.9,
                "client_action_id": str(uuid.uuid4()),
                "created_at": iso(now),
            }
        )
    # Seed the previous few days as SETTLED to fill the weekly chart.
    today_d = datetime.strptime(today_bd, "%Y-%m-%d").date()
    for i in range(1, 6):
        bd = (today_d - timedelta(days=i)).strftime("%Y-%m-%d")
        s, e = business_day_bounds(bd)
        for platform, base in [("uber", 780.0), ("rapido", 340.0), ("ola", 120.0)]:
            amt = round(base * random.uniform(0.7, 1.3), 2)
            await db.platform_cash.insert_one(
                {
                    "id": str(uuid.uuid4()),
                    "driver_id": driver_id,
                    "platform": platform,
                    "cash_amount": round(amt * random.uniform(0.3, 0.6), 2),
                    "gross_amount": amt,
                    "business_date": bd,
                    "window_start": iso(s),
                    "window_end": iso(e),
                    "source": "settlement",
                    "status": "settled",
                    "image_ref": None,
                    "confidence": None,
                    "client_action_id": str(uuid.uuid4()),
                    "created_at": iso(e),
                }
            )
    # Seed a "customer paid via QR" fare and one prior deposit so cash-in-hand
    # is non-trivial from the first render.
    await db.qr_payments.insert_one(
        {
            "id": str(uuid.uuid4()),
            "driver_id": driver_id,
            "amount": 120.0,
            "type": "fare",
            "reference": f"FARE-{driver_id[:6]}-1",
            "platform": "uber",
            "occurred_at": iso(now - timedelta(hours=3)),
            "business_date": today_bd,
            "client_action_id": str(uuid.uuid4()),
            "created_at": iso(now),
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
    await db.platform_cash.create_index(
        [("driver_id", 1), ("business_date", 1)]
    )
    await db.platform_cash.create_index(
        [("driver_id", 1), ("client_action_id", 1)], unique=True
    )
    await db.qr_payments.create_index(
        [("driver_id", 1), ("business_date", 1)]
    )
    await db.qr_payments.create_index(
        [("driver_id", 1), ("client_action_id", 1)], unique=True
    )
    await db.shift_schedules.create_index(
        [("driver_id", 1), ("client_action_id", 1)], unique=True
    )
    await db.shift_schedules.create_index(
        [("driver_id", 1), ("shift_start", 1)]
    )
    await db.alarm_responses.create_index(
        [("driver_id", 1), ("client_action_id", 1)], unique=True
    )
    await _seed_if_empty()


@app.on_event("shutdown")
async def _on_shutdown() -> None:
    client.close()
