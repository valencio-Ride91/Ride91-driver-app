"""Ride91 driver-app backend (FastAPI + MongoDB).

All routes are prefixed with /api. Mutating routes accept a `client_action_id`
UUID from the mobile client and dedupe per (driver_id, client_action_id) so the
offline sync worker can safely retry.

The duty_states collection is append-only: current state is always the most
recent row per driver, never stored on the driver document. Admin corrections
are new rows with source='admin_correction'.
"""
from __future__ import annotations

import csv
import hashlib
import hmac
import io
import logging
import math
import os
import random
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from dotenv import load_dotenv
from fastapi import (
    APIRouter,
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Request,
    Response,
    UploadFile,
    status,
)
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
# to_charger and charging are on-duty, non-earning states: the car is being
# driven to a charger or is plugged in. Both count towards on-duty time and
# neither counts as working time, since no platform is live.
NON_PLATFORM_STATES = {"offline", "shift_end", "to_charger", "charging"}
DUTY_LAYER = {"start_duty", "end_duty"}
PLATFORM_LAYER = {"uber", "rapido", "ola", "not_online", "online"}
ALL_STATES = PLATFORMS | NON_PLATFORM_STATES | DUTY_LAYER | PLATFORM_LAYER
CASH_LIMIT = 1500  # ₹ — default; overridable via the settings doc
DRIVER_SHARE = 0.30  # default; overridable via the settings doc

# ---------------------------------------------------------------------------
# Runtime settings — a single `settings` doc (id="global") overlays these
# defaults. Cached in memory and refreshed on startup and after every save, so
# the money math reads a live value without a DB hit per request.
# ---------------------------------------------------------------------------
SETTINGS_DEFAULTS: Dict[str, Any] = {
    "cash_limit": CASH_LIMIT,
    "driver_share": DRIVER_SHARE,
    "hubs": [],                       # list of {name, lat, lng}
}
_SETTINGS_CACHE: Dict[str, Any] = dict(SETTINGS_DEFAULTS)


def get_setting(key: str, default: Any = None) -> Any:
    return _SETTINGS_CACHE.get(key, SETTINGS_DEFAULTS.get(key, default))


async def load_settings() -> Dict[str, Any]:
    """Refresh the in-memory settings cache from the DB, keeping defaults for
    anything not stored."""
    doc = await db.settings.find_one({"id": "global"}, {"_id": 0})
    merged = dict(SETTINGS_DEFAULTS)
    if doc:
        for k in SETTINGS_DEFAULTS:
            if doc.get(k) is not None:
                merged[k] = doc[k]
    _SETTINGS_CACHE.clear()
    _SETTINGS_CACHE.update(merged)
    return merged
# Sources whose qr_payments rows may reduce a driver's cash_in_hand. The
# driver's own app is deliberately not on this list: cash is cleared either by
# paying through Razorpay (webhook-confirmed) or by ops recording a hand-in.
TRUSTED_CASH_SOURCES = {"razorpay", "admin_manual"}
# How far back the ops driver list looks for a driver's latest duty state.
# Bounds the sort: a driver with no row in this window is not on duty now.
STATE_LOOKBACK_DAYS = 7
DEMO_DRIVER_PHONE = "+919900000001"
DEMO_DRIVER_PASSWORD = "ride91"  # seed driver's admin-set password (demo only)

# Business day runs 04:00 IST to 03:59 IST next day. Matches Uber's cut-off.
IST = timezone(timedelta(hours=5, minutes=30))
BUSINESS_DAY_OFFSET_HOURS = 4


@api.get("/health")
async def health():
    """Unauthenticated liveness + DB reachability, for a host's health check."""
    db_ok = False
    try:
        await db.command("ping")
        db_ok = True
    except Exception:
        db_ok = False
    return {"ok": True, "db": db_ok}


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
class DriverLoginIn(BaseModel):
    # Drivers log in with their phone (username) and an admin-set password.
    phone: str
    password: str
    client_action_id: str


class DriverChangePasswordIn(BaseModel):
    old_password: str
    new_password: str = Field(min_length=6)


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
    google_email: Optional[str] = None
    google_picture_url: Optional[str] = None


class DutyStateIn(BaseModel):
    # Rows that land here:
    #   Duty layer:     start_duty / end_duty
    #   Platform layer: "online" (with `platforms`) or "not_online"; the legacy
    #                   single values uber / rapido / ola are still accepted.
    #   Charging:       to_charger / charging
    #   Support:        offline / shift_end  (kept for backwards-compat)
    state: Literal[
        "start_duty", "end_duty",
        "online", "uber", "rapido", "ola", "not_online",
        "to_charger", "charging",
        "offline", "shift_end",
    ]
    # The set of platforms the driver is online on right now (multiple allowed).
    # Sent with state="online"; empty/None means not online on any app.
    platforms: Optional[List[str]] = None
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


class DriverNotifyIn(BaseModel):
    # A message the driver sends to ops (shows in the admin driver card).
    body: str = Field(min_length=1, max_length=1000)
    client_action_id: str


class AdminNotifyIn(BaseModel):
    # A message ops sends to a driver (shows on the driver app's bell).
    body: str = Field(min_length=1, max_length=1000)


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


class LinkUberUuidIn(BaseModel):
    """Wires a Ride91 driver to Uber's stable per-driver identifier."""
    uber_driver_uuid: str = Field(min_length=8)


class QrDepositIn(BaseModel):
    """Ask for a dynamic UPI QR to clear cash dues.

    No amount is trusted from the client beyond an optional partial-payment
    request, which the server caps at the driver's actual dues.
    """
    client_action_id: str
    amount_rupees: Optional[float] = None


class ManualDepositIn(BaseModel):
    """Cash a driver handed over off-app, recorded by ops.

    `reason` is required and `reference` doubles as the idempotency key, so
    every row that reduces a balance without a Razorpay payment behind it is
    attributable to a person and a receipt.
    """
    amount: float = Field(gt=0)
    reference: str = Field(min_length=3)
    reason: str = Field(min_length=3)
    occurred_at: Optional[str] = None


# ---------------------------------------------------------------------------
# FLEET ONBOARDING (admin) — create/edit vehicles and drivers
# ---------------------------------------------------------------------------
class VehicleCreateIn(BaseModel):
    number: str = Field(min_length=3)          # number plate
    model: str = "Citroën ëC3"
    current_soc: Optional[int] = None
    current_range_km: Optional[int] = None


class VehicleUpdateIn(BaseModel):
    # All optional — only the provided fields change.
    number: Optional[str] = Field(default=None, min_length=3)
    model: Optional[str] = None
    current_soc: Optional[int] = None
    current_range_km: Optional[int] = None


class DriverCreateIn(BaseModel):
    name: str = Field(min_length=1)
    phone: str = Field(min_length=5)           # login identity (username); unique
    password: str = Field(min_length=6)        # admin-set driver app password
    vehicle_id: Optional[str] = None
    hub_name: Optional[str] = None
    hub_lat: Optional[float] = None
    hub_lng: Optional[float] = None
    shift_type: str = "day"                    # day | night
    status: Literal["approved", "pending"] = "approved"


class DriverUpdateIn(BaseModel):
    # All optional — only the provided fields change.
    name: Optional[str] = None
    phone: Optional[str] = None
    password: Optional[str] = Field(default=None, min_length=6)  # reset password
    vehicle_id: Optional[str] = None
    hub_name: Optional[str] = None
    hub_lat: Optional[float] = None
    hub_lng: Optional[float] = None
    shift_type: Optional[str] = None
    status: Optional[Literal["approved", "pending"]] = None
    active: Optional[bool] = None


# ---------------------------------------------------------------------------
# BOOKINGS
#
# Scheduled Ride91 rides, entered by ops. Deliberately map-free for now:
# pickup and drop are free text, there is no geolocation, routing, or
# auto-dispatch. A driver/vehicle is attached by hand, or left unassigned.
# The lifecycle and the append-only status history are here so the rider app
# and a dispatcher can be layered on later without a data migration.
# ---------------------------------------------------------------------------
BOOKING_STATES = [
    "requested",   # taken down, nothing promised yet
    "confirmed",   # ops confirmed it will be serviced
    "assigned",    # a driver/vehicle is attached
    "en_route",    # driver heading to pickup
    "started",     # rider on board
    "completed",   # done
    "cancelled",   # called off
    "no_show",     # rider not there
]
BOOKING_OPEN_STATES = {"requested", "confirmed", "assigned", "en_route", "started"}
BOOKING_CLOSED_STATES = {"completed", "cancelled", "no_show"}


class BookingCreateIn(BaseModel):
    rider_name: str = Field(min_length=1)
    rider_phone: str = Field(min_length=5)
    pickup_text: str = Field(min_length=1)
    drop_text: str = Field(min_length=1)
    # None means "as soon as possible" rather than a scheduled time.
    scheduled_at: Optional[str] = None
    vehicle_type: Optional[str] = None
    fare_estimate: Optional[float] = Field(default=None, ge=0)
    notes: Optional[str] = None


class BookingStatusIn(BaseModel):
    status: Literal[
        "requested", "confirmed", "assigned", "en_route",
        "started", "completed", "cancelled", "no_show",
    ]
    note: Optional[str] = None
    # Optional assignment when moving to 'assigned'. Not validated against the
    # fleet yet — no dispatch logic — just recorded.
    driver_id: Optional[str] = None
    vehicle_id: Optional[str] = None


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
    # Sessions carry a sliding TTL: a driver active within DRIVER_SESSION_DAYS
    # stays signed in, while a dormant (e.g. stolen) token expires. Legacy
    # sessions with no expires_at are treated as non-expiring for continuity.
    exp_iso = session.get("expires_at")
    if exp_iso:
        try:
            exp_dt = _parse_iso(exp_iso)
            if exp_dt <= now_utc():
                await db.sessions.delete_one({"token": token})
                raise HTTPException(status.HTTP_401_UNAUTHORIZED, "session_expired")
        except HTTPException:
            raise
        except Exception:
            exp_iso = None  # bad expires_at → treat as non-expiring
    driver = await db.drivers.find_one({"id": session["driver_id"]}, {"_id": 0})
    if not driver:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "driver missing")
    # A deactivated or archived driver can no longer use an existing token.
    if not driver.get("active", True) or driver.get("archived"):
        await db.sessions.delete_one({"token": token})
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "account_disabled")
    # Slide the window on activity so active drivers are never logged out.
    if exp_iso:
        await db.sessions.update_one(
            {"token": token},
            {"$set": {"expires_at": iso(now_utc() + timedelta(days=DRIVER_SESSION_DAYS))}},
        )
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
        google_email=driver.get("google_email"),
        google_picture_url=driver.get("google_picture_url"),
    ).model_dump()


# ---------------------------------------------------------------------------
# Admin auth (admin.ride91.green)
# ---------------------------------------------------------------------------
# Single service account gated by fixed credentials in the backend .env.
# This is intentionally the simplest safe design for an ops team of 1-3
# people. Tokens are opaque UUIDs stored in the `admin_sessions` collection
# with a rolling 12-hour TTL that refreshes on activity.
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "ride91-admin-2026")
ADMIN_SESSION_HOURS = 12
# Driver sessions get a long sliding TTL: a driver active within this many days
# stays signed in, but a truly dormant (e.g. stolen) token dies.
DRIVER_SESSION_DAYS = 30

# Login brute-force guard (DB-backed so it holds across Cloud Run instances).
LOGIN_MAX_ATTEMPTS = 6      # failures allowed within the window
LOGIN_WINDOW_MIN = 15       # rolling window for counting failures
LOGIN_LOCK_MIN = 15         # lockout duration once the limit is hit

# Role hierarchy. A viewer may only read; a manager may perform ops actions; an
# owner additionally manages admin accounts and settings.
ROLE_RANK = {"viewer": 0, "manager": 1, "owner": 2}
ROLES = set(ROLE_RANK)


async def login_guard(key: str) -> None:
    """Raise 429 if `key` (phone or admin username) is currently locked out."""
    row = await db.login_attempts.find_one({"key": key}, {"_id": 0})
    if row and row.get("locked_until") and _parse_iso(row["locked_until"]) > now_utc():
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "too_many_attempts")


async def login_record_failure(key: str) -> None:
    """Count a failed attempt; lock the key once the limit is hit in-window."""
    now = now_utc()
    row = await db.login_attempts.find_one({"key": key}, {"_id": 0})
    window_ok = (
        row and row.get("first_at") and
        _parse_iso(row["first_at"]) > now - timedelta(minutes=LOGIN_WINDOW_MIN)
    )
    count = (row["count"] + 1) if window_ok else 1
    update: Dict[str, Any] = {"count": count, "last_at": iso(now)}
    if not window_ok:
        update["first_at"] = iso(now)
    if count >= LOGIN_MAX_ATTEMPTS:
        update["locked_until"] = iso(now + timedelta(minutes=LOGIN_LOCK_MIN))
    await db.login_attempts.update_one({"key": key}, {"$set": update}, upsert=True)


async def login_clear(key: str) -> None:
    """Wipe the failure counter after a successful login."""
    await db.login_attempts.delete_one({"key": key})


def hash_password(pw: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 200_000)
    return f"pbkdf2_sha256$200000${salt}${dk.hex()}"


def verify_password(pw: str, stored: Optional[str]) -> bool:
    if not stored:
        return False
    try:
        _algo, iters, salt, want = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(iters))
        return hmac.compare_digest(dk.hex(), want)
    except (ValueError, TypeError):
        return False


async def _audit(admin: Dict, action: str, target: str = "", meta: Optional[Dict] = None) -> None:
    """Append an admin action to the audit log. Best-effort — never blocks the
    action it records."""
    try:
        await db.admin_audit.insert_one({
            "id": str(uuid.uuid4()),
            "at": iso(now_utc()),
            "actor": admin.get("username") if admin else None,
            "actor_role": admin.get("role") if admin else None,
            "action": action,
            "target": target,
            "meta": meta or {},
        })
    except Exception:  # pragma: no cover - logging must not break the request
        logger.exception("audit write failed for %s", action)


class AdminLoginIn(BaseModel):
    username: str
    password: str


class AdminUserCreateIn(BaseModel):
    username: str = Field(min_length=3)
    password: str = Field(min_length=6)
    role: Literal["viewer", "manager", "owner"] = "manager"


class AdminUserUpdateIn(BaseModel):
    role: Optional[Literal["viewer", "manager", "owner"]] = None
    active: Optional[bool] = None
    password: Optional[str] = Field(default=None, min_length=6)


class ChangePasswordIn(BaseModel):
    old_password: str
    new_password: str = Field(min_length=6)


class SettingsIn(BaseModel):
    cash_limit: Optional[int] = Field(default=None, ge=0)
    driver_share: Optional[float] = Field(default=None, ge=0, le=1)
    hubs: Optional[List[Dict[str, Any]]] = None


async def get_admin(authorization: Optional[str] = Header(default=None)) -> Dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing_admin_token")
    token = authorization.split(" ", 1)[1]
    sess = await db.admin_sessions.find_one({"token": token}, {"_id": 0})
    if not sess:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_admin_token")
    if _parse_iso(sess["expires_at"]) <= now_utc():
        await db.admin_sessions.delete_one({"token": token})
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "admin_token_expired")
    # Resolve the live user so a role change or deactivation takes effect at
    # once, without waiting for the session to expire. Fail closed: a session
    # whose user no longer exists is rejected rather than granted privileges.
    user = await db.admin_users.find_one({"username": sess["username"]}, {"_id": 0})
    if not user:
        await db.admin_sessions.delete_one({"token": token})
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_admin_token")
    if not user.get("active", True):
        await db.admin_sessions.delete_one({"token": token})
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "account_disabled")
    role = user.get("role", "viewer")
    # Slide the expiry so an active admin doesn't get logged out mid-review.
    new_exp = iso(now_utc() + timedelta(hours=ADMIN_SESSION_HOURS))
    await db.admin_sessions.update_one(
        {"token": token}, {"$set": {"expires_at": new_exp, "last_seen_at": iso(now_utc())}}
    )
    return {
        "username": sess["username"],
        "role": role,
        "user_id": user.get("id"),
        "token": token,
    }


async def require_write(admin: Dict = Depends(get_admin)) -> Dict:
    """Any role above viewer. Use for mutating ops endpoints."""
    if ROLE_RANK.get(admin.get("role", "viewer"), 0) < ROLE_RANK["manager"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "read_only_role")
    return admin


async def require_owner(admin: Dict = Depends(get_admin)) -> Dict:
    """Owner only. Use for admin-account and settings management."""
    if admin.get("role") != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "owner_only")
    return admin


# ---------------------------------------------------------------------------
# AUTH
# ---------------------------------------------------------------------------
@api.post("/auth/login")
async def driver_login(body: DriverLoginIn):
    """Driver login with phone (username) + admin-set password. The generic
    error message avoids revealing whether a phone is registered."""
    phone = body.phone.strip()
    await login_guard(f"driver:{phone}")
    driver = await db.drivers.find_one({"phone": phone}, {"_id": 0})
    ok = (
        bool(driver)
        and driver.get("active", True)
        and not driver.get("archived")
        and verify_password(body.password, driver.get("password_hash"))
    )
    if not ok:
        await login_record_failure(f"driver:{phone}")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_credentials")
    await login_clear(f"driver:{phone}")
    vehicle = await db.vehicles.find_one({"id": driver.get("vehicle_id")}, {"_id": 0})
    # Reuse token per client_action_id to keep login idempotent under retry.
    existing = await db.sessions.find_one({"client_action_id": body.client_action_id}, {"_id": 0})
    token = existing["token"] if existing else str(uuid.uuid4())
    if not existing:
        await db.sessions.insert_one(
            {
                "token": token,
                "driver_id": driver["id"],
                "client_action_id": body.client_action_id,
                "created_at": iso(now_utc()),
                "expires_at": iso(now_utc() + timedelta(days=DRIVER_SESSION_DAYS)),
            }
        )
    return {
        "token": token,
        "driver": _driver_out(driver, vehicle),
    }


@api.post("/auth/logout")
async def auth_logout(driver: Dict = Depends(get_driver), authorization: Optional[str] = Header(default=None)):
    if authorization and authorization.startswith("Bearer "):
        await db.sessions.delete_one({"token": authorization.split(" ", 1)[1]})
    return {"ok": True}


@api.get("/auth/me")
async def me(driver: Dict = Depends(get_driver)):
    vehicle = await db.vehicles.find_one({"id": driver["vehicle_id"]}, {"_id": 0})
    return {
        "driver": _driver_out(driver, vehicle),
        "vehicle": {k: v for k, v in (vehicle or {}).items()},
    }


@api.post("/auth/change-password")
async def driver_change_password(
    body: DriverChangePasswordIn, driver: Dict = Depends(get_driver)
):
    """A driver changes the password ops issued them. Requires the current
    password; the current session stays valid."""
    if not verify_password(body.old_password, driver.get("password_hash")):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "wrong_current_password")
    await db.drivers.update_one(
        {"id": driver["id"]},
        {"$set": {"password_hash": hash_password(body.new_password),
                  "password_changed_at": iso(now_utc())}},
    )
    return {"ok": True}


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
    # Normalise the active-platform set. Accept the legacy single-platform
    # states (uber/rapido/ola) by folding them into `platforms` too.
    platforms = [p for p in (body.platforms or []) if p in PLATFORMS]
    if body.state in PLATFORMS:
        platforms = [body.state]
    platforms = sorted(set(platforms))
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver["id"],
        "vehicle_id": driver["vehicle_id"],
        "state": body.state,
        "platforms": platforms,
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
        # Derive the active-platform set for the segment. New rows carry
        # `platforms`; legacy rows encode a single platform in `state`.
        plats = row.get("platforms")
        if plats is None:
            plats = [row["state"]] if row["state"] in PLATFORMS else []
        segments.append(
            {
                "state": row["state"],
                "platforms": plats,
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
    # Working time = any segment with at least one platform online (multiple
    # platforms at once still counts as one stretch of working time, not N×).
    working_seconds = sum(s["seconds"] for s in segs if s.get("platforms"))
    # Also tally time per platform (a driver on two apps accrues time on both).
    per_platform_seconds: Dict[str, int] = {}
    for s in segs:
        for p in s.get("platforms") or []:
            per_platform_seconds[p] = per_platform_seconds.get(p, 0) + s["seconds"]
    # On-duty time = working + not_online + charging segments after start_duty.
    on_duty_seconds = (
        working_seconds
        + totals.get("not_online", 0)
        + totals.get("to_charger", 0)
        + totals.get("charging", 0)
    )
    charging_seconds = totals.get("to_charger", 0) + totals.get("charging", 0)
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
    # Current active-platform SET is the most recent platform-layer row after
    # the last start_duty. `current_platform` (singular) is kept for older
    # clients as the first of the set.
    current_platforms: List[str] = []
    if on_duty:
        for s in reversed(segs):
            if s["state"] == "start_duty":
                break
            if s["state"] in ("online", "not_online") or s["state"] in PLATFORMS:
                current_platforms = list(s.get("platforms") or [])
                break
    current_platform = current_platforms[0] if current_platforms else None
    distance_km = await _distance_today(driver["vehicle_id"], day_start, day_end)
    return {
        "segments": segs,
        "totals_seconds": totals,
        "on_duty": on_duty,
        "current_platform": current_platform,
        "current_platforms": current_platforms,
        "per_platform_seconds": per_platform_seconds,
        "on_duty_seconds": on_duty_seconds,
        "working_seconds": working_seconds,
        "charging_seconds": charging_seconds,
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
    """Rows that are allowed to move a driver's cash balance.

    Every row here reduces cash_in_hand (see _cash_snapshot), so a row the
    driver could author would let them clear their own dues. Only rows whose
    source we control count:
      * 'razorpay'     — written by _reconcile_razorpay_once from the webhook
      * 'admin_manual' — recorded by ops, e.g. cash handed in at the hub
    Legacy rows from the retired driver-facing POST /api/qr-payment carry no
    'source' field at all, so this filter neutralises the ones already in the
    database instead of merely stopping new ones.
    """
    cursor = db.qr_payments.find(
        {
            "driver_id": driver_id,
            "business_date": {"$gte": from_bd, "$lt": to_bd},
            "source": {"$in": sorted(TRUSTED_CASH_SOURCES)},
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
# ADMIN PANEL (admin.ride91.green)
# ---------------------------------------------------------------------------
# All /admin/* endpoints require an admin bearer token (see get_admin above).
# Ops-facing helpers to power a small standalone web UI: drivers list, a live
# map, and two review queues (walkaround captures + document verification).


class ReviewIn(BaseModel):
    decision: Literal["approve", "reject"]
    note: Optional[str] = None


@api.post("/admin/login")
async def admin_login(body: AdminLoginIn):
    # Authenticate against the admin_users collection. `_seed_admin_owner`
    # guarantees at least the env-configured owner exists.
    await login_guard(f"admin:{body.username}")
    user = await db.admin_users.find_one({"username": body.username}, {"_id": 0})
    ok = bool(user) and user.get("active", True) and verify_password(body.password, user.get("password_hash"))
    if not ok:
        await login_record_failure(f"admin:{body.username}")
        # Constant-ish message on purpose — no user enumeration.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_credentials")
    await login_clear(f"admin:{body.username}")
    token = str(uuid.uuid4())
    await db.admin_sessions.insert_one(
        {
            "token": token,
            "username": body.username,
            "created_at": iso(now_utc()),
            "last_seen_at": iso(now_utc()),
            "expires_at": iso(now_utc() + timedelta(hours=ADMIN_SESSION_HOURS)),
        }
    )
    await _audit({"username": body.username, "role": user.get("role")}, "login")
    return {
        "token": token, "username": body.username,
        "role": user.get("role", "owner"), "hours_valid": ADMIN_SESSION_HOURS,
    }


@api.post("/admin/logout")
async def admin_logout(admin: Dict = Depends(get_admin)):
    await db.admin_sessions.delete_one({"token": admin["token"]})
    return {"ok": True}


@api.get("/admin/me")
async def admin_me(admin: Dict = Depends(get_admin)):
    return {"username": admin["username"], "role": admin["role"]}


@api.post("/admin/change-password")
async def admin_change_password(body: ChangePasswordIn, admin: Dict = Depends(get_admin)):
    user = await db.admin_users.find_one({"username": admin["username"]}, {"_id": 0})
    if not user or not verify_password(body.old_password, user.get("password_hash")):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "wrong_current_password")
    await db.admin_users.update_one(
        {"username": admin["username"]},
        {"$set": {"password_hash": hash_password(body.new_password),
                  "password_changed_at": iso(now_utc())}},
    )
    await _audit(admin, "change_password")
    return {"ok": True}


# ---- Admin accounts (owner only) ------------------------------------------
def _user_out(u: Dict) -> Dict:
    return {
        "id": u.get("id"),
        "username": u.get("username"),
        "role": u.get("role"),
        "active": u.get("active", True),
        "created_at": u.get("created_at"),
        "created_by": u.get("created_by"),
        "last_login_at": u.get("last_login_at"),
    }


@api.get("/admin/users")
async def admin_list_users(admin: Dict = Depends(require_owner)):
    users = [_user_out(u) async for u in db.admin_users.find({}, {"_id": 0}).sort("username", 1)]
    return {"items": users, "count": len(users)}


@api.post("/admin/users")
async def admin_create_user(body: AdminUserCreateIn, admin: Dict = Depends(require_owner)):
    username = body.username.strip()
    if await db.admin_users.find_one({"username": username}, {"_id": 0, "id": 1}):
        raise HTTPException(409, "username_taken")
    row = {
        "id": str(uuid.uuid4()),
        "username": username,
        "password_hash": hash_password(body.password),
        "role": body.role,
        "active": True,
        "created_at": iso(now_utc()),
        "created_by": admin["username"],
    }
    await db.admin_users.insert_one(row.copy())
    await _audit(admin, "create_user", username, {"role": body.role})
    return _user_out(row)


@api.patch("/admin/users/{user_id}")
async def admin_update_user(user_id: str, body: AdminUserUpdateIn, admin: Dict = Depends(require_owner)):
    user = await db.admin_users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(404, "user_not_found")
    updates: Dict[str, Any] = {}
    # Guard against locking everyone out: the last active owner can't be
    # demoted or disabled.
    demoting = (body.role is not None and body.role != "owner") or (body.active is False)
    if user.get("role") == "owner" and demoting:
        owners = await db.admin_users.count_documents({"role": "owner", "active": True})
        if owners <= 1:
            raise HTTPException(409, "cannot_remove_last_owner")
    if body.role is not None:
        updates["role"] = body.role
    if body.active is not None:
        updates["active"] = body.active
    if body.password is not None:
        updates["password_hash"] = hash_password(body.password)
    if not updates:
        return {"ok": True, "unchanged": True}
    updates["updated_at"] = iso(now_utc())
    updates["updated_by"] = admin["username"]
    await db.admin_users.update_one({"id": user_id}, {"$set": updates})
    await _audit(admin, "update_user", user.get("username"), {k: v for k, v in updates.items() if k != "password_hash"})
    return {"ok": True, "id": user_id, "updated": [k for k in updates if k != "password_hash"]}


@api.delete("/admin/users/{user_id}")
async def admin_delete_user(user_id: str, admin: Dict = Depends(require_owner)):
    user = await db.admin_users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(404, "user_not_found")
    if user.get("username") == admin["username"]:
        raise HTTPException(409, "cannot_delete_self")
    if user.get("role") == "owner":
        owners = await db.admin_users.count_documents({"role": "owner", "active": True})
        if owners <= 1:
            raise HTTPException(409, "cannot_remove_last_owner")
    await db.admin_users.delete_one({"id": user_id})
    await db.admin_sessions.delete_many({"username": user.get("username")})
    await _audit(admin, "delete_user", user.get("username"))
    return {"ok": True, "id": user_id, "deleted": True}


# ---- Settings (owner only) -------------------------------------------------
@api.get("/admin/settings")
async def admin_get_settings(admin: Dict = Depends(get_admin)):
    return {
        "cash_limit": get_setting("cash_limit", CASH_LIMIT),
        "driver_share": get_setting("driver_share", DRIVER_SHARE),
        "hubs": get_setting("hubs", []),
        "business_day_cutoff_ist": "04:00",   # read-only: embedded in day math
    }


@api.put("/admin/settings")
async def admin_put_settings(body: SettingsIn, admin: Dict = Depends(require_owner)):
    updates: Dict[str, Any] = {}
    if body.cash_limit is not None:
        updates["cash_limit"] = body.cash_limit
    if body.driver_share is not None:
        updates["driver_share"] = body.driver_share
    if body.hubs is not None:
        updates["hubs"] = body.hubs
    if updates:
        updates["updated_at"] = iso(now_utc())
        updates["updated_by"] = admin["username"]
        await db.settings.update_one({"id": "global"}, {"$set": updates}, upsert=True)
        await load_settings()
        await _audit(admin, "update_settings", "", {k: v for k, v in updates.items() if k in ("cash_limit", "driver_share")})
    return {
        "ok": True,
        "cash_limit": get_setting("cash_limit", CASH_LIMIT),
        "driver_share": get_setting("driver_share", DRIVER_SHARE),
        "hubs": get_setting("hubs", []),
    }


# ---- Audit log (manager+) --------------------------------------------------
@api.get("/admin/audit")
async def admin_audit_log(
    limit: int = 200, action: Optional[str] = None, admin: Dict = Depends(require_write)
):
    query: Dict[str, Any] = {}
    if action:
        query["action"] = action
    limit = max(1, min(limit, 1000))
    rows = [r async for r in db.admin_audit.find(query, {"_id": 0}).sort("at", -1).limit(limit)]
    return {"items": rows, "count": len(rows)}


# ---- Drivers ---------------------------------------------------------------


@api.get("/admin/drivers")
async def admin_drivers(
    include_archived: bool = False, admin: Dict = Depends(get_admin)
):
    """List all drivers with the ops-relevant snapshot: on-duty + platform,
    cash in hand, last GPS ping, vehicle plate, hub. Optimised for a single
    table view — never returns base64 media. Archived drivers are hidden
    unless `include_archived=true`."""
    query: Dict[str, Any] = {} if include_archived else {"archived": {"$ne": True}}
    drivers = [d async for d in db.drivers.find(query, {"_id": 0})]
    vehicles = {
        v["id"]: v async for v in db.vehicles.find({}, {"_id": 0})
    }
    out: List[Dict[str, Any]] = []
    now = now_utc()
    day_key = business_date_from_dt(now)
    day_start, day_end = business_day_bounds(day_key)

    # Fleet-wide lookups, once. Per-driver queries in the loop below are what
    # makes this endpoint O(drivers): at 400 drivers even two extra awaits
    # each is ~800 round trips, and the page stops rendering at all.
    balances = await _driver_balances([d["id"] for d in drivers])

    # Both aggregations below are windowed on purpose. Sorting these two
    # collections whole would be worse than the per-driver queries it
    # replaces: vehicle_pings grows by ~200 vehicles x 15/hour, so a full
    # sort is a scan of every ping ever recorded. A driver who has not
    # appeared in a week is not on duty now, and a ping older than a day is
    # not worth plotting, so a window loses nothing this table shows.
    state_since = iso(now - timedelta(days=STATE_LOOKBACK_DAYS))
    latest_state: Dict[str, Dict] = {}
    async for r in db.duty_states.aggregate([
        {"$match": {"started_at": {"$gte": state_since}}},
        {"$sort": {"started_at": 1}},
        {"$group": {"_id": "$driver_id", "state": {"$last": "$state"}}},
    ]):
        latest_state[r["_id"]] = r
    started_today: set = set()
    async for r in db.duty_states.aggregate([
        {"$match": {"state": "start_duty",
                    "started_at": {"$gte": iso(day_start), "$lt": iso(day_end)}}},
        {"$group": {"_id": "$driver_id"}},
    ]):
        started_today.add(r["_id"])
    ping_since = iso(now - timedelta(days=1))
    last_pings: Dict[str, Dict] = {}
    async for r in db.vehicle_pings.aggregate([
        {"$match": {"recorded_at": {"$gte": ping_since}}},
        {"$sort": {"recorded_at": 1}},
        {"$group": {"_id": "$vehicle_id",
                    "recorded_at": {"$last": "$recorded_at"},
                    "lat": {"$last": "$lat"}, "lng": {"$last": "$lng"}}},
    ]):
        last_pings[r["_id"]] = r

    for d in drivers:
        vid = d.get("vehicle_id")
        v = vehicles.get(vid, {})
        # All three come from the fleet-wide lookups above — no per-driver
        # round trips. One source of truth for what a driver owes: the same
        # running balance the driver's own app and the payment endpoints use.
        last_state = latest_state.get(d["id"])
        on_duty_row = d["id"] in started_today
        bal = balances.get(d["id"]) or _zero_balance(day_key)
        last_ping = last_pings.get(vid) if vid else None
        out.append(
            {
                "id": d["id"],
                "name": d.get("name"),
                "phone": d.get("phone"),
                "hub_name": d.get("hub_name"),
                "shift_type": d.get("shift_type"),
                "active": d.get("active", True),
                "archived": bool(d.get("archived")),
                "status": d.get("status", "approved"),
                "vehicle_number": v.get("number"),
                "vehicle_id": vid,
                "vehicle_soc": v.get("current_soc"),
                "vehicle_range_km": v.get("current_range_km"),
                "on_duty": bool(on_duty_row and (not last_state or last_state["state"] != "end_duty")),
                "current_state": last_state["state"] if last_state else None,
                "cash_in_hand": bal["you_owe"],
                "cash_over_limit": bal["over_limit"],
                "collected_to_yesterday": bal["collected_to_yesterday"],
                "paid_in_today": bal["paid_in_today"],
                "last_ping_at": last_ping["recorded_at"] if last_ping else None,
                "last_lat": last_ping["lat"] if last_ping else None,
                "last_lng": last_ping["lng"] if last_ping else None,
            }
        )
    out.sort(key=lambda x: (not x["on_duty"], x["name"] or ""))
    return {"items": out, "business_date": day_key, "count": len(out)}


# ---- Fleet onboarding: vehicles + drivers ---------------------------------
@api.get("/admin/vehicles")
async def admin_list_vehicles(
    include_retired: bool = False, admin: Dict = Depends(get_admin)
):
    query: Dict[str, Any] = {} if include_retired else {"retired": {"$ne": True}}
    vehicles = [v async for v in db.vehicles.find(query, {"_id": 0}).sort("number", 1)]
    # Which vehicles already have a driver, so the UI can flag free ones and
    # name who holds each one.
    holder: Dict[str, str] = {}
    async for d in db.drivers.find(
        {"vehicle_id": {"$ne": None}, "archived": {"$ne": True}},
        {"_id": 0, "vehicle_id": 1, "name": 1},
    ):
        holder[d["vehicle_id"]] = d.get("name")
    for v in vehicles:
        v["assigned"] = v["id"] in holder
        v["assigned_driver"] = holder.get(v["id"])
        v["retired"] = bool(v.get("retired"))
    return {"items": vehicles, "count": len(vehicles)}


@api.post("/admin/vehicles")
async def admin_create_vehicle(body: VehicleCreateIn, admin: Dict = Depends(require_write)):
    number = body.number.strip().upper()
    if await db.vehicles.find_one({"number": number}, {"_id": 0, "id": 1}):
        raise HTTPException(409, "vehicle_number_exists")
    row = {
        "id": str(uuid.uuid4()),
        "number": number,
        "model": body.model,
        "current_soc": body.current_soc,
        "current_range_km": body.current_range_km,
        "created_by": admin["username"],
        "created_at": iso(now_utc()),
    }
    await db.vehicles.insert_one(row.copy())
    row.pop("_id", None)
    await _audit(admin, "create_vehicle", row["id"], {"number": number})
    return row


@api.patch("/admin/vehicles/{vehicle_id}")
async def admin_update_vehicle(
    vehicle_id: str, body: VehicleUpdateIn, admin: Dict = Depends(require_write)
):
    veh = await db.vehicles.find_one({"id": vehicle_id}, {"_id": 0, "id": 1})
    if not veh:
        raise HTTPException(404, "vehicle_not_found")
    updates: Dict[str, Any] = {}
    if body.number is not None:
        number = body.number.strip().upper()
        clash = await db.vehicles.find_one(
            {"number": number, "id": {"$ne": vehicle_id}}, {"_id": 0, "id": 1}
        )
        if clash:
            raise HTTPException(409, "vehicle_number_exists")
        updates["number"] = number
    for field in ("model", "current_soc", "current_range_km"):
        val = getattr(body, field)
        if val is not None:
            updates[field] = val
    if not updates:
        return {"ok": True, "unchanged": True}
    updates["updated_at"] = iso(now_utc())
    updates["updated_by"] = admin["username"]
    await db.vehicles.update_one({"id": vehicle_id}, {"$set": updates})
    return {"ok": True, "id": vehicle_id, "updated": list(updates.keys())}


@api.delete("/admin/vehicles/{vehicle_id}")
async def admin_retire_vehicle(vehicle_id: str, admin: Dict = Depends(require_write)):
    """Retire a vehicle (reversible). Refuses while a driver still holds it —
    unassign the driver first so a plate is never orphaned on a live driver."""
    veh = await db.vehicles.find_one({"id": vehicle_id}, {"_id": 0, "id": 1})
    if not veh:
        raise HTTPException(404, "vehicle_not_found")
    holder = await db.drivers.find_one(
        {"vehicle_id": vehicle_id, "archived": {"$ne": True}},
        {"_id": 0, "id": 1, "name": 1},
    )
    if holder:
        raise HTTPException(409, "vehicle_in_use")
    await db.vehicles.update_one(
        {"id": vehicle_id},
        {"$set": {"retired": True, "retired_at": iso(now_utc()),
                  "retired_by": admin["username"]}},
    )
    await _audit(admin, "retire_vehicle", vehicle_id)
    return {"ok": True, "id": vehicle_id, "retired": True}


@api.post("/admin/vehicles/{vehicle_id}/restore")
async def admin_restore_vehicle(vehicle_id: str, admin: Dict = Depends(require_write)):
    veh = await db.vehicles.find_one({"id": vehicle_id}, {"_id": 0, "id": 1})
    if not veh:
        raise HTTPException(404, "vehicle_not_found")
    await db.vehicles.update_one(
        {"id": vehicle_id},
        {"$set": {"retired": False}, "$unset": {"retired_at": "", "retired_by": ""}},
    )
    return {"ok": True, "id": vehicle_id, "retired": False}


@api.post("/admin/drivers")
async def admin_create_driver(body: DriverCreateIn, admin: Dict = Depends(require_write)):
    phone = body.phone.strip()
    if await db.drivers.find_one({"phone": phone}, {"_id": 0, "id": 1}):
        raise HTTPException(409, "phone_already_registered")
    if body.vehicle_id:
        veh = await db.vehicles.find_one({"id": body.vehicle_id}, {"_id": 0, "id": 1})
        if not veh:
            raise HTTPException(404, "vehicle_not_found")
    driver_id = str(uuid.uuid4())
    row = {
        "id": driver_id,
        "name": body.name.strip(),
        "phone": phone,
        "password_hash": hash_password(body.password),
        "vehicle_id": body.vehicle_id,
        "qr_code": f"RIDE91-DEPOSIT-{driver_id[:8].upper()}",
        "active": True,
        "status": body.status,
        "shift_type": body.shift_type,
        "hub_name": body.hub_name,
        "hub_lat": body.hub_lat,
        "hub_lng": body.hub_lng,
        "created_by": admin["username"],
        "created_at": iso(now_utc()),
    }
    await db.drivers.insert_one(row.copy())
    row.pop("_id", None)
    row.pop("password_hash", None)   # never return the hash
    await _audit(admin, "create_driver", driver_id, {"name": row["name"], "phone": phone})
    return row


@api.patch("/admin/drivers/{driver_id}")
async def admin_update_driver(
    driver_id: str, body: DriverUpdateIn, admin: Dict = Depends(require_write)
):
    driver = await db.drivers.find_one({"id": driver_id}, {"_id": 0})
    if not driver:
        raise HTTPException(404, "driver_not_found")
    updates: Dict[str, Any] = {}
    for field in ("name", "phone", "vehicle_id", "hub_name", "hub_lat",
                  "hub_lng", "shift_type", "status", "active"):
        val = getattr(body, field)
        if val is not None:
            updates[field] = val.strip() if isinstance(val, str) else val
    if "phone" in updates:
        clash = await db.drivers.find_one(
            {"phone": updates["phone"], "id": {"$ne": driver_id}}, {"_id": 0, "id": 1}
        )
        if clash:
            raise HTTPException(409, "phone_already_registered")
    if updates.get("vehicle_id"):
        if not await db.vehicles.find_one({"id": updates["vehicle_id"]}, {"_id": 0, "id": 1}):
            raise HTTPException(404, "vehicle_not_found")
    # Password reset is handled separately so the raw value never enters the
    # audit trail or the list of "updated" field names.
    password_reset = body.password is not None
    if password_reset:
        updates["password_hash"] = hash_password(body.password)
    if not updates:
        return {"ok": True, "unchanged": True}
    updates["updated_at"] = iso(now_utc())
    updates["updated_by"] = admin["username"]
    await db.drivers.update_one({"id": driver_id}, {"$set": updates})
    changed = [k for k in updates if k != "password_hash"]
    if password_reset:
        changed.append("password")
        await _audit(admin, "reset_driver_password", driver_id)
    return {"ok": True, "id": driver_id, "updated": changed}


@api.get("/admin/drivers/{driver_id}")
async def admin_driver_detail(driver_id: str, admin: Dict = Depends(get_admin)):
    """Everything about one driver on a single screen: profile, vehicle, cash
    balance, and recent documents / captures / inspections / requests /
    payouts. Media blobs are excluded — the review pages fetch those."""
    d = await db.drivers.find_one({"id": driver_id}, {"_id": 0})
    if not d:
        raise HTTPException(404, "driver_not_found")
    vehicle = None
    if d.get("vehicle_id"):
        vehicle = await db.vehicles.find_one(
            {"id": d["vehicle_id"]}, {"_id": 0}
        )
    balance = await _driver_balance(driver_id)

    async def _recent(coll, proj: Dict, sort_field: str, limit: int = 10):
        return [r async for r in coll.find(
            {"driver_id": driver_id}, {"_id": 0, **proj},
        ).sort(sort_field, -1).limit(limit)]

    documents = await _recent(
        db.documents, {"image_b64": 0}, "updated_at")
    for doc in documents:
        doc["label"] = DOCUMENT_LABELS.get(doc.get("type"), doc.get("type"))
        doc["status"] = _document_status(doc.get("expires_on"))
    captures = await _recent(
        db.go_online_captures,
        {"walkaround_video_b64": 0, "selfie_photo_b64": 0}, "created_at")
    inspections = await _recent(
        db.inspections,
        {"dashboard_photo_b64": 0, "exterior_video_b64": 0}, "created_at")
    requests = await _recent(db.requests, {}, "created_at")
    payouts = await _recent(db.payouts, {}, "created_at")
    deposits = [r async for r in db.qr_payments.find(
        {"driver_id": driver_id, "type": "deposit"}, {"_id": 0},
    ).sort("occurred_at", -1).limit(20)]
    notifications = await _recent(db.notifications, {}, "created_at", limit=50)

    return {
        "driver": {
            "id": d["id"],
            "name": d.get("name"),
            "phone": d.get("phone"),
            "hub_name": d.get("hub_name"),
            "hub_lat": d.get("hub_lat"),
            "hub_lng": d.get("hub_lng"),
            "shift_type": d.get("shift_type"),
            "status": d.get("status", "approved"),
            "active": d.get("active", True),
            "archived": bool(d.get("archived")),
            "vehicle_id": d.get("vehicle_id"),
            "qr_code": d.get("qr_code"),
            "created_at": d.get("created_at"),
        },
        "vehicle": vehicle,
        "balance": balance,
        "documents": documents,
        "captures": captures,
        "inspections": inspections,
        "requests": requests,
        "payouts": payouts,
        "deposits": deposits,
        "notifications": notifications,
    }


@api.delete("/admin/drivers/{driver_id}")
async def admin_delete_driver(
    driver_id: str, hard: bool = False, admin: Dict = Depends(require_write)
):
    """Remove a driver. Default is a reversible archive: the driver is
    deactivated, hidden from the roster, and their vehicle freed — cash and
    payout history are preserved for the audit trail. `hard=true` permanently
    deletes the driver record, and is refused when any financial history
    exists (deposits, platform cash, or payouts)."""
    d = await db.drivers.find_one({"id": driver_id}, {"_id": 0, "id": 1})
    if not d:
        raise HTTPException(404, "driver_not_found")

    if hard:
        has_money = (
            await db.qr_payments.find_one({"driver_id": driver_id}, {"_id": 1})
            or await db.platform_cash.find_one({"driver_id": driver_id}, {"_id": 1})
            or await db.payouts.find_one({"driver_id": driver_id}, {"_id": 1})
        )
        if has_money:
            raise HTTPException(409, "has_financial_history")
        await db.drivers.delete_one({"id": driver_id})
        await _audit(admin, "delete_driver", driver_id)
        return {"ok": True, "id": driver_id, "deleted": True}

    await db.drivers.update_one(
        {"id": driver_id},
        {"$set": {
            "archived": True,
            "active": False,
            "vehicle_id": None,          # free the plate for reassignment
            "archived_at": iso(now_utc()),
            "archived_by": admin["username"],
        }},
    )
    await _audit(admin, "archive_driver", driver_id)
    return {"ok": True, "id": driver_id, "archived": True}


@api.post("/admin/drivers/{driver_id}/restore")
async def admin_restore_driver(driver_id: str, admin: Dict = Depends(require_write)):
    d = await db.drivers.find_one({"id": driver_id}, {"_id": 0, "id": 1})
    if not d:
        raise HTTPException(404, "driver_not_found")
    await db.drivers.update_one(
        {"id": driver_id},
        {"$set": {"archived": False, "active": True},
         "$unset": {"archived_at": "", "archived_by": ""}},
    )
    return {"ok": True, "id": driver_id, "archived": False}


# ---- Live map --------------------------------------------------------------


@api.get("/admin/vehicles/live")
async def admin_vehicles_live(admin: Dict = Depends(get_admin)):
    """Latest ping per vehicle joined with the assigned driver.
    Returns only the fields the map dot + tooltip needs."""
    vehicles = [v async for v in db.vehicles.find({}, {"_id": 0})]
    drivers_by_vehicle: Dict[str, Dict[str, Any]] = {}
    async for d in db.drivers.find({"vehicle_id": {"$ne": None}}, {"_id": 0}):
        drivers_by_vehicle[d["vehicle_id"]] = d
    out: List[Dict[str, Any]] = []
    now = now_utc()
    for v in vehicles:
        last = await db.vehicle_pings.find_one(
            {"vehicle_id": v["id"]}, {"_id": 0}, sort=[("recorded_at", -1)]
        )
        if not last:
            continue
        d = drivers_by_vehicle.get(v["id"], {})
        try:
            age_min = (now - _parse_iso(last["recorded_at"])).total_seconds() / 60
        except Exception:
            age_min = None
        out.append(
            {
                "vehicle_id": v["id"],
                "vehicle_number": v.get("number"),
                "driver_id": d.get("id"),
                "driver_name": d.get("name"),
                "hub_name": d.get("hub_name"),
                "lat": last["lat"],
                "lng": last["lng"],
                "speed_kmph": last.get("speed_kmph"),
                "soc_pct": last.get("soc_pct") or v.get("current_soc"),
                "accuracy_m": last.get("accuracy_m"),
                "recorded_at": last["recorded_at"],
                "age_minutes": round(age_min, 1) if age_min is not None else None,
                "stale": bool(age_min is not None and age_min > 10),
            }
        )
    return {"items": out, "count": len(out), "server_ts": iso(now)}


# ---------------------------------------------------------------------------
# DASHBOARD — Ride91 metrics + chart series
#
# Built for an employer-operator, not a commission marketplace: the numbers
# that matter are duty, cash owed vs collected vs deposited, over-limit
# drivers, and settled trips/earnings from the platform reports — plus the
# booking tallies. No admin-commission / wallet / franchise concepts.
# ---------------------------------------------------------------------------
@api.get("/admin/dashboard")
async def admin_dashboard(days: int = 30, admin: Dict = Depends(get_admin)):
    days = max(7, min(int(days), 90))
    today_bd = business_date_now()
    today_d = datetime.strptime(today_bd, "%Y-%m-%d").date()
    from_bd = (today_d - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    day_start, day_end = business_day_bounds(today_bd)

    total_drivers = await db.drivers.count_documents({})
    approved = await db.drivers.count_documents({"status": "approved"})
    waiting = await db.drivers.count_documents({"status": "pending"})
    total_vehicles = await db.vehicles.count_documents({})

    on_duty = 0
    async for _r in db.duty_states.aggregate([
        {"$match": {"started_at": {"$gte": iso(day_start), "$lt": iso(day_end)},
                    "state": {"$in": ["start_duty", "end_duty"]}}},
        {"$sort": {"started_at": 1}},
        {"$group": {"_id": "$driver_id", "last": {"$last": "$state"}}},
        {"$match": {"last": "start_duty"}},
        {"$count": "n"},
    ]):
        on_duty = _r["n"]

    # Fleet cash position, from the same running-balance rule as everywhere.
    balances = await _driver_balances()
    total_owed = round(sum(b["you_owe"] for b in balances.values()), 2)
    over_limit = sum(1 for b in balances.values() if b["over_limit"])
    collected_all = round(sum(b["collected_to_yesterday"] for b in balances.values()), 2)
    paid_all = round(sum(b["paid_in_total"] for b in balances.values()), 2)
    paid_today = round(sum(b["paid_in_today"] for b in balances.values()), 2)

    # Settled trips + earnings per business day, for the charts.
    per_day: Dict[str, Dict[str, float]] = {}
    async for r in db.platform_cash.aggregate([
        {"$match": {"status": "settled", "business_date": {"$gte": from_bd}}},
        {"$group": {"_id": "$business_date",
                    "cash": {"$sum": "$cash_amount"},
                    "gross": {"$sum": {"$ifNull": ["$gross_amount", "$cash_amount"]}},
                    "rows": {"$sum": 1}}},
    ]):
        per_day[r["_id"]] = {"cash": r["cash"], "gross": r["gross"], "rows": r["rows"]}

    # Deposits per business day (trusted sources only).
    dep_day: Dict[str, float] = {}
    async for r in db.qr_payments.aggregate([
        {"$match": {"type": "deposit",
                    "source": {"$in": sorted(TRUSTED_CASH_SOURCES)},
                    "business_date": {"$gte": from_bd}}},
        {"$group": {"_id": "$business_date", "amt": {"$sum": "$amount"}}},
    ]):
        dep_day[r["_id"]] = r["amt"]

    series = []
    for i in range(days):
        bd = (today_d - timedelta(days=days - 1 - i)).strftime("%Y-%m-%d")
        pd = per_day.get(bd, {})
        series.append({
            "date": bd,
            "gross": round(pd.get("gross", 0.0), 2),
            "cash": round(pd.get("cash", 0.0), 2),
            "deposited": round(dep_day.get(bd, 0.0), 2),
        })

    bookings = await _booking_counts()

    return {
        "business_date": today_bd,
        "cards": {
            "total_drivers": total_drivers,
            "approved_drivers": approved,
            "drivers_waiting": waiting,
            "total_vehicles": total_vehicles,
            "on_duty_now": on_duty,
            "cash_owed": total_owed,
            "over_limit": over_limit,
            "collected_all": collected_all,
            "paid_all": paid_all,
            "paid_today": paid_today,
        },
        "bookings": bookings,
        "series": series,
        "server_ts": iso(now_utc()),
    }


# ---- Capture review queue --------------------------------------------------


@api.get("/admin/captures/pending")
async def admin_captures_pending(
    include_all: bool = False, admin: Dict = Depends(get_admin)
):
    """Captures that need ops review. By default: flagged for movement or
    beyond the hub-warn radius and not yet reviewed. `include_all=true`
    returns every capture regardless of flags."""
    query: Dict[str, Any] = {}
    if not include_all:
        query = {
            "$or": [{"review_flag_movement": True}, {"hub_warn": True}],
            "review_decision": {"$exists": False},
        }
    cursor = db.go_online_captures.find(
        query,
        {"_id": 0, "walkaround_video_b64": 0, "selfie_photo_b64": 0},
    ).sort("created_at", -1)
    items: List[Dict[str, Any]] = []
    drivers_by_id: Dict[str, Dict[str, Any]] = {}
    async for r in cursor:
        did = r.get("driver_id")
        if did and did not in drivers_by_id:
            drivers_by_id[did] = await db.drivers.find_one(
                {"id": did}, {"_id": 0, "name": 1, "phone": 1, "hub_name": 1}
            ) or {}
        d = drivers_by_id.get(did, {})
        r["driver_name"] = d.get("name")
        r["driver_phone"] = d.get("phone")
        r["driver_hub"] = d.get("hub_name")
        items.append(r)
    return {"items": items, "count": len(items)}


@api.get("/admin/captures/{capture_id}/media")
async def admin_capture_media(capture_id: str, admin: Dict = Depends(get_admin)):
    row = await db.go_online_captures.find_one({"id": capture_id}, {"_id": 0})
    if not row:
        raise HTTPException(404, "capture_not_found")
    return {
        "id": row["id"],
        "walkaround_video_b64": row.get("walkaround_video_b64"),
        "walkaround_video_mime": row.get("walkaround_video_mime"),
        "selfie_photo_b64": row.get("selfie_photo_b64"),
    }


@api.post("/admin/captures/{capture_id}/review")
async def admin_capture_review(
    capture_id: str, body: ReviewIn, admin: Dict = Depends(require_write)
):
    row = await db.go_online_captures.find_one({"id": capture_id}, {"_id": 0})
    if not row:
        raise HTTPException(404, "capture_not_found")
    await db.go_online_captures.update_one(
        {"id": capture_id},
        {
            "$set": {
                "review_decision": body.decision,
                "review_note": body.note,
                "reviewed_at": iso(now_utc()),
                "reviewed_by": admin["username"],
            }
        },
    )
    return {"ok": True, "capture_id": capture_id, "decision": body.decision}


# ---- Document verification queue ------------------------------------------


@api.get("/admin/documents/pending")
async def admin_documents_pending(
    include_all: bool = False, admin: Dict = Depends(get_admin)
):
    """Documents where an image has been uploaded but not yet verified.
    `include_all=true` returns every document regardless of state."""
    query: Dict[str, Any] = {} if include_all else {
        "verified": False,
        "image_b64": {"$ne": None},
    }
    cursor = db.documents.find(
        query, {"_id": 0, "image_b64": 0}
    ).sort("updated_at", -1)
    items: List[Dict[str, Any]] = []
    drivers_by_id: Dict[str, Dict[str, Any]] = {}
    async for r in cursor:
        did = r.get("driver_id")
        if did and did not in drivers_by_id:
            drivers_by_id[did] = await db.drivers.find_one(
                {"id": did}, {"_id": 0, "name": 1, "phone": 1}
            ) or {}
        d = drivers_by_id.get(did, {})
        r["driver_name"] = d.get("name")
        r["driver_phone"] = d.get("phone")
        r["label"] = DOCUMENT_LABELS.get(r["type"], r["type"])
        r["status"] = _document_status(r.get("expires_on"))
        items.append(r)
    return {"items": items, "count": len(items)}


@api.get("/admin/documents/{document_id}/media")
async def admin_document_media(document_id: str, admin: Dict = Depends(get_admin)):
    row = await db.documents.find_one({"id": document_id}, {"_id": 0})
    if not row:
        raise HTTPException(404, "document_not_found")
    return {"id": row["id"], "image_b64": row.get("image_b64")}


@api.post("/admin/documents/{document_id}/review")
async def admin_document_review(
    document_id: str, body: ReviewIn, admin: Dict = Depends(require_write)
):
    row = await db.documents.find_one({"id": document_id}, {"_id": 0})
    if not row:
        raise HTTPException(404, "document_not_found")
    await db.documents.update_one(
        {"id": document_id},
        {
            "$set": {
                "verified": body.decision == "approve",
                "review_decision": body.decision,
                "review_note": body.note,
                "reviewed_at": iso(now_utc()),
                "reviewed_by": admin["username"],
                "updated_at": iso(now_utc()),
            }
        },
    )
    return {"ok": True, "document_id": document_id, "decision": body.decision}


@api.get("/admin/summary")
async def admin_summary(admin: Dict = Depends(get_admin)):
    """One-shot counts for the dashboard tiles."""
    total_drivers = await db.drivers.count_documents({})
    today_key = business_date_now()
    day_start, day_end = business_day_bounds(today_key)
    duty_starts = await db.duty_states.count_documents(
        {"state": "start_duty",
         "started_at": {"$gte": iso(day_start), "$lt": iso(day_end)}}
    )
    duty_ends = await db.duty_states.count_documents(
        {"state": "end_duty",
         "started_at": {"$gte": iso(day_start), "$lt": iso(day_end)}}
    )
    captures_pending = await db.go_online_captures.count_documents(
        {"$or": [{"review_flag_movement": True}, {"hub_warn": True}],
         "review_decision": {"$exists": False}}
    )
    docs_pending = await db.documents.count_documents(
        {"verified": False, "image_b64": {"$ne": None}}
    )
    docs_expiring = await db.documents.count_documents(
        # Naive: rely on the status helper by fetching a small projection.
        {"expires_on": {"$ne": None}}
    )
    # Refine docs_expiring with the helper (small collection).
    async for r in db.documents.find({"expires_on": {"$ne": None}}, {"_id": 0, "expires_on": 1}):
        pass  # count above is loose; the review queue is the authoritative source
    return {
        "total_drivers": total_drivers,
        "on_duty_now": max(0, duty_starts - duty_ends),
        "captures_pending": captures_pending,
        "documents_pending": docs_pending,
        "business_date": today_key,
    }


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
# UBER PAYMENTS REPORT IMPORT (admin) -> settled platform_cash
#
# Fleet Hub > Reports > "Payments Driver", generated for a SINGLE business day,
# then uploaded here. Settled rows supersede the driver's own OCR row for the
# same (driver_id, platform, business_date): the screenshot is a same-day
# estimate, this is the truth.
#
# Quirks of the real file, all load-bearing:
#   * UTF-8 BOM on the header, so "Driver UUID" only matches under utf-8-sig.
#   * "Payouts : Cash collected" is a payout, i.e. NEGATIVE. We store abs().
#   * One row is the organisation, not a driver: zero earnings and the only
#     non-zero bank transfer. Identified by uuid, skipped.
#   * Colon spacing in headers is inconsistent ("Payouts : Cash collected" vs
#     "Total earnings:Tip"). Never normalise; match the exact strings.
#   * There is NO date column, which is why business_date is a parameter. The
#     filename carries the window (20260907-20260914-payments_driver-...), so
#     we parse it and refuse anything wider than one day.
# ---------------------------------------------------------------------------
UBER_COL_UUID = "Driver UUID"
UBER_COL_FIRST = "Driver first name"
UBER_COL_LAST = "Driver surname"
UBER_COL_GROSS = "Total earnings"
UBER_COL_CASH = "Payouts : Cash collected"
UBER_COL_BANK = "Payouts : Transferred To Bank Account"

_UBER_FNAME_WINDOW = re.compile(r"(\d{8})-(\d{8})-payments_driver", re.I)


def _uber_num(raw: Optional[str]) -> float:
    """'-5,994.30' -> -5994.30; blank/'-'/None -> 0.0."""
    if raw is None:
        return 0.0
    s = raw.strip().replace(",", "").replace("₹", "")
    if s in ("", "-", "NA", "N/A"):
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def _uber_window_from_filename(name: str) -> Optional[tuple[str, str]]:
    m = _UBER_FNAME_WINDOW.search(name or "")
    if not m:
        return None
    fmt = lambda s: f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
    return fmt(m.group(1)), fmt(m.group(2))


@api.post("/admin/platform-cash/import")
async def admin_import_uber_payments(
    file: UploadFile = File(...),
    business_date: Optional[str] = Form(default=None),
    platform: str = Form(default="uber"),
    dry_run: bool = Form(default=False),
    admin: Dict = Depends(require_write),
):
    if platform not in PLATFORMS:
        raise HTTPException(400, "unknown_platform")

    window = _uber_window_from_filename(file.filename or "")
    if business_date is None:
        if not window:
            raise HTTPException(
                400, "business_date_required: filename carries no window"
            )
        start_d = datetime.strptime(window[0], "%Y-%m-%d")
        end_d = datetime.strptime(window[1], "%Y-%m-%d")
        if (end_d - start_d).days != 1:
            raise HTTPException(
                400,
                f"window_too_wide: file covers {window[0]}..{window[1]}. "
                "Generate the report for a single day, or pass business_date "
                "explicitly to override.",
            )
        business_date = window[0]

    try:
        datetime.strptime(business_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "business_date_must_be_YYYY_MM_DD")

    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")       # BOM
    except UnicodeDecodeError:
        raise HTTPException(400, "file_not_utf8")

    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or UBER_COL_UUID not in reader.fieldnames:
        raise HTTPException(
            400, f"unexpected_columns: '{UBER_COL_UUID}' not found"
        )
    for col in (UBER_COL_GROSS, UBER_COL_CASH):
        if col not in reader.fieldnames:
            raise HTTPException(400, f"unexpected_columns: missing '{col}'")

    start, end = business_day_bounds(business_date)
    imported: List[Dict] = []
    unmatched: List[Dict] = []
    skipped_org: List[str] = []
    now_iso = iso(now_utc())

    for rec in reader:
        uuid_ = (rec.get(UBER_COL_UUID) or "").strip()
        if not uuid_:
            continue
        name = " ".join(
            p for p in [
                (rec.get(UBER_COL_FIRST) or "").strip(),
                (rec.get(UBER_COL_LAST) or "").strip(),
            ] if p
        )
        gross = _uber_num(rec.get(UBER_COL_GROSS))
        cash = abs(_uber_num(rec.get(UBER_COL_CASH)))       # payout -> positive
        bank = _uber_num(rec.get(UBER_COL_BANK))

        # The organisation's own settlement row: no earnings, no cash, and the
        # only row with a bank transfer. Never a driver.
        if gross == 0.0 and cash == 0.0 and bank != 0.0:
            skipped_org.append(uuid_)
            continue

        driver = await db.drivers.find_one(
            {"uber_driver_uuid": uuid_}, {"_id": 0, "id": 1}
        )
        if not driver:
            unmatched.append({"uber_driver_uuid": uuid_, "name": name,
                              "cash_collected": round(cash, 2)})
            continue

        row = {
            "driver_id": driver["id"],
            "platform": platform,
            "cash_amount": round(cash, 2),
            "gross_amount": round(gross, 2),
            "business_date": business_date,
            "window_start": iso(start),
            "window_end": iso(end),
            "source": "uber_report",
            "status": "settled",
            "uber_driver_uuid": uuid_,
            "report_filename": file.filename,
            "imported_by": admin["username"],
            "updated_at": now_iso,
        }
        if not dry_run:
            # Settled supersedes whatever the driver reported for this day.
            await db.platform_cash.update_one(
                {"driver_id": driver["id"], "platform": platform,
                 "business_date": business_date},
                {"$set": row,
                 "$setOnInsert": {"id": str(uuid.uuid4()),
                                  "created_at": now_iso}},
                upsert=True,
            )
        imported.append({"driver_id": driver["id"], "name": name,
                         "cash_amount": row["cash_amount"],
                         "gross_amount": row["gross_amount"]})

    return {
        "ok": True,
        "dry_run": dry_run,
        "business_date": business_date,
        "platform": platform,
        "file_window": {"from": window[0], "to": window[1]} if window else None,
        "imported_count": len(imported),
        "imported": imported,
        "unmatched_count": len(unmatched),
        "unmatched": unmatched,
        "skipped_org_rows": skipped_org,
        "total_cash": round(sum(r["cash_amount"] for r in imported), 2),
    }


@api.post("/admin/drivers/{driver_id}/link-uber-uuid")
async def admin_link_uber_uuid(
    driver_id: str, body: LinkUberUuidIn, admin: Dict = Depends(require_write)
):
    """One-time wiring so imports can resolve a driver by Uber's stable id."""
    driver = await db.drivers.find_one({"id": driver_id}, {"_id": 0, "id": 1})
    if not driver:
        raise HTTPException(404, "driver_not_found")
    clash = await db.drivers.find_one(
        {"uber_driver_uuid": body.uber_driver_uuid, "id": {"$ne": driver_id}},
        {"_id": 0, "id": 1},
    )
    if clash:
        raise HTTPException(409, f"uuid_already_linked_to:{clash['id']}")
    await db.drivers.update_one(
        {"id": driver_id},
        {"$set": {"uber_driver_uuid": body.uber_driver_uuid,
                  "uber_uuid_linked_by": admin["username"],
                  "uber_uuid_linked_at": iso(now_utc())}},
    )
    return {"ok": True, "driver_id": driver_id,
            "uber_driver_uuid": body.uber_driver_uuid}


# ---------------------------------------------------------------------------
# CASH CLEARANCE
#
# The driver-facing POST /api/qr-payment was removed. It accepted a
# client-supplied type ('fare' or 'deposit') under driver auth, and because
# _cash_snapshot subtracts BOTH from cash_in_hand, either value let a driver
# clear their own dues by asserting it. No client ever called it — only the
# backend tests did.
#
# A driver's cash is now cleared by exactly two paths:
#   1. Paying in the app  -> POST /api/payments/razorpay/orders, amount set
#      server-side from _driver_dues_paise, row written by the webhook.
#   2. Handing cash to ops -> the admin endpoint below, which is audited.
# ---------------------------------------------------------------------------
@api.post("/admin/drivers/{driver_id}/cash-deposit")
async def admin_record_cash_deposit(
    driver_id: str, body: ManualDepositIn, admin: Dict = Depends(require_write)
):
    """Record cash a driver handed over off-app (hub, ops, bank slip).

    Kept deliberately narrow: ops auth, a mandatory reason for the audit
    trail, and idempotent on (driver_id, reference) so a double-submit from
    the admin panel cannot credit the same hand-in twice.
    """
    driver = await db.drivers.find_one({"id": driver_id}, {"_id": 0, "id": 1})
    if not driver:
        raise HTTPException(404, "driver_not_found")
    if body.amount <= 0:
        raise HTTPException(400, "amount_must_be_positive")

    existing = await db.qr_payments.find_one(
        {"driver_id": driver_id, "reference": body.reference,
         "source": "admin_manual"},
        {"_id": 0},
    )
    if existing:
        return {"ok": True, "duplicate": True, "row": existing}

    occurred_at = body.occurred_at or iso(now_utc())
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver_id,
        "amount": round(body.amount, 2),
        "type": "deposit",
        "reference": body.reference,
        "platform": None,
        "occurred_at": occurred_at,
        "business_date": business_date_from_dt(_parse_iso(occurred_at)),
        "source": "admin_manual",
        "reason": body.reason,
        "recorded_by": admin["username"],
        # qr_payments has a UNIQUE index on (driver_id, client_action_id), so
        # deriving the key from the reference makes the database itself reject
        # a duplicate hand-in — and stops two rows colliding on a null key.
        "client_action_id": f"admin-deposit:{body.reference}",
        "created_at": iso(now_utc()),
    }
    await db.qr_payments.insert_one(row.copy())
    row.pop("_id", None)
    await _audit(admin, "cash_deposit", driver_id,
                 {"amount": row["amount"], "reference": body.reference})
    return {"ok": True, "duplicate": False, "row": row}


# ---------------------------------------------------------------------------
# OPS QUEUES (admin) — cash reconciliation, driver requests, daily vehicle
# inspections, and shift-alarm responses. Read-mostly views over data the
# driver app produces, plus the few write actions ops needs.
# ---------------------------------------------------------------------------
async def _drivers_by_ids(ids: List[str]) -> Dict[str, Dict]:
    """One query: id -> {name, phone, hub_name, vehicle_id}. Decorates a list
    of rows with their driver without an N+1 lookup per row."""
    uniq = [i for i in dict.fromkeys(ids) if i]
    if not uniq:
        return {}
    out: Dict[str, Dict] = {}
    async for d in db.drivers.find(
        {"id": {"$in": uniq}},
        {"_id": 0, "id": 1, "name": 1, "phone": 1, "hub_name": 1, "vehicle_id": 1},
    ):
        out[d["id"]] = d
    return out


class RequestDecisionIn(BaseModel):
    decision: Literal["approve", "reject"]
    note: Optional[str] = None


@api.get("/admin/cash")
async def admin_cash(admin: Dict = Depends(get_admin)):
    """Fleet cash reconciliation: per driver, settled platform cash collected
    (to yesterday) minus trusted deposits paid in. Reuses the single balance
    rule in `_driver_balances` so this never drifts from the driver's screen."""
    drivers = [d async for d in db.drivers.find(
        {"active": True},
        {"_id": 0, "id": 1, "name": 1, "phone": 1, "hub_name": 1},
    )]
    ids = [d["id"] for d in drivers]
    balances = await _driver_balances(ids)
    rows: List[Dict[str, Any]] = []
    for d in drivers:
        b = balances.get(d["id"], {})
        rows.append({
            "driver_id": d["id"],
            "name": d.get("name"),
            "phone": d.get("phone"),
            "hub_name": d.get("hub_name"),
            "collected_to_yesterday": b.get("collected_to_yesterday", 0.0),
            "paid_in_total": b.get("paid_in_total", 0.0),
            "paid_in_today": b.get("paid_in_today", 0.0),
            "balance": b.get("balance", 0.0),
            "you_owe": b.get("you_owe", 0.0),
            "in_credit": b.get("in_credit", 0.0),
            "over_limit": b.get("over_limit", False),
        })
    rows.sort(key=lambda r: r["you_owe"], reverse=True)
    totals = {
        "collected_to_yesterday": round(sum(r["collected_to_yesterday"] for r in rows), 2),
        "paid_in_total": round(sum(r["paid_in_total"] for r in rows), 2),
        "paid_in_today": round(sum(r["paid_in_today"] for r in rows), 2),
        "owed": round(sum(r["you_owe"] for r in rows), 2),
        "over_limit": sum(1 for r in rows if r["over_limit"]),
    }
    return {
        "items": rows, "totals": totals, "count": len(rows),
        "cash_limit": get_setting("cash_limit", CASH_LIMIT), "as_of_business_date": business_date_now(),
    }


@api.get("/admin/requests")
async def admin_requests(state: Optional[str] = None, admin: Dict = Depends(get_admin)):
    """Driver requests (advance / holiday / extra hours). `?state=pending`
    filters the queue."""
    query: Dict[str, Any] = {}
    if state:
        query["state"] = state
    rows = [r async for r in db.requests.find(query, {"_id": 0}).sort("created_at", -1)]
    who = await _drivers_by_ids([r.get("driver_id") for r in rows])
    for r in rows:
        d = who.get(r.get("driver_id"), {})
        r["driver_name"] = d.get("name")
        r["driver_phone"] = d.get("phone")
    pending = sum(1 for r in rows if r.get("state") == "pending")
    return {"items": rows, "count": len(rows), "pending": pending}


@api.post("/admin/requests/{request_id}/decide")
async def admin_decide_request(
    request_id: str, body: RequestDecisionIn, admin: Dict = Depends(require_write)
):
    """Approve or reject a driver request. Records who decided and when. An
    approved `advance` does NOT itself touch the advances ledger — that stays a
    separate, deliberate action so a balance is never moved by a click here."""
    row = await db.requests.find_one({"id": request_id}, {"_id": 0})
    if not row:
        raise HTTPException(404, "request_not_found")
    if row.get("state") != "pending":
        raise HTTPException(409, "already_decided")
    state = "approved" if body.decision == "approve" else "rejected"
    await db.requests.update_one(
        {"id": request_id},
        {"$set": {
            "state": state,
            "decided_at": iso(now_utc()),
            "decided_by": admin["username"],
            "decision_note": body.note,
        }},
    )
    await _audit(admin, "decide_request", request_id,
                 {"decision": body.decision, "type": row.get("type")})
    return {"ok": True, "id": request_id, "state": state}


@api.get("/admin/inspections")
async def admin_inspections(admin: Dict = Depends(get_admin)):
    """Daily vehicle inspections (dashboard photo + walkaround video). Media
    blobs are excluded here; fetch one via /admin/inspections/{id}/media."""
    rows = [r async for r in db.inspections.find(
        {}, {"_id": 0, "dashboard_photo_b64": 0, "exterior_video_b64": 0},
    ).sort("created_at", -1).limit(500)]
    who = await _drivers_by_ids([r.get("driver_id") for r in rows])
    veh_ids = list({r.get("vehicle_id") for r in rows if r.get("vehicle_id")})
    veh: Dict[str, Optional[str]] = {}
    if veh_ids:
        async for v in db.vehicles.find(
            {"id": {"$in": veh_ids}}, {"_id": 0, "id": 1, "number": 1}
        ):
            veh[v["id"]] = v.get("number")
    for r in rows:
        d = who.get(r.get("driver_id"), {})
        r["driver_name"] = d.get("name")
        r["driver_phone"] = d.get("phone")
        r["vehicle_number"] = veh.get(r.get("vehicle_id"))
        r["has_photo"] = True   # every inspection carries a dashboard photo
    return {"items": rows, "count": len(rows)}


@api.get("/admin/inspections/{inspection_id}/media")
async def admin_inspection_media(inspection_id: str, admin: Dict = Depends(get_admin)):
    row = await db.inspections.find_one({"id": inspection_id}, {"_id": 0})
    if not row:
        raise HTTPException(404, "inspection_not_found")
    return {
        "id": row["id"],
        "dashboard_photo_b64": row.get("dashboard_photo_b64"),
        "exterior_video_b64": row.get("exterior_video_b64"),
        "exterior_video_mime": row.get("exterior_video_mime"),
    }


@api.get("/admin/shift-alarms")
async def admin_shift_alarms(admin: Dict = Depends(get_admin)):
    """Recent shift-alarm responses across the fleet — who acknowledged, who
    said they weren't coming, and the reason given."""
    rows = [r async for r in db.alarm_responses.find(
        {}, {"_id": 0}
    ).sort("created_at", -1).limit(500)]
    who = await _drivers_by_ids([r.get("driver_id") for r in rows])
    for r in rows:
        d = who.get(r.get("driver_id"), {})
        r["driver_name"] = d.get("name")
        r["driver_phone"] = d.get("phone")
    not_coming = sum(1 for r in rows if r.get("response") == "not_coming")
    return {"items": rows, "count": len(rows), "not_coming": not_coming}


# ---- Notifications (admin) ------------------------------------------------
@api.get("/admin/notifications")
async def admin_list_notifications(
    unread_only: bool = False, admin: Dict = Depends(get_admin)
):
    """Feed of driver → ops notifications across the fleet (newest first),
    with the count still unread by ops — drives the header badge."""
    query: Dict[str, Any] = {"direction": "from_driver"}
    if unread_only:
        query["read"] = False
    rows = [r async for r in db.notifications.find(query, {"_id": 0})
            .sort("created_at", -1).limit(200)]
    who = await _drivers_by_ids([r.get("driver_id") for r in rows])
    for r in rows:
        d = who.get(r.get("driver_id"), {})
        r["driver_name"] = d.get("name")
        r["driver_phone"] = d.get("phone")
    unread = await db.notifications.count_documents(
        {"direction": "from_driver", "read": False}
    )
    return {"items": rows, "count": len(rows), "unread": unread}


@api.get("/admin/drivers/{driver_id}/notifications")
async def admin_driver_notifications(driver_id: str, admin: Dict = Depends(get_admin)):
    rows = [r async for r in db.notifications.find(
        {"driver_id": driver_id}, {"_id": 0}
    ).sort("created_at", -1).limit(100)]
    return {"items": rows, "count": len(rows)}


@api.post("/admin/drivers/{driver_id}/notifications")
async def admin_send_notification(
    driver_id: str, body: AdminNotifyIn, admin: Dict = Depends(require_write)
):
    """Ops sends a message to a driver — appears on the driver app's bell."""
    driver = await db.drivers.find_one({"id": driver_id}, {"_id": 0, "id": 1})
    if not driver:
        raise HTTPException(404, "driver_not_found")
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver_id,
        "direction": "to_driver",
        "body": body.body.strip(),
        "created_at": iso(now_utc()),
        "created_by": admin["username"],
        "read": False,
        "read_at": None,
    }
    await db.notifications.insert_one(row.copy())
    row.pop("_id", None)
    await _audit(admin, "notify_driver", driver_id)
    return row


@api.post("/admin/notifications/{notification_id}/read")
async def admin_mark_notification_read(
    notification_id: str, admin: Dict = Depends(require_write)
):
    """Ops marks a driver → ops message as handled."""
    await db.notifications.update_one(
        {"id": notification_id, "direction": "from_driver"},
        {"$set": {"read": True, "read_at": iso(now_utc()), "read_by": admin["username"]}},
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# BOOKINGS (admin) — map-free scheduled rides
# ---------------------------------------------------------------------------
def _booking_ref() -> str:
    return f"RB-{business_date_now().replace('-', '')}-{uuid.uuid4().hex[:5].upper()}"


@api.post("/admin/bookings")
async def admin_create_booking(
    body: BookingCreateIn, admin: Dict = Depends(require_write)
):
    now = iso(now_utc())
    row = {
        "id": str(uuid.uuid4()),
        "ref": _booking_ref(),
        "rider_name": body.rider_name.strip(),
        "rider_phone": body.rider_phone.strip(),
        "pickup_text": body.pickup_text.strip(),
        "drop_text": body.drop_text.strip(),
        "scheduled_at": body.scheduled_at,          # None = ASAP
        "vehicle_type": body.vehicle_type,
        "fare_estimate": body.fare_estimate,
        "notes": body.notes,
        "status": "requested",
        "driver_id": None,
        "vehicle_id": None,
        "source": "ops",
        "business_date": business_date_now(),
        # Append-only, like duty_states: the current status is always the last
        # entry, never edited in place.
        "status_history": [
            {"status": "requested", "at": now, "by": admin["username"], "note": None},
        ],
        "created_by": admin["username"],
        "created_at": now,
        "updated_at": now,
    }
    await db.bookings.insert_one(row.copy())
    row.pop("_id", None)
    return row


@api.get("/admin/bookings")
async def admin_list_bookings(
    status: Optional[str] = None,
    scope: str = "all",          # all | open | closed
    limit: int = 50,
    skip: int = 0,
    admin: Dict = Depends(get_admin),
):
    limit = max(1, min(int(limit), 200))
    q: Dict[str, Any] = {}
    if status:
        q["status"] = status
    elif scope == "open":
        q["status"] = {"$in": sorted(BOOKING_OPEN_STATES)}
    elif scope == "closed":
        q["status"] = {"$in": sorted(BOOKING_CLOSED_STATES)}
    total = await db.bookings.count_documents(q)
    cursor = (
        db.bookings.find(q, {"_id": 0})
        .sort("created_at", -1)
        .skip(int(skip))
        .limit(limit)
    )
    items = [r async for r in cursor]
    return {"items": items, "total": total, "limit": limit, "skip": skip}


@api.get("/admin/bookings/{booking_id}")
async def admin_get_booking(booking_id: str, admin: Dict = Depends(get_admin)):
    row = await db.bookings.find_one({"id": booking_id}, {"_id": 0})
    if not row:
        raise HTTPException(404, "booking_not_found")
    return row


@api.post("/admin/bookings/{booking_id}/status")
async def admin_update_booking_status(
    booking_id: str, body: BookingStatusIn, admin: Dict = Depends(require_write)
):
    row = await db.bookings.find_one({"id": booking_id}, {"_id": 0})
    if not row:
        raise HTTPException(404, "booking_not_found")
    now = iso(now_utc())
    entry = {"status": body.status, "at": now, "by": admin["username"],
             "note": body.note}
    updates: Dict[str, Any] = {"status": body.status, "updated_at": now}
    # Assignment is recorded but not dispatched — no fleet validation yet.
    if body.driver_id is not None:
        updates["driver_id"] = body.driver_id
    if body.vehicle_id is not None:
        updates["vehicle_id"] = body.vehicle_id
    await db.bookings.update_one(
        {"id": booking_id},
        {"$set": updates, "$push": {"status_history": entry}},
    )
    return {"ok": True, "id": booking_id, "status": body.status}


async def _booking_counts() -> Dict:
    """Booking tallies for the dashboard, in one aggregation."""
    today_bd = business_date_now()
    by_status: Dict[str, int] = {}
    async for r in db.bookings.aggregate([
        {"$group": {"_id": "$status", "n": {"$sum": 1}}},
    ]):
        by_status[r["_id"]] = r["n"]
    open_count = sum(by_status.get(s, 0) for s in BOOKING_OPEN_STATES)
    today_count = await db.bookings.count_documents({"business_date": today_bd})
    scheduled_ahead = await db.bookings.count_documents({
        "scheduled_at": {"$gt": iso(now_utc())},
        "status": {"$in": sorted(BOOKING_OPEN_STATES)},
    })
    return {
        "by_status": by_status,
        "open": open_count,
        "today": today_count,
        "scheduled_ahead": scheduled_ahead,
        "total": sum(by_status.values()),
    }


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
    bal = await _driver_balance(driver["id"])
    return {
        "business_date": today_bd,
        # Today's activity, for the driver's own view of the shift. These are
        # provisional until the report lands and do NOT drive what is owed.
        "per_platform": snap["per_platform"],       # includes 'status' per platform
        "total_cash_fares": snap["total_cash_fares"],
        "qr_fares": snap["qr_fares"],
        "deposits": snap["deposits"],
        # The settled account. Earnings come from reports up to yesterday;
        # payments count the moment Razorpay confirms them, today included.
        "collected_to_yesterday": bal["collected_to_yesterday"],
        "paid_in_today": bal["paid_in_today"],
        "paid_in_total": bal["paid_in_total"],
        "balance": bal["balance"],
        "you_owe": bal["you_owe"],
        "in_credit": bal["in_credit"],
        "cash_limit": get_setting("cash_limit", CASH_LIMIT),
        "cash_over_limit": bal["over_limit"],
        # Kept so existing screens keep rendering; it is today's provisional
        # figure, not the amount owed. Use `you_owe` for anything payable.
        "cash_in_hand": snap["cash_in_hand"],
    }


@api.get("/money/ledger")
async def money_ledger(days: int = 14, driver: Dict = Depends(get_driver)):
    """Running cash tally: what was collected, what was paid in, what is left.

    money/today answers "where do I stand now"; this answers "how did I get
    here" — one chronological line per event with the balance after it, which
    is what makes a disputed figure checkable by the driver themselves.
    Deposits come only from trusted sources (see _fetch_qr_payments).
    """
    days = max(1, min(int(days), 90))
    today_bd = business_date_now()
    today_d = datetime.strptime(today_bd, "%Y-%m-%d").date()
    from_bd = (today_d - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    to_bd = (today_d + timedelta(days=1)).strftime("%Y-%m-%d")

    pc = await _fetch_platform_cash(driver["id"], from_bd, to_bd)
    qr = await _fetch_qr_payments(driver["id"], from_bd, to_bd)

    events: List[Dict] = []
    for r in pc:
        events.append({
            "business_date": r["business_date"],
            "at": r.get("window_end") or r.get("created_at"),
            "kind": "collected",
            "direction": "+",                      # increases cash in hand
            "amount": round(float(r.get("cash_amount", 0)), 2),
            "platform": r.get("platform"),
            "status": r.get("status"),
            "source": r.get("source"),
            "reference": None,
        })
    for r in qr:
        events.append({
            "business_date": r["business_date"],
            "at": r.get("occurred_at") or r.get("created_at"),
            "kind": "deposit" if r["type"] == "deposit" else "digital_fare",
            "direction": "-",                      # reduces cash in hand
            "amount": round(float(r.get("amount", 0)), 2),
            "platform": r.get("platform"),
            "status": "settled",
            "source": r.get("source"),
            "reference": r.get("reference"),
        })

    events.sort(key=lambda e: (e["business_date"], e["at"] or ""))
    balance = 0.0
    for e in events:
        balance += e["amount"] if e["direction"] == "+" else -e["amount"]
        e["balance_after"] = round(balance, 2)

    collected = sum(e["amount"] for e in events if e["direction"] == "+")
    paid_in = sum(e["amount"] for e in events if e["direction"] == "-")
    return {
        "from_business_date": from_bd,
        "to_business_date": today_bd,
        "days": days,
        "collected": round(collected, 2),
        "paid_in": round(paid_in, 2),
        "cash_in_hand": round(balance, 2),
        "cash_limit": get_setting("cash_limit", CASH_LIMIT),
        "cash_over_limit": balance > get_setting("cash_limit", CASH_LIMIT),
        "entries": list(reversed(events)),          # newest first for display
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
    driver_share = round(est_gross * get_setting("driver_share", DRIVER_SHARE), 2)

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
        "share_rate": get_setting("driver_share", DRIVER_SHARE),
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
        days.append({"business_date": key, "gross": gross, "share": round(gross * get_setting("driver_share", DRIVER_SHARE), 2)})
    return {"days": days}


# ---------------------------------------------------------------------------
# RAZORPAY STANDARD CHECKOUT — driver pays cash-in-hand dues via UPI/card.
# ---------------------------------------------------------------------------
# The client never sees the secret. Server creates the order, hosts a small
# Checkout HTML page opened via expo-web-browser, and verifies the returned
# signature against the stored order id. Webhook is the source of truth —
# the /verify endpoint only accelerates the UX; even if the webhook lags,
# reconciliation runs exactly once (unique client_action_id ⇒ ledger row).

import hashlib
import hmac
import html as html_lib
import json as _json

RAZORPAY_KEY_ID = os.environ.get("RAZORPAY_KEY_ID", "")
RAZORPAY_KEY_SECRET = os.environ.get("RAZORPAY_KEY_SECRET", "")
RAZORPAY_WEBHOOK_SECRET = os.environ.get("RAZORPAY_WEBHOOK_SECRET", "")
RAZORPAY_BASE = "https://api.razorpay.com/v1"


class RazorpayOrderIn(BaseModel):
    client_action_id: str
    amount_rupees: Optional[float] = None      # optional override; caps at dues
    note: Optional[str] = None


class RazorpayVerifyIn(BaseModel):
    client_action_id: str
    razorpay_order_id: str
    razorpay_payment_id: str
    razorpay_signature: str


def _razorpay_configured() -> bool:
    return bool(RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET)


def _zero_balance(today_bd: str) -> Dict:
    return {
        "as_of_business_date": today_bd,
        "collected_to_yesterday": 0.0,
        "paid_in_total": 0.0,
        "paid_in_today": 0.0,
        "balance": 0.0,
        "you_owe": 0.0,
        "in_credit": 0.0,
        "over_limit": False,
        "cash_limit": get_setting("cash_limit", CASH_LIMIT),
    }


async def _driver_balances(driver_ids: Optional[List[str]] = None) -> Dict[str, Dict]:
    """Running cash balance per driver: what the reports say was collected,
    minus what Razorpay says was paid in.

    Two deliberate asymmetries, both because the sides arrive on different
    clocks:

    * Earnings come only from SETTLED rows — the platform report — and only
      up to and including yesterday. Today's report does not exist yet, and
      an OCR'd screenshot is the driver's own claim, so neither may move
      what a driver owes.
    * Deposits count from every date, today included, because a Razorpay
      payment is confirmed the moment its webhook lands.

    Running totals, not per-day: unpaid cash carries forward and a payment
    today settles a debt from any earlier day.

    Two aggregations for the whole fleet regardless of driver count. The
    per-driver version delegates here so there is only ever one
    implementation of this rule — a second copy is how the admin panel and
    the driver's own screen previously came to disagree.
    """
    today_bd = business_date_now()

    cash_match: Dict[str, Any] = {
        "status": "settled",
        "business_date": {"$lt": today_bd},
    }
    pay_match: Dict[str, Any] = {
        "type": "deposit",
        "source": {"$in": sorted(TRUSTED_CASH_SOURCES)},
    }
    if driver_ids is not None:
        if not driver_ids:
            return {}
        cash_match["driver_id"] = {"$in": driver_ids}
        pay_match["driver_id"] = {"$in": driver_ids}

    owed: Dict[str, float] = {}
    async for r in db.platform_cash.aggregate([
        {"$match": cash_match},
        {"$group": {"_id": "$driver_id", "total": {"$sum": "$cash_amount"}}},
    ]):
        owed[r["_id"]] = float(r.get("total") or 0)

    paid: Dict[str, Dict[str, float]] = {}
    async for r in db.qr_payments.aggregate([
        {"$match": pay_match},
        {"$group": {
            "_id": "$driver_id",
            "total": {"$sum": "$amount"},
            "today": {"$sum": {"$cond": [
                {"$eq": ["$business_date", today_bd]}, "$amount", 0,
            ]}},
        }},
    ]):
        paid[r["_id"]] = {
            "total": float(r.get("total") or 0),
            "today": float(r.get("today") or 0),
        }

    out: Dict[str, Dict] = {}
    for did in set(owed) | set(paid):
        o = owed.get(did, 0.0)
        p = paid.get(did, {"total": 0.0, "today": 0.0})
        balance = round(o - p["total"], 2)
        out[did] = {
            "as_of_business_date": today_bd,
            "collected_to_yesterday": round(o, 2),
            "paid_in_total": round(p["total"], 2),
            "paid_in_today": round(p["today"], 2),
            "balance": balance,
            "you_owe": round(max(0.0, balance), 2),
            "in_credit": round(max(0.0, -balance), 2),
            "over_limit": balance > get_setting("cash_limit", CASH_LIMIT),
            "cash_limit": get_setting("cash_limit", CASH_LIMIT),
        }
    # Drivers with no rows on either side still need a balance.
    if driver_ids:
        for did in driver_ids:
            out.setdefault(did, _zero_balance(today_bd))
    return out


async def _driver_balance(driver_id: str) -> Dict:
    """Single-driver balance. Thin wrapper so the rule lives in one place."""
    balances = await _driver_balances([driver_id])
    return balances.get(driver_id) or _zero_balance(business_date_now())


async def _driver_dues_paise(driver_id: str) -> int:
    """Server-authoritative dues (paise). Never trust a client-supplied
    amount. Based on the running balance, so a driver can clear arrears from
    any previous day, not just today."""
    bal = await _driver_balance(driver_id)
    return int(round(float(bal["you_owe"]) * 100))


async def _rzp_request(method: str, path: str, **kw) -> Dict[str, Any]:
    if not _razorpay_configured():
        raise HTTPException(500, "razorpay_not_configured")
    import httpx
    async with httpx.AsyncClient(timeout=15.0) as c:
        r = await c.request(
            method,
            RAZORPAY_BASE + path,
            auth=(RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET),
            **kw,
        )
    if r.status_code >= 400:
        logger.error("razorpay %s %s -> %s %s", method, path, r.status_code, r.text[:200])
        raise HTTPException(502, "razorpay_request_failed")
    return r.json()


async def _reconcile_razorpay_once(
    driver_id: str,
    client_action_id: str,
    razorpay_order_id: str,
    razorpay_payment_id: str,
    amount_paise: int,
) -> None:
    """Idempotently mark the order reconciled and append the deposit row
    to qr_payments (same collection the app uses for QR-based deposits so
    downstream money/today calculations pick it up)."""
    # Only the first transition writes the ledger row.
    r = await db.razorpay_orders.find_one_and_update(
        {"razorpay_order_id": razorpay_order_id, "status": {"$ne": "reconciled"}},
        {"$set": {
            "status": "reconciled",
            "razorpay_payment_id": razorpay_payment_id,
            "reconciled_at": iso(now_utc()),
        }},
        return_document=False,
    )
    if not r:
        return  # already reconciled — safe no-op
    # Mirror as a "deposit" row in qr_payments so the cash-in-hand ledger
    # decreases and the Money tab shows the payment.
    today_bd = business_date_now()
    await db.qr_payments.update_one(
        {"driver_id": driver_id, "client_action_id": client_action_id},
        {"$setOnInsert": {
            "id": str(uuid.uuid4()),
            "driver_id": driver_id,
            "type": "deposit",
            "amount": round(amount_paise / 100, 2),
            "ts": iso(now_utc()),
            "business_date": today_bd,
            "source": "razorpay",
            "razorpay_order_id": razorpay_order_id,
            "razorpay_payment_id": razorpay_payment_id,
            "client_action_id": client_action_id,
        }},
        upsert=True,
    )


@api.get("/payments/razorpay/config")
async def razorpay_config(driver: Dict = Depends(get_driver)):
    """Small helper so the client knows if Razorpay is enabled and what
    the driver's current dues are before opening Checkout."""
    dues_paise = await _driver_dues_paise(driver["id"])
    return {
        "enabled": _razorpay_configured(),
        "key_id": RAZORPAY_KEY_ID if _razorpay_configured() else None,
        "dues_paise": dues_paise,
        "dues_rupees": round(dues_paise / 100, 2),
    }


@api.post("/payments/razorpay/orders")
async def create_razorpay_order(
    body: RazorpayOrderIn, driver: Dict = Depends(get_driver)
):
    if not _razorpay_configured():
        raise HTTPException(503, "razorpay_not_configured")
    # Idempotent replay.
    existing = await db.razorpay_orders.find_one(
        {"driver_id": driver["id"], "client_action_id": body.client_action_id},
        {"_id": 0},
    )
    if existing:
        return {
            "order_id": existing["razorpay_order_id"],
            "amount_paise": existing["amount_paise"],
            "currency": "INR",
            "key_id": RAZORPAY_KEY_ID,
            "status": existing["status"],
        }
    dues_paise = await _driver_dues_paise(driver["id"])
    # Support partial payment. If client asked for a specific amount, cap
    # it at dues; if dues == 0 we still allow a driver to prepay a small
    # amount (min ₹1 = 100 paise per Razorpay).
    amount_paise = dues_paise
    if body.amount_rupees is not None:
        req = int(round(float(body.amount_rupees) * 100))
        if req < 100:
            raise HTTPException(400, "amount_below_minimum")
        amount_paise = min(req, dues_paise) if dues_paise > 0 else req
    if amount_paise < 100:
        raise HTTPException(400, "no_dues")
    order = await _rzp_request(
        "POST", "/orders",
        json={
            "amount": amount_paise,
            "currency": "INR",
            "receipt": body.client_action_id[:40],
            "notes": {
                "driver_id": driver["id"],
                "driver_name": driver.get("name") or "",
                "client_action_id": body.client_action_id,
            },
            "payment_capture": 1,
        },
    )
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver["id"],
        "client_action_id": body.client_action_id,
        "razorpay_order_id": order["id"],
        "amount_paise": amount_paise,
        "note": body.note,
        "status": "created",
        "created_at": iso(now_utc()),
    }
    await db.razorpay_orders.insert_one(row)
    return {
        "order_id": order["id"],
        "amount_paise": amount_paise,
        "currency": "INR",
        "key_id": RAZORPAY_KEY_ID,
        "status": "created",
    }


@api.post("/payments/razorpay/verify")
async def verify_razorpay_payment(body: RazorpayVerifyIn):
    """Called by the hosted Checkout page — runs unauthenticated because
    the browser tab can't carry a Bearer token. The HMAC signature (which
    only Razorpay + our server can produce) is the actual auth here."""
    rec = await db.razorpay_orders.find_one(
        {
            "client_action_id": body.client_action_id,
            "razorpay_order_id": body.razorpay_order_id,
        },
        {"_id": 0},
    )
    if not rec:
        raise HTTPException(404, "order_not_found")
    msg = f"{rec['razorpay_order_id']}|{body.razorpay_payment_id}".encode()
    expected = hmac.new(
        RAZORPAY_KEY_SECRET.encode(), msg, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, body.razorpay_signature):
        raise HTTPException(400, "invalid_signature")
    await _reconcile_razorpay_once(
        driver_id=rec["driver_id"],
        client_action_id=body.client_action_id,
        razorpay_order_id=body.razorpay_order_id,
        razorpay_payment_id=body.razorpay_payment_id,
        amount_paise=rec["amount_paise"],
    )
    return {"status": "reconciled", "amount_paise": rec["amount_paise"]}


@api.get("/payments/razorpay/status/{client_action_id}")
async def razorpay_order_status(
    client_action_id: str, driver: Dict = Depends(get_driver)
):
    rec = await db.razorpay_orders.find_one(
        {"driver_id": driver["id"], "client_action_id": client_action_id},
        {"_id": 0},
    )
    if not rec:
        raise HTTPException(404, "order_not_found")
    return {
        "status": rec["status"],
        "order_id": rec["razorpay_order_id"],
        "payment_id": rec.get("razorpay_payment_id"),
        "amount_paise": rec["amount_paise"],
        "reconciled_at": rec.get("reconciled_at"),
    }


# ---------------------------------------------------------------------------
# DYNAMIC UPI QR (cash deposit)
#
# Not the static QRs this fleet used before. Those were created in the
# dashboard as fixed_amount=false / usage=multiple_use / notes={}, which is
# why a payment on them could not be tied to a driver or a purpose: anyone
# could pay any amount and rider fares landed in the same stream as deposits.
#
# A dynamic QR inverts all three. The server mints it per request with
# fixed_amount=true, usage=single_use, the amount taken from
# _driver_dues_paise, and driver_id in notes — so it is payable exactly once,
# for exactly the dues, by exactly one attributable driver. It expires via
# close_by. The driver can then pay from any UPI app instead of the hosted
# checkout, which is the point: no card rails, no WebBrowser flow.
# ---------------------------------------------------------------------------
QR_TTL_MINUTES = 30      # Razorpay requires close_by >= now + 2 minutes


async def _reconcile_qr_once(
    driver_id: str,
    qr_code_id: str,
    razorpay_payment_id: str,
    amount_paise: int,
) -> None:
    """QR twin of _reconcile_razorpay_once. Keyed on qr_code_id because a QR
    payment carries no order_id, so the order-based path cannot serve it."""
    r = await db.razorpay_qrs.find_one_and_update(
        {"qr_code_id": qr_code_id, "status": {"$ne": "reconciled"}},
        {"$set": {
            "status": "reconciled",
            "razorpay_payment_id": razorpay_payment_id,
            "amount_received_paise": int(amount_paise),
            "reconciled_at": iso(now_utc()),
        }},
        return_document=False,
    )
    if not r:
        return  # unknown or already reconciled — safe no-op
    await db.qr_payments.update_one(
        {"driver_id": driver_id, "client_action_id": r["client_action_id"]},
        {"$setOnInsert": {
            "id": str(uuid.uuid4()),
            "driver_id": driver_id,
            "type": "deposit",
            "amount": round(amount_paise / 100, 2),
            "reference": qr_code_id,
            "platform": None,
            "occurred_at": iso(now_utc()),
            "business_date": business_date_now(),
            "source": "razorpay",
            "razorpay_qr_code_id": qr_code_id,
            "razorpay_payment_id": razorpay_payment_id,
            "client_action_id": r["client_action_id"],
            "created_at": iso(now_utc()),
        }},
        upsert=True,
    )


@api.post("/payments/razorpay/qr")
async def create_razorpay_qr(
    body: QrDepositIn, driver: Dict = Depends(get_driver)
):
    if not _razorpay_configured():
        raise HTTPException(503, "razorpay_not_configured")
    existing = await db.razorpay_qrs.find_one(
        {"driver_id": driver["id"], "client_action_id": body.client_action_id},
        {"_id": 0},
    )
    if existing:
        return {
            "qr_code_id": existing["qr_code_id"],
            "image_url": existing["image_url"],
            "amount_paise": existing["amount_paise"],
            "status": existing["status"],
            "close_by": existing["close_by"],
        }

    dues_paise = await _driver_dues_paise(driver["id"])
    amount_paise = dues_paise
    if body.amount_rupees is not None:
        req = int(round(float(body.amount_rupees) * 100))
        if req < 100:
            raise HTTPException(400, "amount_below_minimum")
        amount_paise = min(req, dues_paise) if dues_paise > 0 else req
    if amount_paise < 100:
        raise HTTPException(400, "no_dues")

    close_by = int((now_utc() + timedelta(minutes=QR_TTL_MINUTES)).timestamp())
    qr = await _rzp_request(
        "POST", "/payments/qr_codes",
        json={
            "type": "upi_qr",
            "name": "Ride91 cash deposit",
            "usage": "single_use",
            "fixed_amount": True,
            "payment_amount": amount_paise,
            "description": f"Cash deposit - {driver.get('name') or driver['id']}",
            "close_by": close_by,
            "notes": {
                "driver_id": driver["id"],
                "client_action_id": body.client_action_id,
                "purpose": "cash_deposit",
            },
        },
    )
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver["id"],
        "client_action_id": body.client_action_id,
        "qr_code_id": qr["id"],
        "image_url": qr.get("image_url"),
        "amount_paise": amount_paise,
        "close_by": close_by,
        "status": "active",
        "created_at": iso(now_utc()),
    }
    await db.razorpay_qrs.insert_one(row.copy())
    row.pop("_id", None)
    return {
        "qr_code_id": row["qr_code_id"],
        "image_url": row["image_url"],
        "amount_paise": amount_paise,
        "status": "active",
        "close_by": close_by,
        "expires_in_seconds": QR_TTL_MINUTES * 60,
    }


@api.get("/payments/razorpay/qr/{client_action_id}")
async def razorpay_qr_status(
    client_action_id: str, driver: Dict = Depends(get_driver)
):
    rec = await db.razorpay_qrs.find_one(
        {"driver_id": driver["id"], "client_action_id": client_action_id},
        {"_id": 0},
    )
    if not rec:
        raise HTTPException(404, "qr_not_found")
    return {
        "status": rec["status"],
        "qr_code_id": rec["qr_code_id"],
        "image_url": rec.get("image_url"),
        "amount_paise": rec["amount_paise"],
        "amount_received_paise": rec.get("amount_received_paise"),
        "payment_id": rec.get("razorpay_payment_id"),
        "close_by": rec["close_by"],
        "expired": rec["status"] == "active"
                   and int(now_utc().timestamp()) > rec["close_by"],
        "reconciled_at": rec.get("reconciled_at"),
    }


@api.get("/payments/razorpay/checkout", response_class=Response)
async def razorpay_checkout_page(
    order_id: str,
    amount: int,
    action: str,
    redirect: str,
    name: str = "Ride91 driver",
):
    """Hosted Checkout page — opened by the app inside expo-web-browser.
    All params are already validated by the /orders call. The client
    action id lives in Razorpay `notes` and drives our reconciliation.
    This page is intentionally self-contained and does NOT require an
    auth header (the Bearer token can't be forwarded through a WebView).
    """
    if not _razorpay_configured():
        raise HTTPException(503, "razorpay_not_configured")
    safe_order = html_lib.escape(order_id)
    safe_action = html_lib.escape(action)
    safe_redirect = html_lib.escape(redirect)
    safe_name = html_lib.escape(name)
    verify_url = "/api/payments/razorpay/verify"
    page = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ride91 · Pay dues</title><style>body{{font-family:-apple-system,system-ui,sans-serif;background:#EEF1EC;color:#10231C;margin:0;padding:40px 24px;text-align:center}} .card{{max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;box-shadow:0 4px 20px rgba(16,35,28,.08)}} h1{{margin:0 0 8px}} .amt{{font-size:36px;font-weight:700;color:#0B7A4B;margin:16px 0}} button{{background:#0B7A4B;color:#fff;border:none;border-radius:8px;padding:14px 28px;font-size:16px;font-weight:600;cursor:pointer;width:100%}} .muted{{color:#67756D;font-size:13px;margin-top:16px}}</style></head><body><div class="card"><h1>Ride91 · Pay dues</h1><div class="amt">₹{amount/100:.2f}</div><button id="pay">Open Razorpay</button><div class="muted">Test card: 4111 1111 1111 1111 · any CVV · any future date</div></div><script src="https://checkout.razorpay.com/v1/checkout.js"></script><script>const CFG={_json.dumps({"key":RAZORPAY_KEY_ID,"order_id":safe_order,"amount":amount,"action":safe_action,"redirect":safe_redirect,"name":safe_name,"verify":verify_url})};function pay(){{const rzp=new Razorpay({{key:CFG.key,order_id:CFG.order_id,amount:CFG.amount,currency:"INR",name:CFG.name,description:"Driver dues",theme:{{color:"#0B7A4B"}},handler:async function(r){{await fetch(CFG.verify,{{method:"POST",headers:{{"Content-Type":"application/json"}},body:JSON.stringify({{client_action_id:CFG.action,razorpay_payment_id:r.razorpay_payment_id,razorpay_order_id:r.razorpay_order_id,razorpay_signature:r.razorpay_signature}})}}).catch(()=>{{}});location.href=CFG.redirect+"#status=paid&order_id="+encodeURIComponent(r.razorpay_order_id);}},modal:{{ondismiss:function(){{location.href=CFG.redirect+"#status=dismissed";}}}}}});rzp.open();}}document.getElementById("pay").onclick=pay;setTimeout(pay,300);</script></body></html>"""
    return Response(content=page, media_type="text/html")


@api.post("/webhooks/razorpay")
async def razorpay_webhook(req: Request):
    """Razorpay → us. Source of truth for payment state. Verify HMAC on
    the RAW body before parsing JSON. Dedup by event id."""
    raw = await req.body()
    got = req.headers.get("X-Razorpay-Signature", "")
    if not RAZORPAY_WEBHOOK_SECRET:
        raise HTTPException(503, "webhook_not_configured")
    want = hmac.new(RAZORPAY_WEBHOOK_SECRET.encode(), raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(got, want):
        raise HTTPException(400, "bad_signature")
    event = _json.loads(raw)
    event_id = event.get("id") or hashlib.sha256(raw).hexdigest()
    try:
        await db.webhook_events.insert_one(
            {"event_id": event_id, "received_at": iso(now_utc()), "kind": event.get("event")}
        )
    except Exception:
        return {"ok": True, "dedup": True}
    kind = event.get("event") or ""
    if kind in ("payment.captured", "order.paid"):
        # Pull amount + order + client_action_id from the payload.
        payload = event.get("payload") or {}
        payment = (payload.get("payment") or {}).get("entity") or {}
        order = (payload.get("order") or {}).get("entity") or {}
        notes = payment.get("notes") or order.get("notes") or {}
        order_id = payment.get("order_id") or order.get("id")
        payment_id = payment.get("id")
        client_action_id = notes.get("client_action_id")
        driver_id = notes.get("driver_id")
        amount_paise = payment.get("amount") or order.get("amount") or 0
        if order_id and payment_id and client_action_id and driver_id:
            await _reconcile_razorpay_once(
                driver_id=driver_id,
                client_action_id=client_action_id,
                razorpay_order_id=order_id,
                razorpay_payment_id=payment_id,
                amount_paise=int(amount_paise),
            )
    elif kind == "qr_code.credited":
        # A dynamic QR was paid. No order_id exists on this path, so it is
        # reconciled against qr_code_id instead.
        payload = event.get("payload") or {}
        qr_entity = (payload.get("qr_code") or {}).get("entity") or {}
        payment = (payload.get("payment") or {}).get("entity") or {}
        notes = qr_entity.get("notes") or payment.get("notes") or {}
        qr_code_id = qr_entity.get("id")
        payment_id = payment.get("id")
        driver_id = notes.get("driver_id")
        amount_paise = payment.get("amount") or 0
        if qr_code_id and payment_id and driver_id:
            await _reconcile_qr_once(
                driver_id=driver_id,
                qr_code_id=qr_code_id,
                razorpay_payment_id=payment_id,
                amount_paise=int(amount_paise),
            )
    elif kind == "qr_code.closed":
        qr_entity = ((event.get("payload") or {}).get("qr_code") or {}).get("entity") or {}
        qr_code_id = qr_entity.get("id")
        if qr_code_id:
            # Only an unpaid QR goes to 'closed'; a reconciled one stays put.
            await db.razorpay_qrs.update_one(
                {"qr_code_id": qr_code_id, "status": "active"},
                {"$set": {"status": "closed",
                          "close_reason": qr_entity.get("close_reason"),
                          "closed_at": iso(now_utc())}},
            )
    elif kind == "payment.failed":
        payload = event.get("payload") or {}
        payment = (payload.get("payment") or {}).get("entity") or {}
        order_id = payment.get("order_id")
        if order_id:
            await db.razorpay_orders.update_one(
                {"razorpay_order_id": order_id, "status": {"$ne": "reconciled"}},
                {"$set": {"status": "failed", "failed_at": iso(now_utc())}},
            )
    return {"ok": True}


# ---------------------------------------------------------------------------
# RAZORPAYX PAYOUTS (Part B) — fleet → driver bank/UPI payouts.
# ---------------------------------------------------------------------------
# Two-sided design:
#   Driver side  : saves bank account or VPA, views their payouts history.
#   Admin/Ops    : creates a Contact + Fund Account per driver on demand,
#                  then triggers a payout (IMPS/UPI). Status updates arrive
#                  via /webhooks/razorpayx and update the local payout row.
#
# RazorpayX API base is the same as regular Razorpay (v1). Auth = Basic Auth
# with RAZORPAYX_KEY_ID / RAZORPAYX_KEY_SECRET. Idempotency header required
# for every payout create so retries don't double-pay.

RAZORPAYX_KEY_ID = os.environ.get("RAZORPAYX_KEY_ID", "")
RAZORPAYX_KEY_SECRET = os.environ.get("RAZORPAYX_KEY_SECRET", "")
RAZORPAYX_ACCOUNT_NUMBER = os.environ.get("RAZORPAYX_ACCOUNT_NUMBER", "")
RAZORPAYX_WEBHOOK_SECRET = os.environ.get("RAZORPAYX_WEBHOOK_SECRET", "")
RAZORPAYX_BASE = "https://api.razorpay.com/v1"


def _razorpayx_configured() -> bool:
    return bool(
        RAZORPAYX_KEY_ID and RAZORPAYX_KEY_SECRET and RAZORPAYX_ACCOUNT_NUMBER
    )


async def _rzpx_request(method: str, path: str, **kw) -> Dict[str, Any]:
    if not _razorpayx_configured():
        raise HTTPException(503, "razorpayx_not_configured")
    import httpx
    async with httpx.AsyncClient(timeout=20.0) as c:
        r = await c.request(
            method,
            RAZORPAYX_BASE + path,
            auth=(RAZORPAYX_KEY_ID, RAZORPAYX_KEY_SECRET),
            **kw,
        )
    if r.status_code >= 400:
        logger.error(
            "razorpayx %s %s -> %s %s", method, path, r.status_code, r.text[:300]
        )
        # Bubble up gateway-friendly context so admin UI can show it.
        try:
            body = r.json()
            msg = ((body.get("error") or {}).get("description")) or r.text[:200]
        except Exception:
            msg = r.text[:200]
        raise HTTPException(502, f"razorpayx: {msg}")
    return r.json()


# ---------- Driver-facing: bank account & payout history --------------------

class BankAccountIn(BaseModel):
    kind: Literal["bank_account", "vpa"]
    # bank_account
    account_holder: Optional[str] = None
    account_number: Optional[str] = None
    ifsc: Optional[str] = None
    # vpa
    vpa: Optional[str] = None


def _validate_bank_input(b: BankAccountIn) -> None:
    if b.kind == "bank_account":
        if not (b.account_holder and b.account_number and b.ifsc):
            raise HTTPException(400, "missing_bank_fields")
        if len(b.account_number) < 6 or len(b.account_number) > 26:
            raise HTTPException(400, "invalid_account_number")
        import re
        if not re.fullmatch(r"[A-Z]{4}0[A-Z0-9]{6}", b.ifsc.upper()):
            raise HTTPException(400, "invalid_ifsc")
    else:
        if not b.vpa or "@" not in b.vpa:
            raise HTTPException(400, "invalid_vpa")


def _mask_account(s: str) -> str:
    if not s:
        return ""
    if "@" in s:  # vpa
        u, d = s.split("@", 1)
        return (u[:2] + "***@" + d) if len(u) > 3 else "***@" + d
    if len(s) <= 4:
        return "****"
    return "*" * (len(s) - 4) + s[-4:]


@api.get("/payouts/bank-account")
async def get_bank_account(driver: Dict = Depends(get_driver)):
    row = await db.driver_bank_accounts.find_one(
        {"driver_id": driver["id"]}, {"_id": 0}
    )
    if not row:
        return {"saved": False}
    return {
        "saved": True,
        "kind": row.get("kind"),
        "masked": row.get("masked"),
        "account_holder": row.get("account_holder"),
        "ifsc": row.get("ifsc"),
        "verified": bool(row.get("razorpayx_fund_account_id")),
        "updated_at": row.get("updated_at"),
    }


@api.post("/payouts/bank-account")
async def save_bank_account(
    body: BankAccountIn, driver: Dict = Depends(get_driver)
):
    """Store the driver's payout destination. We don't call RazorpayX
    yet — the Contact + Fund Account are created lazily when ops
    triggers the first payout. This avoids consuming RazorpayX quota for
    drivers who never receive a payout."""
    _validate_bank_input(body)
    ifsc = (body.ifsc or "").upper() if body.kind == "bank_account" else None
    doc = {
        "driver_id": driver["id"],
        "kind": body.kind,
        "account_holder": body.account_holder,
        "account_number": body.account_number,   # kept for RazorpayX call later
        "ifsc": ifsc,
        "vpa": body.vpa,
        "masked": _mask_account(
            body.account_number or body.vpa or ""
        ),
        # Invalidate any old fund account when destination changes.
        "razorpayx_contact_id": None,
        "razorpayx_fund_account_id": None,
        "updated_at": iso(now_utc()),
    }
    await db.driver_bank_accounts.update_one(
        {"driver_id": driver["id"]},
        {"$set": doc, "$setOnInsert": {"created_at": iso(now_utc())}},
        upsert=True,
    )
    return {
        "saved": True,
        "kind": doc["kind"],
        "masked": doc["masked"],
        "verified": False,
    }


@api.get("/payouts/history")
async def payouts_history(driver: Dict = Depends(get_driver)):
    cursor = db.payouts.find(
        {"driver_id": driver["id"]}, {"_id": 0}
    ).sort("created_at", -1).limit(50)
    items = [p async for p in cursor]
    # Strip fields that mustn't leave the server.
    for p in items:
        p.pop("razorpayx_fund_account_id", None)
        p.pop("razorpayx_contact_id", None)
    return {"items": items}


# ---------- Admin-facing: create Contact/FundAccount + trigger payout --------

async def _ensure_rzpx_contact_and_fund_account(driver_id: str) -> Dict[str, Any]:
    """Idempotently create/reuse a Contact and Fund Account for the driver
    using their saved bank details. Returns fund_account_id."""
    drv = await db.drivers.find_one({"id": driver_id}, {"_id": 0})
    if not drv:
        raise HTTPException(404, "driver_not_found")
    ba = await db.driver_bank_accounts.find_one(
        {"driver_id": driver_id}, {"_id": 0}
    )
    if not ba:
        raise HTTPException(400, "bank_account_not_saved")
    # Reuse existing.
    if ba.get("razorpayx_fund_account_id"):
        return {"fund_account_id": ba["razorpayx_fund_account_id"]}

    # ---- Contact
    contact_id = ba.get("razorpayx_contact_id")
    if not contact_id:
        contact_payload = {
            "name": (drv.get("name") or "Ride91 driver")[:50],
            "email": drv.get("email") or (drv.get("google_email") or ""),
            "contact": (drv.get("phone") or "").lstrip("+"),
            "type": "employee",
            "reference_id": f"driver-{driver_id}",
            "notes": {"driver_id": driver_id},
        }
        # RazorpayX rejects empty email/contact — trim keys.
        contact_payload = {k: v for k, v in contact_payload.items() if v}
        c = await _rzpx_request("POST", "/contacts", json=contact_payload)
        contact_id = c["id"]

    # ---- Fund Account
    if ba["kind"] == "bank_account":
        fa_payload = {
            "contact_id": contact_id,
            "account_type": "bank_account",
            "bank_account": {
                "name": ba["account_holder"],
                "ifsc": ba["ifsc"],
                "account_number": ba["account_number"],
            },
        }
    else:
        fa_payload = {
            "contact_id": contact_id,
            "account_type": "vpa",
            "vpa": {"address": ba["vpa"]},
        }
    fa = await _rzpx_request("POST", "/fund_accounts", json=fa_payload)
    await db.driver_bank_accounts.update_one(
        {"driver_id": driver_id},
        {"$set": {
            "razorpayx_contact_id": contact_id,
            "razorpayx_fund_account_id": fa["id"],
            "verified_at": iso(now_utc()),
        }},
    )
    return {"fund_account_id": fa["id"]}


class AdminPayoutIn(BaseModel):
    driver_id: str
    amount_rupees: float = Field(gt=0)
    mode: Literal["IMPS", "UPI"] = "IMPS"
    narration: Optional[str] = "Ride91 driver payout"
    reference_id: Optional[str] = None
    client_action_id: Optional[str] = None  # ops-side idempotency


@api.post("/admin/payouts/create")
async def admin_create_payout(
    body: AdminPayoutIn, admin: Dict = Depends(require_write)
):
    """Ops-triggered payout. Enforces:
      - min ₹1 (100 paise) per Razorpay rules.
      - IMPS requires bank_account destination; UPI requires vpa.
      - Idempotent per (admin, client_action_id) to survive retries.
    """
    amount_paise = int(round(body.amount_rupees * 100))
    if amount_paise < 100:
        raise HTTPException(400, "amount_below_minimum")

    action = body.client_action_id or str(uuid.uuid4())
    existing = await db.payouts.find_one(
        {"client_action_id": action}, {"_id": 0}
    )
    if existing:
        return {"payout_id": existing["id"], "status": existing["status"], "dedup": True}

    # Ensure destination compatibility.
    ba = await db.driver_bank_accounts.find_one(
        {"driver_id": body.driver_id}, {"_id": 0}
    )
    if not ba:
        raise HTTPException(400, "bank_account_not_saved")
    if body.mode == "IMPS" and ba["kind"] != "bank_account":
        raise HTTPException(400, "imps_requires_bank_account")
    if body.mode == "UPI" and ba["kind"] != "vpa":
        raise HTTPException(400, "upi_requires_vpa")

    fa = await _ensure_rzpx_contact_and_fund_account(body.driver_id)
    ref_id = body.reference_id or f"ride91-{action[:20]}"
    idem = str(uuid.uuid4())
    payload = {
        "account_number": RAZORPAYX_ACCOUNT_NUMBER,
        "fund_account_id": fa["fund_account_id"],
        "amount": amount_paise,
        "currency": "INR",
        "mode": body.mode,
        "purpose": "payout",
        "queue_if_low_balance": True,
        "reference_id": ref_id,
        "narration": (body.narration or "Ride91 driver payout")[:30],
        "notes": {
            "driver_id": body.driver_id,
            "client_action_id": action,
        },
    }
    resp = await _rzpx_request(
        "POST", "/payouts",
        json=payload,
        headers={"X-Payout-Idempotency": idem},
    )
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": body.driver_id,
        "razorpayx_payout_id": resp["id"],
        "razorpayx_fund_account_id": fa["fund_account_id"],
        "amount_paise": amount_paise,
        "amount_rupees": round(amount_paise / 100, 2),
        "mode": body.mode,
        "reference_id": ref_id,
        "narration": payload["narration"],
        "status": resp.get("status") or "processing",
        "utr": resp.get("utr"),
        "status_details": resp.get("status_details"),
        "client_action_id": action,
        "created_by": admin["username"],
        "created_at": iso(now_utc()),
        "updated_at": iso(now_utc()),
    }
    await db.payouts.insert_one(row.copy())
    await _audit(admin, "create_payout", row.get("driver_id", ""),
                 {"amount_rupees": row.get("amount_rupees"), "mode": row.get("mode")})
    return {"payout_id": row["id"], "status": row["status"], "razorpayx_id": resp["id"]}


@api.get("/admin/payouts")
async def admin_list_payouts(
    driver_id: Optional[str] = None,
    limit: int = 100,
    admin: Dict = Depends(get_admin),
):
    q: Dict[str, Any] = {}
    if driver_id:
        q["driver_id"] = driver_id
    cursor = db.payouts.find(q, {"_id": 0}).sort("created_at", -1).limit(min(limit, 500))
    items = [p async for p in cursor]
    return {"items": items}


@api.get("/admin/payouts/{payout_id}/refresh")
async def admin_refresh_payout(
    payout_id: str, admin: Dict = Depends(get_admin)
):
    """Reconciliation fallback: pull latest state from RazorpayX by id."""
    rec = await db.payouts.find_one({"id": payout_id}, {"_id": 0})
    if not rec:
        raise HTTPException(404, "payout_not_found")
    data = await _rzpx_request("GET", f"/payouts/{rec['razorpayx_payout_id']}")
    await db.payouts.update_one(
        {"id": payout_id},
        {"$set": {
            "status": data.get("status") or rec["status"],
            "utr": data.get("utr"),
            "status_details": data.get("status_details"),
            "updated_at": iso(now_utc()),
        }},
    )
    return {"status": data.get("status"), "utr": data.get("utr")}


# ---------- Webhook -----------------------------------------------------------

@api.post("/webhooks/razorpayx")
async def razorpayx_webhook(req: Request):
    """RazorpayX → us. Same signature scheme as regular Razorpay webhooks
    (HMAC-SHA256 of raw body). Deduped by X-Razorpay-Event-Id."""
    raw = await req.body()
    got = req.headers.get("X-Razorpay-Signature", "")
    event_hdr = req.headers.get("X-Razorpay-Event-Id", "")
    if not RAZORPAYX_WEBHOOK_SECRET:
        raise HTTPException(503, "webhook_not_configured")
    want = hmac.new(
        RAZORPAYX_WEBHOOK_SECRET.encode(), raw, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(got, want):
        raise HTTPException(400, "bad_signature")
    event = _json.loads(raw)
    event_id = event_hdr or event.get("id") or hashlib.sha256(raw).hexdigest()
    try:
        await db.webhook_events.insert_one({
            "event_id": event_id,
            "kind": event.get("event"),
            "received_at": iso(now_utc()),
            "source": "razorpayx",
        })
    except Exception:
        return {"ok": True, "dedup": True}
    name = event.get("event") or ""
    if name.startswith("payout."):
        payload = event.get("payload") or {}
        entity = (payload.get("payout") or {}).get("entity") or {}
        rzpx_id = entity.get("id")
        if rzpx_id:
            await db.payouts.update_one(
                {"razorpayx_payout_id": rzpx_id},
                {"$set": {
                    "status": entity.get("status") or "updated",
                    "utr": entity.get("utr"),
                    "status_details": entity.get("status_details"),
                    "updated_at": iso(now_utc()),
                    "last_event": name,
                }},
            )
    return {"ok": True}


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
# NOTIFICATIONS — two-way messages between a driver and ops.
#   direction="from_driver"  driver -> ops (shows in the admin driver card)
#   direction="to_driver"    ops -> driver (shows on the driver app's bell)
# `read` tracks whether the *recipient* has seen it.
# ---------------------------------------------------------------------------
@api.post("/notifications")
async def driver_send_notification(body: DriverNotifyIn, driver: Dict = Depends(get_driver)):
    existing = await db.notifications.find_one(
        {"driver_id": driver["id"], "client_action_id": body.client_action_id}, {"_id": 0}
    )
    if existing:
        return existing
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver["id"],
        "direction": "from_driver",
        "body": body.body.strip(),
        "created_at": iso(now_utc()),
        "created_by": driver.get("name"),
        "read": False,
        "read_at": None,
        "client_action_id": body.client_action_id,
    }
    await db.notifications.insert_one(row.copy())
    row.pop("_id", None)
    return row


@api.get("/notifications")
async def driver_list_notifications(driver: Dict = Depends(get_driver)):
    rows = [r async for r in db.notifications.find(
        {"driver_id": driver["id"]}, {"_id": 0}
    ).sort("created_at", -1).limit(100)]
    # Unread = messages ops sent this driver that they haven't opened yet.
    unread = sum(1 for r in rows if r.get("direction") == "to_driver" and not r.get("read"))
    return {"items": rows, "unread": unread}


@api.post("/notifications/{notification_id}/read")
async def driver_mark_notification_read(notification_id: str, driver: Dict = Depends(get_driver)):
    await db.notifications.update_one(
        {"id": notification_id, "driver_id": driver["id"], "direction": "to_driver"},
        {"$set": {"read": True, "read_at": iso(now_utc())}},
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# TRACKING (phone side)
# ---------------------------------------------------------------------------
@api.post("/tracking/ping")
async def phone_ping(
    body: Dict[str, Any], driver: Dict = Depends(get_driver)
):
    # The phone's own ~4-min ping. Recorded to phone_pings as the raw feed, and
    # ALSO bridged into vehicle_pings so the driver shows on the admin live map
    # and drives `last_ping_at` until real tracker hardware exists. Bridged rows
    # carry source="phone" so a future hardware feed can be preferred/filtered.
    now = iso(now_utc())
    recorded_at = body.get("recorded_at") or now
    lat, lng = body.get("lat"), body.get("lng")
    vehicle_id = driver.get("vehicle_id")
    # Optional context tag, e.g. "charge:to_charger" — lets ops see WHERE and
    # WHEN a charging action was taken, not just a bare location point.
    event = body.get("event")
    await db.phone_pings.insert_one({
        "id": str(uuid.uuid4()),
        "driver_id": driver["id"],
        "vehicle_id": vehicle_id,
        "recorded_at": recorded_at,
        "received_at": now,
        "lat": lat,
        "lng": lng,
        "event": event,
        "source": "phone",
    })
    if vehicle_id and lat is not None and lng is not None:
        vp: Dict[str, Any] = {
            "id": str(uuid.uuid4()),
            "vehicle_id": vehicle_id,
            "driver_id": driver["id"],
            "recorded_at": recorded_at,
            "received_at": now,
            "lat": lat,
            "lng": lng,
            "source": "phone",
        }
        # Only store accuracy/speed when the phone actually reported them —
        # never as None, which the distance filter can't compare against.
        if body.get("accuracy_m") is not None:
            vp["accuracy_m"] = body.get("accuracy_m")
        if body.get("speed_kmph") is not None:
            vp["speed_kmph"] = body.get("speed_kmph")
        await db.vehicle_pings.insert_one(vp)
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
        # `or 0` — a stored value may be present but None (e.g. a phone-bridged
        # ping with no accuracy/speed); None > 30 would raise.
        if (p.get("accuracy_m") or 0) > 30:
            stats["points_rejected_accuracy"] += 1
            continue
        if (p.get("speed_kmph") or 0) > 120:
            stats["points_rejected_speed"] += 1
            continue
        if p.get("lat") is None or p.get("lng") is None:
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
            "password_hash": hash_password(DEMO_DRIVER_PASSWORD),
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
            # Rider paid into Ride91's Razorpay rather than handing over cash,
            # so it is a trusted source and still counts. Without this the
            # trust filter would drop the row and the demo's cash-in-hand
            # would jump by 120.
            "source": "razorpay",
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
    # The ops driver list windows both duty_states aggregations on
    # started_at, and filters one of them by state first.
    await db.duty_states.create_index([("started_at", 1)])
    await db.duty_states.create_index([("state", 1), ("started_at", 1)])
    await db.close_outs.create_index([("driver_id", 1), ("client_action_id", 1)], unique=True)
    await db.requests.create_index([("driver_id", 1), ("client_action_id", 1)], unique=True)
    await db.vehicle_pings.create_index([("vehicle_id", 1), ("recorded_at", 1)])
    # Latest-ping-per-vehicle windows on recorded_at across all vehicles, so
    # it needs the timestamp leading. At ~200 vehicles pinging every 4
    # minutes this collection is the fastest-growing one in the system.
    await db.vehicle_pings.create_index([("recorded_at", 1)])
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
    # Trust filter in _fetch_qr_payments queries by source; the ops hand-in
    # path looks a row up by reference before inserting.
    await db.qr_payments.create_index(
        [("driver_id", 1), ("business_date", 1), ("source", 1)]
    )
    await db.qr_payments.create_index(
        [("driver_id", 1), ("reference", 1), ("source", 1)]
    )
    # Dynamic deposit QRs: looked up by client_action_id (driver polling) and
    # by qr_code_id (webhook reconcile).
    await db.razorpay_qrs.create_index(
        [("driver_id", 1), ("client_action_id", 1)], unique=True
    )
    await db.razorpay_qrs.create_index([("qr_code_id", 1)], unique=True)
    # Bookings: listed newest-first, filtered by status, tallied by day.
    await db.bookings.create_index([("created_at", -1)])
    await db.bookings.create_index([("status", 1), ("created_at", -1)])
    await db.bookings.create_index([("business_date", 1)])
    await db.bookings.create_index([("id", 1)], unique=True)
    # Onboarding: phone is the driver login identity, vehicle number the plate.
    await db.drivers.create_index([("phone", 1)], unique=True)
    await db.vehicles.create_index([("number", 1)], unique=True)
    await db.shift_schedules.create_index(
        [("driver_id", 1), ("client_action_id", 1)], unique=True
    )
    await db.shift_schedules.create_index(
        [("driver_id", 1), ("shift_start", 1)]
    )
    await db.alarm_responses.create_index(
        [("driver_id", 1), ("client_action_id", 1)], unique=True
    )
    # Razorpay dedup — order per driver+action; unique order id from Razorpay.
    await db.razorpay_orders.create_index(
        [("driver_id", 1), ("client_action_id", 1)], unique=True
    )
    await db.razorpay_orders.create_index([("razorpay_order_id", 1)], unique=True)
    await db.webhook_events.create_index([("event_id", 1)], unique=True)
    # RazorpayX payouts (Part B).
    await db.driver_bank_accounts.create_index([("driver_id", 1)], unique=True)
    await db.payouts.create_index([("client_action_id", 1)], unique=True)
    await db.payouts.create_index([("razorpayx_payout_id", 1)], unique=True)
    await db.payouts.create_index([("driver_id", 1), ("created_at", -1)])
    # Uber report import: resolve driver by Uber's id, and keep one settled
    # cash row per driver/platform/business-day so the upsert stays a no-op
    # when the same report is uploaded twice.
    await db.drivers.create_index(
        [("uber_driver_uuid", 1)], unique=True, sparse=True
    )
    await db.platform_cash.create_index(
        [("driver_id", 1), ("platform", 1), ("business_date", 1)]
    )
    await db.admin_users.create_index([("username", 1)], unique=True)
    await db.admin_sessions.create_index([("username", 1)])
    await db.login_attempts.create_index([("key", 1)], unique=True)
    await db.admin_audit.create_index([("at", -1)])
    await db.admin_audit.create_index([("action", 1), ("at", -1)])
    await db.notifications.create_index([("driver_id", 1), ("created_at", -1)])
    await db.notifications.create_index([("direction", 1), ("read", 1), ("created_at", -1)])
    await _seed_admin_owner()
    await load_settings()
    await _seed_if_empty()
    await _ensure_demo_login()


async def _ensure_demo_login() -> None:
    """Guarantee a working demo driver login. The demo driver was seeded before
    passwords existed, so its row can lack a password_hash; backfill it (and
    create the driver if the DB was seeded but the row is missing) so
    DEMO_DRIVER_PHONE / DEMO_DRIVER_PASSWORD always signs in for testing."""
    d = await db.drivers.find_one(
        {"phone": DEMO_DRIVER_PHONE}, {"_id": 0, "id": 1, "password_hash": 1}
    )
    if d and not d.get("password_hash"):
        await db.drivers.update_one(
            {"id": d["id"]},
            {"$set": {"password_hash": hash_password(DEMO_DRIVER_PASSWORD)}},
        )
        logger.info("backfilled demo driver password for %s", DEMO_DRIVER_PHONE)


async def _seed_admin_owner() -> None:
    """Ensure an owner account exists. On first boot this promotes the
    env-configured ADMIN_USERNAME/ADMIN_PASSWORD into a real, hashed user row so
    the existing login keeps working while the panel gains per-user accounts."""
    if await db.admin_users.count_documents({}) > 0:
        return
    await db.admin_users.insert_one({
        "id": str(uuid.uuid4()),
        "username": ADMIN_USERNAME,
        "password_hash": hash_password(ADMIN_PASSWORD),
        "role": "owner",
        "active": True,
        "created_at": iso(now_utc()),
        "created_by": "system_bootstrap",
    })
    logger.info("seeded bootstrap admin owner '%s'", ADMIN_USERNAME)


@app.on_event("shutdown")
async def _on_shutdown() -> None:
    client.close()
