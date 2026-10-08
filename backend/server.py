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
import calendar
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

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
from pydantic import BaseModel, Field, field_validator
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

# --- Reward defaults. All overridable from the settings doc; the reward
# endpoints read the live values via get_setting(). Weekly rewards are ON TOP
# of the 30% share, measured on gross (the fleet statement number). ---
REWARD_DAILY_TARGET = 4000            # min daily gross to qualify (top car of day)
REWARD_TOP_CAR_DAY = 300
REWARD_WEEK_CAR_TARGET = 28000        # min weekly gross (top car of week)
REWARD_TOP_CAR_WEEK = 1000
REWARD_WEEK_DRIVER_TARGET = 17500     # min weekly DRIVER earnings (top driver of week)
REWARD_TOP_DRIVER_WEEK = 1000
REWARD_DAYS_REQUIRED = 7
# Loyalty (earnings) milestones — a bonus when the driver's cumulative gross
# (from the loyalty start date) crosses each threshold. Forfeit-if-you-leave
# vesting; manual payout. `amount` is the gross threshold in ₹.
LOYALTY_MILESTONES = [
    {"key": "e1", "label": "₹1 lakh earned",  "amount": 100000,  "reward": 2000},
    {"key": "e3", "label": "₹3 lakh earned",  "amount": 300000,  "reward": 4000},
    {"key": "e6", "label": "₹6 lakh earned",  "amount": 600000,  "reward": 8000},
    {"key": "e12", "label": "₹12 lakh earned", "amount": 1200000, "reward": 15000},
]
# Yearly performance, decided per hub over the calendar year to date.
YEARLY_TOP_DRIVER = 50000             # top driver of the year, per hub (on gross)
YEARLY_TOP_CAR = 40000                # top car of the year, per hub (combined gross)

# ---------------------------------------------------------------------------
# Runtime settings — a single `settings` doc (id="global") overlays these
# defaults. Cached in memory and refreshed on startup and after every save, so
# the money math reads a live value without a DB hit per request.
# ---------------------------------------------------------------------------
SETTINGS_DEFAULTS: Dict[str, Any] = {
    "cash_limit": CASH_LIMIT,
    "driver_share": DRIVER_SHARE,
    "hubs": [],                       # list of {name, lat, lng}
    # Weekly reward thresholds + bonuses.
    "reward_daily_target": REWARD_DAILY_TARGET,
    "reward_top_car_day": REWARD_TOP_CAR_DAY,
    "reward_week_car_target": REWARD_WEEK_CAR_TARGET,
    "reward_top_car_week": REWARD_TOP_CAR_WEEK,
    "reward_week_driver_target": REWARD_WEEK_DRIVER_TARGET,
    "reward_top_driver_week": REWARD_TOP_DRIVER_WEEK,
    "reward_days_required": REWARD_DAYS_REQUIRED,
    # Loyalty (list of {key,label,days,reward}) + yearly bonuses.
    "loyalty_milestones": LOYALTY_MILESTONES,
    "yearly_top_driver": YEARLY_TOP_DRIVER,
    "yearly_top_car": YEARLY_TOP_CAR,
    # Loyalty Wallet — a forfeitable balance that accrues per qualifying day a
    # driver works, paid out by ops, forfeited if they leave. All knobs live.
    "loyalty_wallet_enabled": True,
    "loyalty_wallet_per_day": 25,          # ₹ accrued per qualifying day
    "loyalty_wallet_min_gross": 1500,      # a day counts only if gross >= this (0 = any on-duty day)
    "loyalty_wallet_start_date": "2026-10-01",   # accrue from this business date onward
    "loyalty_wallet_payout_every_days": 90,      # suggested payout cadence (for the "due" nudge)
    # Attendance & monthly-target bonus. A "good day" = logged in on time (vs the
    # driver's own scheduled shift start + grace) AND hit the daily gross target.
    # The monthly bonus pays when good days (and optional monthly gross) clear the
    # floor. All live.
    "attendance_enabled": True,
    "attendance_daily_target": 2500,       # ₹ gross for a day to count
    "attendance_require_ontime": True,     # require punctual login (vs their scheduled shift start)
    "attendance_grace_minutes": 30,        # minutes past scheduled start still "on time"
    "attendance_monthly_min_days": 27,     # good days needed in the month
    "attendance_monthly_min_gross": 0,     # optional monthly gross floor (0 = ignore)
    "attendance_monthly_bonus": 3000,      # ₹ paid when the month qualifies
    # Salary cash-out. With direct withdrawal on, the money goes straight to the
    # driver's saved bank / UPI; otherwise (or above the daily limit) the hub pays.
    "withdraw_min_amount": 100,            # smallest salary withdrawal a driver may request (₹)
    "withdraw_hold_cash_owed": True,       # hold back salary equal to the collection cash the driver still owes
    "withdraw_direct": True,               # send withdrawals straight to the bank, no hub approval
    "withdraw_direct_daily_max": 10000,    # most a driver can take directly in one day (₹, 0 = no limit)
    # Razorpay credentials (owner-editable; override the env vars). Secret
    # values are never returned by the API — only their "set" status is.
    "razorpay_key_id": "",
    "razorpay_key_secret": "",
    "razorpay_webhook_secret": "",
    # RazorpayX (payouts to drivers). Same rules: owner-editable, override the
    # env vars, secrets never returned. A blank key ID / secret falls back to
    # the Razorpay pair above, since one Razorpay account uses one set of keys.
    "razorpayx_key_id": "",
    "razorpayx_key_secret": "",
    "razorpayx_account_number": "",        # the RazorpayX account the payouts are debited from
    "razorpayx_webhook_secret": "",
    # Google Maps key for the ADMIN PANEL's maps (Maps JavaScript API, locked
    # to the panel's web address). Not a secret in the usual sense: any browser
    # key is visible to whoever loads the page, which is why it must be
    # referrer-restricted. Blank = the panel uses OpenStreetMap.
    "google_maps_web_key": "",
}
_SETTINGS_CACHE: Dict[str, Any] = dict(SETTINGS_DEFAULTS)


def get_setting(key: str, default: Any = None) -> Any:
    return _SETTINGS_CACHE.get(key, SETTINGS_DEFAULTS.get(key, default))


def _weekly_reward_cfg():
    """The live weekly-reward thresholds/bonuses, in the fixed order the reward
    endpoints unpack them. Reads the settings doc (falls back to defaults)."""
    return (
        get_setting("reward_daily_target"),
        get_setting("reward_top_car_day"),
        get_setting("reward_week_car_target"),
        get_setting("reward_top_car_week"),
        get_setting("reward_week_driver_target"),
        get_setting("reward_top_driver_week"),
        get_setting("reward_days_required"),
    )


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
# "qr_collection" = a rider paid a cash Uber trip to the fleet via the driver's
# QR, so it settles that driver's cash-in-hand just like a deposit/hand-in.
TRUSTED_CASH_SOURCES = {"razorpay", "admin_manual", "qr_collection"}
# How far back the ops driver list looks for a driver's latest duty state.
# Bounds the sort: a driver with no row in this window is not on duty now.
STATE_LOOKBACK_DAYS = 7
DEMO_DRIVER_PHONE = "+919900000001"
DEMO_DRIVER_PASSWORD = "ride91"  # seed driver's admin-set password (demo only)
# The demo driver's login is written in this (public) file, so it must never be
# created or repaired on a real deployment. Demo seeding runs only when
# SEED_DEMO=1 is set, i.e. on a developer's own machine.
SEED_DEMO = os.environ.get("SEED_DEMO", "").strip().lower() in ("1", "true", "yes")

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


def _bd_or_400(date: Optional[str]) -> str:
    """A caller-supplied ?date= as a business-date key, defaulting to today.
    A malformed value is the caller's error (400), not a server crash."""
    if not date:
        return business_date_now()
    try:
        return datetime.strptime(date, "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "invalid_date")


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
    # None while the driver has no car allotted (new driver, or between
    # allotments) — they must still be able to sign in.
    vehicle_id: Optional[str] = None
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
    # Where the driver was. None when the phone had no fix — never 0,0.
    lat: Optional[float] = None
    lng: Optional[float] = None
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
    hub_id: Optional[str] = None               # the hub this car sits under


class VehicleUpdateIn(BaseModel):
    # All optional — only the provided fields change.
    number: Optional[str] = Field(default=None, min_length=3)
    model: Optional[str] = None
    current_soc: Optional[int] = None
    current_range_km: Optional[int] = None
    hub_id: Optional[str] = None


class HubCreateIn(BaseModel):
    name: str = Field(min_length=2)            # e.g. "Wakad Pune Hub"
    city: Optional[str] = None
    capacity: int = Field(default=12, ge=1, le=100)
    lat: Optional[float] = None
    lng: Optional[float] = None


class HubUpdateIn(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2)
    city: Optional[str] = None
    capacity: Optional[int] = Field(default=None, ge=1, le=100)
    lat: Optional[float] = None
    lng: Optional[float] = None


class DriverCreateIn(BaseModel):
    name: str = Field(min_length=1)
    phone: str = Field(min_length=5)           # login identity (username); unique
    password: str = Field(min_length=6)        # admin-set driver app password
    vehicle_id: Optional[str] = None
    hub_id: Optional[str] = None               # the hub the driver belongs to
    hub_name: Optional[str] = None             # kept for display; derived from hub
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
    hub_id: Optional[str] = None
    hub_name: Optional[str] = None
    hub_lat: Optional[float] = None
    hub_lng: Optional[float] = None
    shift_type: Optional[str] = None
    shift_start_time: Optional[str] = None   # HH:MM — the driver's daily shift start (wake-up alarm + attendance on-time)
    shift_end_time: Optional[str] = None     # HH:MM — optional
    status: Optional[Literal["approved", "pending"]] = None
    active: Optional[bool] = None

    @field_validator("shift_start_time", "shift_end_time")
    @classmethod
    def _hhmm(cls, v: Optional[str]) -> Optional[str]:
        # "" clears the time; anything else must be a real 24h HH:MM (a
        # trailing :SS from a browser time input is dropped). These feed the
        # wake-up alarm and attendance maths, so garbage is refused up front.
        if v is None:
            return v
        v = v.strip()
        if not v:
            return ""
        if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?", v):
            raise ValueError("must be HH:MM (24-hour)")
        return v[:5]


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


# Base64 size caps so a single inspection document stays well under MongoDB's
# 16 MB limit (and bounds the request body). ~2.5 MB photo + ~10 MB video of
# base64 ≈ 12.5 MB stored, leaving headroom. 480p/15s easily fits.
MAX_PHOTO_B64 = 2_500_000
MAX_VIDEO_B64 = 10_000_000


class InspectionIn(BaseModel):
    dashboard_photo_b64: str = Field(max_length=MAX_PHOTO_B64)   # data URL / base64 JPEG
    exterior_video_b64: str = Field(max_length=MAX_VIDEO_B64)    # data URL / base64 mp4/webm
    exterior_video_mime: str = "video/mp4"
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
        vehicle_id=driver.get("vehicle_id"),
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
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")  # no default — must be set to seed a bootstrap owner
# Shared secret for the hardware GPS tracker feed (/vehicles/pings/ingest).
TRACKER_INGEST_SECRET = os.environ.get("TRACKER_INGEST_SECRET", "")
ADMIN_SESSION_HOURS = 12
# Driver sessions get a long sliding TTL: a driver active within this many days
# stays signed in, but a truly dormant (e.g. stolen) token dies.
DRIVER_SESSION_DAYS = 30

# Login brute-force guard (DB-backed so it holds across Cloud Run instances).
LOGIN_MAX_ATTEMPTS = 6      # failures allowed within the window
LOGIN_WINDOW_MIN = 15       # rolling window for counting failures
LOGIN_LOCK_MIN = 15         # lockout duration once the limit is hit

# Role hierarchy.
#   viewer       — read only
#   hub_manager  — manages ONE hub (its drivers, cars, assignments, rewards)
#   manager      — fleet-wide ops
#   owner        — additionally manages admin accounts and settings
ROLE_RANK = {"viewer": 0, "hub_manager": 1, "manager": 2, "owner": 3}
ROLES = set(ROLE_RANK)


def hub_scope(admin: Dict) -> Optional[str]:
    """The hub a hub_manager is limited to; None means unrestricted (manager /
    owner see the whole fleet)."""
    return admin.get("hub_id") if admin.get("role") == "hub_manager" else None


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
    password: str = Field(min_length=10)   # admin accounts move money: no short passwords
    role: Literal["viewer", "hub_manager", "manager", "owner"] = "manager"
    hub_id: Optional[str] = None   # required when role == hub_manager


class AdminUserUpdateIn(BaseModel):
    role: Optional[Literal["viewer", "hub_manager", "manager", "owner"]] = None
    active: Optional[bool] = None
    password: Optional[str] = Field(default=None, min_length=10)
    hub_id: Optional[str] = None


class ChangePasswordIn(BaseModel):
    old_password: str
    new_password: str = Field(min_length=10)


class SettingsIn(BaseModel):
    cash_limit: Optional[int] = Field(default=None, ge=0)
    driver_share: Optional[float] = Field(default=None, ge=0, le=1)
    hubs: Optional[List[Dict[str, Any]]] = None
    # Weekly reward thresholds + bonuses (all ₹, days as an int count).
    reward_daily_target: Optional[int] = Field(default=None, ge=0)
    reward_top_car_day: Optional[int] = Field(default=None, ge=0)
    reward_week_car_target: Optional[int] = Field(default=None, ge=0)
    reward_top_car_week: Optional[int] = Field(default=None, ge=0)
    reward_week_driver_target: Optional[int] = Field(default=None, ge=0)
    reward_top_driver_week: Optional[int] = Field(default=None, ge=0)
    reward_days_required: Optional[int] = Field(default=None, ge=1, le=7)
    # Loyalty milestones [{key,label,days,reward}] + yearly bonuses.
    loyalty_milestones: Optional[List[Dict[str, Any]]] = None
    yearly_top_driver: Optional[int] = Field(default=None, ge=0)
    yearly_top_car: Optional[int] = Field(default=None, ge=0)
    # Loyalty wallet config.
    loyalty_wallet_enabled: Optional[bool] = None
    loyalty_wallet_per_day: Optional[int] = Field(default=None, ge=0)
    loyalty_wallet_min_gross: Optional[int] = Field(default=None, ge=0)
    loyalty_wallet_start_date: Optional[str] = None
    loyalty_wallet_payout_every_days: Optional[int] = Field(default=None, ge=1)
    # Attendance & monthly-target config.
    attendance_enabled: Optional[bool] = None
    attendance_daily_target: Optional[int] = Field(default=None, ge=0)
    attendance_require_ontime: Optional[bool] = None
    attendance_grace_minutes: Optional[int] = Field(default=None, ge=0)
    attendance_monthly_min_days: Optional[int] = Field(default=None, ge=0)
    attendance_monthly_min_gross: Optional[int] = Field(default=None, ge=0)
    attendance_monthly_bonus: Optional[int] = Field(default=None, ge=0)
    # Salary withdrawal.
    withdraw_min_amount: Optional[int] = Field(default=None, ge=0)
    withdraw_direct: Optional[bool] = None
    withdraw_direct_daily_max: Optional[int] = Field(default=None, ge=0)
    # Razorpay credentials (owner only; override env vars, never read back).
    razorpay_key_id: Optional[str] = None
    razorpay_key_secret: Optional[str] = None
    razorpay_webhook_secret: Optional[str] = None
    razorpayx_key_id: Optional[str] = None
    razorpayx_key_secret: Optional[str] = None
    razorpayx_account_number: Optional[str] = None
    razorpayx_webhook_secret: Optional[str] = None
    # Send "" to remove the key and go back to OpenStreetMap.
    google_maps_web_key: Optional[str] = None


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
        "hub_id": user.get("hub_id"),
        "user_id": user.get("id"),
        "token": token,
    }


async def require_write(admin: Dict = Depends(get_admin)) -> Dict:
    """Fleet-wide mutations: manager or owner (NOT hub_manager or viewer)."""
    if ROLE_RANK.get(admin.get("role", "viewer"), 0) < ROLE_RANK["manager"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "read_only_role")
    return admin


async def require_ops(admin: Dict = Depends(get_admin)) -> Dict:
    """Hub-scoped ops: hub_manager, manager or owner. A hub_manager is limited
    to their own hub (enforced per endpoint via hub_scope)."""
    if ROLE_RANK.get(admin.get("role", "viewer"), 0) < ROLE_RANK["hub_manager"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "read_only_role")
    return admin


async def require_owner(admin: Dict = Depends(get_admin)) -> Dict:
    """Owner only. Use for admin-account and settings management."""
    if admin.get("role") != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "owner_only")
    return admin


async def fleet_admin(admin: Dict = Depends(get_admin)) -> Dict:
    """Read endpoints that expose fleet-wide data (dashboard, cash, bookings,
    payouts, reviews, audit, settings…). A scoped hub_manager is confined to
    their hub's drivers/cars/rewards, so they're refused here."""
    if admin.get("role") == "hub_manager":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "out_of_hub_scope")
    return admin


# ---------------------------------------------------------------------------
# AUTH
# ---------------------------------------------------------------------------
def _norm_phone(raw: str) -> str:
    """Canonical form of a driver phone: spaces/dashes/brackets dropped, and an
    Indian mobile written as 10 digits, 0+10 or 91+10 becomes +91XXXXXXXXXX.
    Anything else (already +CC…, or not a recognisable mobile) is kept as typed
    so non-Indian numbers still work."""
    typed = (raw or "").strip()
    digits = re.sub(r"\D", "", typed)
    if typed.startswith("+"):
        return "+" + digits
    if len(digits) == 10:
        return "+91" + digits
    if len(digits) == 11 and digits.startswith("0"):
        return "+91" + digits[1:]
    if len(digits) == 12 and digits.startswith("91"):
        return "+" + digits
    return typed


@api.post("/auth/login")
async def driver_login(body: DriverLoginIn):
    """Driver login with phone (username) + admin-set password. The generic
    error message avoids revealing whether a phone is registered.

    Drivers type their number the way they say it — usually 10 digits, with no
    +91 — while ops stores it as +91XXXXXXXXXX, so the typed number is
    normalised before the lookup (the exact text typed is still tried, for any
    legacy row stored differently). The lockout counter is keyed on the
    normalised number so reformatting it doesn't earn extra attempts."""
    typed = body.phone.strip()
    phone = _norm_phone(typed)
    await login_guard(f"driver:{phone}")
    driver = await db.drivers.find_one({"phone": phone}, {"_id": 0})
    if not driver and typed != phone:
        driver = await db.drivers.find_one({"phone": typed}, {"_id": 0})
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
    vehicle = await db.vehicles.find_one({"id": driver.get("vehicle_id")}, {"_id": 0})
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
        "vehicle_id": driver.get("vehicle_id"),
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


# The driver-facing go-online capture (20s walkaround + selfie) was retired:
# the only pre-duty car check is now the Start-duty inspection. The admin
# "Capture reviews" endpoints below remain for viewing any historical captures.


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
        "vehicle_id": driver.get("vehicle_id"),
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
    now = now_utc()
    for i, (ts, row) in enumerate(parsed):
        newest = i + 1 == len(parsed)
        seg_start = ts
        seg_end = parsed[i + 1][0] if not newest else max(now, ts)
        # clip to day window
        s = max(seg_start, day_start)
        e = min(seg_end, day_end)
        # Two kinds of row are kept even at zero length. The newest row is
        # what the driver is doing right now — it may be a second old, or
        # stamped by a phone whose clock runs ahead of ours; dropping it made
        # the app show the state before it, as if the last tap had not
        # happened. And a start / end-duty row decides whether the driver is on
        # duty at all, however quickly the next tap followed it.
        keep_empty = (newest or row["state"] in ("start_duty", "end_duty")) and day_start <= ts < day_end
        if e < s or (e == s and not keep_empty):
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
                # When the row itself was written; earlier than from_ts for a
                # state carried in from the day before.
                "started_at": iso(seg_start),
            }
        )
    return segments


# A duty that runs past the 04:00 day change carries into the new day, so a
# night driver is not switched off mid-shift. But only for this long after it
# started: a driver who simply forgot to end duty is treated as off after that,
# and starts the next day fresh (with that day's inspection).
DUTY_CARRY_HOURS = 16


async def _duty_carried_in(driver_id: str, day_start: datetime) -> Optional[datetime]:
    """If the driver was on duty when this business day began, when that duty
    started; otherwise None."""
    last = await db.duty_states.find_one(
        {"driver_id": driver_id, "state": {"$in": ["start_duty", "end_duty"]},
         "started_at": {"$lt": iso(day_start)}},
        {"_id": 0, "state": 1, "started_at": 1},
        sort=[("started_at", -1)],
    )
    if not last or last["state"] != "start_duty":
        return None
    try:
        return _parse_iso(last["started_at"])
    except Exception:
        return None


def _apply_duty_carry(
    segs: List[Dict], day_start: datetime, carried_from: Optional[datetime], now: datetime
) -> Tuple[List[Dict], bool]:
    """Trim the part of the day that comes before its first start/end-duty row.
    That stretch belongs to yesterday's duty: it counts only while that duty is
    still within DUTY_CARRY_HOURS of its start, and not at all if the driver
    was off duty when the day began. Returns (segments, still_carried_now)."""
    cutoff = carried_from + timedelta(hours=DUTY_CARRY_HOURS) if carried_from else day_start
    out: List[Dict] = []
    in_day_marker = False
    for seg in segs:
        if not in_day_marker:
            if seg["state"] in ("start_duty", "end_duty") and _parse_iso(seg["started_at"]) >= day_start:
                in_day_marker = True
            else:
                s_, e_ = _parse_iso(seg["from_ts"]), min(_parse_iso(seg["to_ts"]), cutoff)
                # (a zero-length newest row inside the carry window is kept)
                if e_ < s_ or (e_ == s_ and seg["seconds"] > 0):
                    continue
                seg = {**seg, "to_ts": iso(e_), "seconds": int((e_ - s_).total_seconds())}
        out.append(seg)
    return out, (not in_day_marker and carried_from is not None and now < cutoff)


async def _duty_summary(
    driver_id: str, vehicle_id: Optional[str], business_date: str
) -> Dict[str, Any]:
    """Full duty rollup for one driver on one business day. Shared core behind
    the driver's /duty/today and the admin duty views, so they never drift."""
    day_start, day_end = business_day_bounds(business_date)
    segs = await _segments_for_day(driver_id, day_start, day_end)
    segs, carried_now = _apply_duty_carry(
        segs, day_start, await _duty_carried_in(driver_id, day_start), min(now_utc(), day_end))
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
    # On-duty time = everything from start_duty on: the wait before the first
    # platform is picked, working, not_online and charging.
    on_duty_seconds = (
        working_seconds
        + totals.get("start_duty", 0)
        + totals.get("not_online", 0)
        + totals.get("to_charger", 0)
        + totals.get("charging", 0)
    )
    charging_seconds = totals.get("to_charger", 0) + totals.get("charging", 0)
    # Current state = most recent row across the day.
    current = segs[-1]["state"] if segs else None
    # Is the driver ON DUTY? The latest start/end-duty row of the day decides.
    # With none yet today, a duty carried in from yesterday still counts.
    on_duty = carried_now
    for s in reversed(segs):
        if s["state"] in ("start_duty", "end_duty") and _parse_iso(s["started_at"]) >= day_start:
            on_duty = s["state"] == "start_duty"
            break
    # Current active-platform SET is the most recent platform-layer row after
    # the last start_duty. `current_platform` (singular) is kept for older
    # clients as the first of the set.
    current_platforms: List[str] = []
    if on_duty:
        for s in reversed(segs):
            if s["state"] == "start_duty" and _parse_iso(s["started_at"]) >= day_start:
                break
            if s["state"] in ("online", "not_online") or s["state"] in PLATFORMS:
                current_platforms = list(s.get("platforms") or [])
                break
    current_platform = current_platforms[0] if current_platforms else None
    distance_km = (
        await _distance_today(vehicle_id, day_start, day_end, driver_id) if vehicle_id else 0.0
    )
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
        "business_date": business_date,
        "day_start": iso(day_start),
        "server_ts": iso(now_utc()),
    }


@api.get("/duty/today")
async def duty_today(driver: Dict = Depends(get_driver)):
    # Business day 04:00 IST → 03:59 next day.
    return await _duty_summary(driver["id"], driver.get("vehicle_id"), business_date_now())


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


def _ops_shift_next(driver: Dict, skip: int = 0) -> Optional[Dict]:
    """Synthesize the driver's next wake-up from the ops-set shift_start_time.

    The hub sets `shift_start_time` (HH:MM, IST wall clock) on each driver via
    hub → driver. When present, that is authoritative: the app arms its wake-up
    alarm from this synthetic schedule instead of one the driver created. We
    return the next future occurrence of HH:MM IST, shaped exactly like a
    shift_schedules row so the native side needs no change. The start alarm
    fires 1h before, matching the driver-created flow.

    The id is stable per shift day (`opsshift:<driver>:<business_date>`) so
    re-arming is idempotent and a recorded response maps back to the day.
    `skip=1` returns the occurrence after the next one (used once the next one
    has been acknowledged). Returns None when no ops time is set (caller falls
    back to the legacy driver-created schedule).
    """
    raw = driver.get("shift_start_time")
    if not raw:
        return None
    try:
        hh, mm = (int(x) for x in str(raw).split(":")[:2])
    except (ValueError, TypeError):
        return None
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        return None
    now_ist = now_utc().astimezone(IST)
    cand = now_ist.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if cand <= now_ist:
        cand += timedelta(days=1)
    cand += timedelta(days=max(0, skip))
    shift_start = cand.astimezone(timezone.utc)
    bd = business_date_from_dt(shift_start)
    return {
        "id": f"opsshift:{driver['id']}:{bd}",
        "driver_id": driver["id"],
        "shift_start": iso(shift_start),
        "shift_type": driver.get("shift_type") or "day",
        "hub_id": driver.get("hub_id"),
        "alarm_fires_at": iso(shift_start - timedelta(hours=1)),
        "state": "scheduled",
        # Ops wake-up is a start-only alarm; no end-of-shift leg.
        "shift_end": None,
        "end_buffer_min": None,
        "end_state": "na",
        "source": "ops",
    }


@api.get("/shift-alarm/next")
async def next_shift_alarm(driver: Dict = Depends(get_driver)):
    """Native side calls this on app open / boot to (re)schedule the alarm.

    The hub-set shift time wins when present — that's the whole point of
    wiring the app to the ops-set wake-up. If the driver already acknowledged
    the upcoming wake-up (a 'start' response recorded against its synthetic
    id), we return the *following* day's instead: the app refreshes right after
    a response, so tomorrow's alarm is armed there and then rather than waiting
    for the app to be reopened after today's shift has started. Only when no
    ops time is set do we fall back to the legacy driver-created schedule (the
    most recently created one still holding an active phase).
    """
    syn = _ops_shift_next(driver)
    if syn:
        acked = await db.alarm_responses.find_one(
            {
                "driver_id": driver["id"],
                "schedule_id": syn["id"],
                "phase": "start",
                "response": {"$in": ["awake", "not_coming"]},
            },
            {"_id": 0},
        )
        if acked:
            syn = _ops_shift_next(driver, skip=1) or syn
        # The app has this shift now. (Newer builds follow up with
        # /shift-alarm/armed to say whether the alarm is really set.)
        await db.alarm_arming.update_one(
            {"driver_id": driver["id"], "schedule_id": syn["id"]},
            {"$set": {"fetched_at": iso(now_utc())}}, upsert=True)
        return syn
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
            {"vehicle_id": driver.get("vehicle_id")},
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
    avg_speed = await _avg_speed_from_pings(driver.get("vehicle_id"))
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
    # An answer to a test alarm is not attendance: accept it (so the phone's
    # queue clears) and keep nothing.
    if _is_test_alarm(body.schedule_id):
        return {"ok": True, "ignored": True}
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
    # Tell the hub at once when a driver is not coming.
    if body.phase == "start" and body.response == "not_coming":
        why = ALARM_REASON_TEXT.get(body.reason_code or "", body.reason_code or "")
        if body.reason_code == "other" and body.reason_note:
            why = body.reason_note.strip()[:200]
        back = f" Back by {body.back_by}." if body.back_by else ""
        await _post_system_message(
            driver["id"], f"notcoming:{row['id']}", f"Not coming for the next shift. Reason: {why}.{back}")
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
# SHIFT BOARD — what the hub sees about each driver's coming shift: is the
# wake-up alarm set on the phone, did it ring, did the driver say they are
# coming or not, and have they started duty. Nothing here is stored as a
# "status": it is worked out from the alarm answers and duty rows each time it
# is asked for, so it can never drift from what actually happened.
# ---------------------------------------------------------------------------

# Alarms rung from "Test the alarm" (and old preview builds) carry these ids.
# Their answers are not attendance and are never stored or shown.
TEST_ALARM_PREFIXES = ("test-", "preview-", "local-")
_TEST_ALARM_REGEX = "^(test-|preview-|local-)"

ALARM_NO_ANSWER_MINUTES = 15     # alarm rang this long ago with no answer -> "no answer"
SHIFT_NO_SHOW_MINUTES = 15       # shift began this long ago with no duty started -> "not started"

ALARM_REASON_TEXT = {
    "unwell": "Unwell", "family_emergency": "Family emergency",
    "vehicle_problem": "Vehicle problem", "transport_problem": "Transport problem",
    "personal": "Personal", "other": "Other",
}


def _is_test_alarm(schedule_id: Any) -> bool:
    return str(schedule_id or "").startswith(TEST_ALARM_PREFIXES)


def _shift_hhmm(driver: Dict) -> Optional[Tuple[int, int]]:
    """The hub-set shift start as (hour, minute), or None if unset / malformed."""
    raw = driver.get("shift_start_time")
    if not raw:
        return None
    try:
        hh, mm = (int(x) for x in str(raw).split(":")[:2])
    except (ValueError, TypeError):
        return None
    return (hh, mm) if 0 <= hh <= 23 and 0 <= mm <= 59 else None


def _shift_occurrence(driver: Dict, now: datetime) -> Optional[Dict[str, Any]]:
    """The shift the board is about: the occurrence of the driver's shift time
    nearest to now (so a 06:00 shift is "today's" from 18:00 the evening before
    until 18:00 that day). Its id matches the one the phone's alarm carries."""
    hm = _shift_hhmm(driver)
    if not hm:
        return None
    now_ist = now.astimezone(IST)
    base = now_ist.replace(hour=hm[0], minute=hm[1], second=0, microsecond=0)
    cand = min((base + timedelta(days=d) for d in (-1, 0, 1)),
               key=lambda c: abs((c - now_ist).total_seconds()))
    start = cand.astimezone(timezone.utc)
    return {
        "schedule_id": f"opsshift:{driver['id']}:{business_date_from_dt(start)}",
        "shift_start": start,
        "alarm_at": start - timedelta(hours=1),
    }


async def _shift_status(driver: Dict, now: datetime) -> Dict[str, Any]:
    """Where one driver stands for their nearest shift.

    status:
      no_shift_time   the hub has not set a shift time, so there is no alarm
      alarm_pending   the alarm has not rung yet
      ringing         it rang in the last few minutes; no answer yet
      no_answer       it rang a while ago and was never answered
      coming          the driver answered "I'm coming"
      not_coming      the driver answered "not coming" (with a reason)
      late            said coming, shift has begun, duty not started
      not_started     never answered, shift has begun, duty not started
      started         duty started
    """
    occ = _shift_occurrence(driver, now)
    if not occ:
        return {"status": "no_shift_time"}
    did, sid = driver["id"], occ["schedule_id"]
    start, alarm_at = occ["shift_start"], occ["alarm_at"]

    answer: Optional[Dict] = None
    snoozes = 0
    async for r in db.alarm_responses.find(
        {"driver_id": did, "schedule_id": sid, "phase": "start"}, {"_id": 0}
    ).sort("created_at", 1):
        if r.get("response") == "snooze":
            snoozes += 1
        elif r.get("response") in ("awake", "not_coming"):
            answer = r

    # Duty started for this shift: from 3h before it (an early start) onward.
    duty = await db.duty_states.find_one(
        {"driver_id": did, "state": "start_duty",
         "started_at": {"$gte": iso(start - timedelta(hours=3))[:19],
                        "$lt": iso(start + timedelta(hours=12))[:19]}},
        {"_id": 0, "started_at": 1}, sort=[("started_at", 1)])
    duty_at = None
    if duty:
        try:
            duty_at = _parse_iso(duty["started_at"])
        except Exception:
            duty_at = None

    if duty_at:
        status_ = "started"          # whatever they answered, they are at work
    elif answer and answer.get("response") == "not_coming":
        status_ = "not_coming"
    elif answer:
        status_ = "coming" if now < start + timedelta(minutes=SHIFT_NO_SHOW_MINUTES) else "late"
    elif now < alarm_at:
        status_ = "alarm_pending"
    elif now < alarm_at + timedelta(minutes=ALARM_NO_ANSWER_MINUTES):
        status_ = "ringing"
    elif now < start + timedelta(minutes=SHIFT_NO_SHOW_MINUTES):
        status_ = "no_answer"
    else:
        status_ = "not_started"

    # Is the alarm really set on the phone? The app reports it when it arms it.
    arm = await db.alarm_arming.find_one({"driver_id": did, "schedule_id": sid}, {"_id": 0})
    if not arm:
        phone = "not_picked_up"          # the app has not fetched this shift: the driver must open it
    elif arm.get("native") is None:
        phone = "unknown"                # an older app build fetched it but does not report
    elif arm.get("native") is False:
        phone = "no_alarm_in_app"        # an app build without the alarm
    elif arm.get("notifications_ok") is False:
        phone = "notifications_off"      # the alarm cannot show itself
    elif arm.get("exact_ok") is False:
        phone = "may_ring_late"          # set, but Android may hold it back a few minutes
    else:
        phone = "ready"

    return {
        "status": status_,
        "schedule_id": sid,
        "shift_start": iso(start),
        "alarm_at": iso(alarm_at),
        "answered_at": (answer or {}).get("responded_at") or (answer or {}).get("created_at"),
        "reason_code": (answer or {}).get("reason_code"),
        "reason_note": (answer or {}).get("reason_note"),
        "back_by": (answer or {}).get("back_by"),
        "snoozes": snoozes,
        "duty_started_at": iso(duty_at) if duty_at else None,
        "late_minutes": max(0, int((duty_at - start).total_seconds() // 60)) if duty_at else None,
        "phone": phone,
        "phone_checked_at": (arm or {}).get("armed_at") or (arm or {}).get("fetched_at"),
    }


class AlarmArmedIn(BaseModel):
    schedule_id: str
    native: bool                          # the app build has the alarm and set it
    notifications_ok: Optional[bool] = None
    exact_ok: Optional[bool] = None       # Android lets it ring at the exact minute


@api.post("/shift-alarm/armed")
async def shift_alarm_armed(body: AlarmArmedIn, driver: Dict = Depends(get_driver)):
    """The app tells us it has set (or could not set) the alarm for a shift, so
    the hub can see the alarm is really live on that phone."""
    if _is_test_alarm(body.schedule_id):
        return {"ok": True, "ignored": True}
    await db.alarm_arming.update_one(
        {"driver_id": driver["id"], "schedule_id": body.schedule_id},
        {"$set": {"native": body.native, "notifications_ok": body.notifications_ok,
                  "exact_ok": body.exact_ok, "armed_at": iso(now_utc())}},
        upsert=True,
    )
    return {"ok": True}


async def _post_system_message(driver_id: str, key: str, body: str) -> bool:
    """Put an automatic note about a driver into the hub's inbox, once per key.
    It lights the Messages badge like a message from the driver would, but is
    marked `kind: system` and is not shown back to the driver."""
    if await db.notifications.find_one({"driver_id": driver_id, "client_action_id": key}, {"_id": 1}):
        return False
    await db.notifications.insert_one({
        "id": str(uuid.uuid4()),
        "driver_id": driver_id,
        "direction": "from_driver",
        "kind": "system",
        "body": body,
        "created_at": iso(now_utc()),
        "created_by": "Ride91 app",
        "read": False,
        "read_at": None,
        "client_action_id": key,
    })
    return True


def _shift_clock(iso_ts: str) -> str:
    return _parse_iso(iso_ts).astimezone(IST).strftime("%H:%M")


_alarm_watch_at: Optional[datetime] = None


async def _alarm_watch() -> None:
    """Raise the alerts nobody is there to send: a driver who did not answer
    the alarm, or who has not started duty after the shift began. There is no
    clock running on the server, so this is run (at most once a minute) when
    an admin panel asks for the inbox count — which every open panel does."""
    global _alarm_watch_at
    now = now_utc()
    if _alarm_watch_at and (now - _alarm_watch_at).total_seconds() < 60:
        return
    _alarm_watch_at = now
    async for d in db.drivers.find(
        {"shift_start_time": {"$nin": [None, ""]}, "archived": {"$ne": True}, "active": {"$ne": False}},
        {"_id": 0, "id": 1, "shift_start_time": 1},
    ):
        st = await _shift_status(d, now)
        sid = st.get("schedule_id")
        if st["status"] == "no_answer":
            await _post_system_message(
                d["id"], f"noanswer:{sid}",
                f"Did not answer the wake-up alarm for the {_shift_clock(st['shift_start'])} shift.")
        elif st["status"] == "not_started":
            await _post_system_message(
                d["id"], f"notstarted:{sid}",
                f"Has not started duty. The shift was due at {_shift_clock(st['shift_start'])} and the alarm was never answered.")
        elif st["status"] == "late":
            await _post_system_message(
                d["id"], f"late:{sid}",
                f"Said they were coming but has not started duty. The shift was due at {_shift_clock(st['shift_start'])}.")


@api.get("/admin/hubs/{hub_id}/shift-board")
async def admin_shift_board(hub_id: str, admin: Dict = Depends(require_ops)):
    """The hub's live board for the coming shift: one row per driver."""
    scope = hub_scope(admin)
    if scope and scope != hub_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "out_of_hub_scope")
    ids = await _hub_driver_ids(hub_id)
    now = now_utc()
    drivers = [d async for d in db.drivers.find(
        {"id": {"$in": ids or ["_none"]}, "archived": {"$ne": True}}, {"_id": 0, "password_hash": 0})]
    rows: List[Dict[str, Any]] = []
    counts: Dict[str, int] = {}
    for d in sorted(drivers, key=lambda x: (x.get("shift_start_time") or "99", x.get("name") or "")):
        st = await _shift_status(d, now)
        counts[st["status"]] = counts.get(st["status"], 0) + 1
        rows.append({
            # `phone` in the status is the alarm's state on the handset, so the
            # driver's number goes under its own name.
            "driver_id": d["id"], "name": d.get("name"), "driver_phone": d.get("phone"),
            "shift_type": d.get("shift_type") or "day", "active": d.get("active", True),
            "shift_start_time": d.get("shift_start_time"),
            **st,
        })
    return {"items": rows, "counts": counts, "count": len(rows), "server_ts": iso(now)}


class HubShiftTimesIn(BaseModel):
    shift_start_time: str                               # "HH:MM", or "" to clear
    shift_type: Literal["day", "night", "all"] = "all"  # which drivers to set it for


@api.post("/admin/hubs/{hub_id}/shift-times")
async def admin_set_hub_shift_times(hub_id: str, body: HubShiftTimesIn, admin: Dict = Depends(require_ops)):
    """Set (or clear) the shift time for every day driver, every night driver,
    or all drivers of a hub in one go. Each driver's alarm follows."""
    scope = hub_scope(admin)
    if scope and scope != hub_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "out_of_hub_scope")
    value: Optional[str] = body.shift_start_time.strip()
    if value:
        try:
            value = datetime.strptime(value, "%H:%M").strftime("%H:%M")
        except ValueError:
            raise HTTPException(400, "invalid_time")
    else:
        value = None
    q: Dict[str, Any] = {"id": {"$in": await _hub_driver_ids(hub_id) or ["_none"]}, "archived": {"$ne": True}}
    if body.shift_type == "night":
        q["shift_type"] = "night"
    elif body.shift_type == "day":
        q["shift_type"] = {"$ne": "night"}       # a driver with no shift type counts as day
    res = await db.drivers.update_many(q, {"$set": {"shift_start_time": value}})
    await _audit(admin, "set_hub_shift_times", hub_id,
                 {"shift_start_time": value, "shift_type": body.shift_type, "drivers": res.modified_count})
    return {"ok": True, "updated": res.modified_count, "shift_start_time": value}


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
    "location_tracking": "Location tracking while signed in to the app",
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
    hub_name = None
    if user.get("hub_id"):
        h = await db.hubs.find_one({"id": user["hub_id"]}, {"_id": 0, "name": 1})
        hub_name = h.get("name") if h else None
    return {
        "token": token, "username": body.username,
        "role": user.get("role", "owner"), "hub_id": user.get("hub_id"),
        "hub_name": hub_name,
        "hours_valid": ADMIN_SESSION_HOURS,
    }


@api.post("/admin/logout")
async def admin_logout(admin: Dict = Depends(get_admin)):
    await db.admin_sessions.delete_one({"token": admin["token"]})
    return {"ok": True}


@api.get("/admin/me")
async def admin_me(admin: Dict = Depends(get_admin)):
    hub = None
    if admin.get("hub_id"):
        hub = await db.hubs.find_one({"id": admin["hub_id"]}, {"_id": 0, "id": 1, "name": 1})
    return {"username": admin["username"], "role": admin["role"],
            "hub_id": admin.get("hub_id"), "hub_name": hub.get("name") if hub else None}


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
        "hub_id": u.get("hub_id"),
        "active": u.get("active", True),
        "created_at": u.get("created_at"),
        "created_by": u.get("created_by"),
        "last_login_at": u.get("last_login_at"),
    }


async def _validate_hub_manager(role: Optional[str], hub_id: Optional[str]) -> None:
    """A hub_manager must point at an existing hub."""
    if role == "hub_manager":
        if not hub_id:
            raise HTTPException(400, "hub_required_for_hub_manager")
        if not await db.hubs.find_one({"id": hub_id}, {"_id": 0, "id": 1}):
            raise HTTPException(404, "hub_not_found")


@api.get("/admin/users")
async def admin_list_users(admin: Dict = Depends(require_owner)):
    users = [_user_out(u) async for u in db.admin_users.find({}, {"_id": 0}).sort("username", 1)]
    return {"items": users, "count": len(users)}


@api.post("/admin/users")
async def admin_create_user(body: AdminUserCreateIn, admin: Dict = Depends(require_owner)):
    username = body.username.strip()
    if await db.admin_users.find_one({"username": username}, {"_id": 0, "id": 1}):
        raise HTTPException(409, "username_taken")
    await _validate_hub_manager(body.role, body.hub_id)
    row = {
        "id": str(uuid.uuid4()),
        "username": username,
        "password_hash": hash_password(body.password),
        "role": body.role,
        "hub_id": body.hub_id if body.role == "hub_manager" else None,
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
    new_role = body.role if body.role is not None else user.get("role")
    new_hub = body.hub_id if body.hub_id is not None else user.get("hub_id")
    if body.role is not None or body.hub_id is not None:
        await _validate_hub_manager(new_role, new_hub)
        updates["hub_id"] = new_hub if new_role == "hub_manager" else None
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
# Reward keys the settings screen edits (beyond cash_limit/driver_share/hubs).
_REWARD_SETTING_KEYS = (
    "reward_daily_target", "reward_top_car_day", "reward_week_car_target",
    "reward_top_car_week", "reward_week_driver_target", "reward_top_driver_week",
    "reward_days_required", "loyalty_milestones", "yearly_top_driver", "yearly_top_car",
    "loyalty_wallet_enabled", "loyalty_wallet_per_day", "loyalty_wallet_min_gross",
    "loyalty_wallet_start_date", "loyalty_wallet_payout_every_days",
    "attendance_enabled", "attendance_daily_target", "attendance_require_ontime",
    "attendance_grace_minutes", "attendance_monthly_min_days",
    "attendance_monthly_min_gross", "attendance_monthly_bonus",
    "withdraw_min_amount", "withdraw_direct", "withdraw_direct_daily_max",
)


def _settings_out() -> Dict[str, Any]:
    out = {
        "cash_limit": get_setting("cash_limit", CASH_LIMIT),
        "driver_share": get_setting("driver_share", DRIVER_SHARE),
        "hubs": get_setting("hubs", []),
    }
    for k in _REWARD_SETTING_KEYS:
        out[k] = get_setting(k)
    return out


def _payments_status() -> Dict[str, Any]:
    """Razorpay credential STATUS for the admin — never the secret values.
    Shows the (public) Key ID, whether each secret is set, and where the live
    values come from (admin settings override the env vars)."""
    from_settings = bool(get_setting("razorpay_key_id"))
    return {
        "razorpay_enabled": _razorpay_configured(),
        "razorpay_key_id": _rzp_key_id() or None,          # Key ID is public
        "razorpay_key_secret_set": bool(_rzp_key_secret()),
        "razorpay_webhook_secret_set": bool(_rzp_webhook_secret()),
        "source": "settings" if from_settings else ("env" if RAZORPAY_KEY_ID else "none"),
        "webhook_url": "/api/webhooks/razorpay",
        **_payouts_status(),
    }


def _payouts_status() -> Dict[str, Any]:
    """RazorpayX (driver payouts) credential STATUS — never the secret values.
    The account number is shown by its last four digits only."""
    acct = _rzpx_account_number()
    own_keys = _rzpx_own_keys()
    return {
        "razorpayx_enabled": _razorpayx_configured(),
        "razorpayx_key_id": _rzpx_key_id() or None,        # Key ID is public
        "razorpayx_key_secret_set": bool(_rzpx_key_secret()),
        "razorpayx_account_masked": ("•••• " + acct[-4:]) if acct else None,
        "razorpayx_webhook_secret_set": bool(_rzpx_webhook_secret()),
        # Where the key pair comes from: its own, or shared with Razorpay above.
        "razorpayx_keys": "own" if own_keys else ("shared" if _rzpx_key_id() else "none"),
        "razorpayx_webhook_url": "/api/webhooks/razorpayx",
    }


@api.get("/admin/settings")
async def admin_get_settings(admin: Dict = Depends(fleet_admin)):
    return {
        **_settings_out(),
        "business_day_cutoff_ist": "04:00",   # cutoff is read-only
        "payments": _payments_status(),
        "razorpayx_ready": _razorpayx_configured(),   # direct withdrawal needs this
        "google_maps_web_key": _maps_web_key() or None,
    }


def _maps_web_key() -> str:
    return (get_setting("google_maps_web_key") or os.environ.get("GOOGLE_MAPS_WEB_KEY", "")).strip()


@api.get("/admin/map-config")
async def admin_map_config(admin: Dict = Depends(get_admin)):
    """What the admin panel's maps need. Open to every signed-in admin (hub
    managers see maps too), unlike the rest of Settings."""
    return {"google_maps_key": _maps_web_key() or None}


def _clean_milestones(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Validate/normalise a loyalty_milestones payload (earnings-based) from the
    admin. Each milestone is {key, label, amount (₹ gross threshold), reward}."""
    out: List[Dict[str, Any]] = []
    for i, m in enumerate(rows):
        try:
            amount = int(m["amount"]); reward = int(m["reward"])
        except (KeyError, TypeError, ValueError):
            raise HTTPException(422, "bad_milestone")
        if amount < 1 or reward < 0:
            raise HTTPException(422, "bad_milestone")
        out.append({
            "key": str(m.get("key") or f"e{i}"),
            "label": str(m.get("label") or f"₹{amount} earned"),
            "amount": amount, "reward": reward,
        })
    out.sort(key=lambda m: m["amount"])
    return out


@api.put("/admin/settings")
async def admin_put_settings(body: SettingsIn, admin: Dict = Depends(require_owner)):
    updates: Dict[str, Any] = {}
    if body.cash_limit is not None:
        updates["cash_limit"] = body.cash_limit
    if body.driver_share is not None:
        updates["driver_share"] = body.driver_share
    if body.hubs is not None:
        updates["hubs"] = body.hubs
    # Weekly + yearly reward numbers.
    for k in ("reward_daily_target", "reward_top_car_day", "reward_week_car_target",
              "reward_top_car_week", "reward_week_driver_target", "reward_top_driver_week",
              "reward_days_required", "yearly_top_driver", "yearly_top_car",
              "loyalty_wallet_per_day", "loyalty_wallet_min_gross", "loyalty_wallet_payout_every_days",
              "attendance_daily_target", "attendance_grace_minutes", "attendance_monthly_min_days",
              "attendance_monthly_min_gross", "attendance_monthly_bonus",
              "withdraw_min_amount", "withdraw_direct_daily_max"):
        v = getattr(body, k)
        if v is not None:
            updates[k] = v
    if body.withdraw_direct is not None:
        updates["withdraw_direct"] = bool(body.withdraw_direct)
    if body.loyalty_wallet_enabled is not None:
        updates["loyalty_wallet_enabled"] = bool(body.loyalty_wallet_enabled)
    if body.attendance_enabled is not None:
        updates["attendance_enabled"] = bool(body.attendance_enabled)
    if body.attendance_require_ontime is not None:
        updates["attendance_require_ontime"] = bool(body.attendance_require_ontime)
    if body.loyalty_wallet_start_date is not None:
        updates["loyalty_wallet_start_date"] = body.loyalty_wallet_start_date.strip()
    if body.loyalty_milestones is not None:
        updates["loyalty_milestones"] = _clean_milestones(body.loyalty_milestones)
    # Razorpay credentials — only overwrite when a non-empty value is supplied,
    # so blank fields don't wipe existing keys. These are SECRET: redacted from
    # the audit trail below.
    secret_keys = set()
    for k in ("razorpay_key_id", "razorpay_key_secret", "razorpay_webhook_secret",
              "razorpayx_key_id", "razorpayx_key_secret", "razorpayx_account_number",
              "razorpayx_webhook_secret"):
        v = getattr(body, k)
        if v is not None and v.strip() != "":
            updates[k] = v.strip()
            if k not in ("razorpay_key_id", "razorpayx_key_id"):
                secret_keys.add(k)
    if body.google_maps_web_key is not None:
        updates["google_maps_web_key"] = body.google_maps_web_key.strip()
    if updates:
        updates["updated_at"] = iso(now_utc())
        updates["updated_by"] = admin["username"]
        await db.settings.update_one({"id": "global"}, {"$set": updates}, upsert=True)
        await load_settings()
        meta = {k: ("***" if k in secret_keys else v)
                for k, v in updates.items() if k not in ("updated_at", "updated_by")}
        await _audit(admin, "update_settings", "", meta)
    return {"ok": True, **_settings_out(), "payments": _payments_status(),
            "razorpayx_ready": _razorpayx_configured(),
            "google_maps_web_key": _maps_web_key() or None}


@api.post("/admin/settings/razorpayx/test")
async def admin_test_razorpayx(admin: Dict = Depends(require_owner)):
    """Check the saved RazorpayX keys and account number by asking RazorpayX
    for the account's latest payout. Reads only; sends no money."""
    if not _razorpayx_configured():
        return {"ok": False, "error": "RazorpayX is not set up yet: a key ID, key secret and account number are all needed."}
    try:
        await _rzpx_request("GET", "/payouts", params={"account_number": _rzpx_account_number(), "count": 1})
    except HTTPException as e:
        return {"ok": False, "error": str(e.detail)}
    except Exception as e:
        return {"ok": False, "error": f"Could not reach RazorpayX ({type(e).__name__})."}
    return {"ok": True}


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
    include_archived: bool = False, hub_id: Optional[str] = None,
    admin: Dict = Depends(get_admin),
):
    """List all drivers with the ops-relevant snapshot: on-duty + platform,
    cash in hand, last GPS ping, vehicle plate, hub. Optimised for a single
    table view — never returns base64 media. Archived drivers are hidden
    unless `include_archived=true`. `?hub_id=` scopes to one hub."""
    query: Dict[str, Any] = {} if include_archived else {"archived": {"$ne": True}}
    # A hub_manager only sees drivers in their hub; an owner may pass ?hub_id=
    # to scope to one hub (by driver.hub_id or their car's hub).
    scope = _hub_target(admin, hub_id)
    if scope is not None:
        scoped_vids = await _scope_vehicle_ids(scope)
        query["$or"] = [{"hub_id": scope}, {"vehicle_id": {"$in": scoped_vids or []}}]
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
                "code": d.get("code"),
                "hub_id": d.get("hub_id"),
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


# ---- Hubs ------------------------------------------------------------------
# A hub is a location (e.g. "Wakad Pune Hub") that holds up to `capacity` cars.
# Each vehicle sits under one hub; weekly rewards are decided within a hub.
async def _hub_out(h: Dict) -> Dict:
    cars = await db.vehicles.count_documents(
        {"hub_id": h["id"], "retired": {"$ne": True}})
    return {
        "id": h["id"], "name": h.get("name"), "city": h.get("city"),
        "capacity": h.get("capacity", 12), "lat": h.get("lat"), "lng": h.get("lng"),
        "car_count": cars, "seats_left": max(0, h.get("capacity", 12) - cars),
        "created_at": h.get("created_at"),
    }


@api.get("/admin/hubs")
async def admin_list_hubs(admin: Dict = Depends(get_admin)):
    scope = hub_scope(admin)
    query = {"id": scope} if scope else {}
    hubs = [h async for h in db.hubs.find(query, {"_id": 0}).sort("name", 1)]
    items = [await _hub_out(h) for h in hubs]
    return {"items": items, "count": len(items)}


@api.post("/admin/hubs")
async def admin_create_hub(body: HubCreateIn, admin: Dict = Depends(require_write)):
    name = body.name.strip()
    if await db.hubs.find_one({"name": name}, {"_id": 0, "id": 1}):
        raise HTTPException(409, "hub_name_exists")
    row = {
        "id": str(uuid.uuid4()), "name": name, "city": (body.city or "").strip() or None,
        "capacity": body.capacity, "lat": body.lat, "lng": body.lng,
        "created_at": iso(now_utc()), "created_by": admin["username"],
    }
    await db.hubs.insert_one(row.copy())
    await _audit(admin, "create_hub", row["id"], {"name": name})
    return await _hub_out(row)


@api.patch("/admin/hubs/{hub_id}")
async def admin_update_hub(hub_id: str, body: HubUpdateIn, admin: Dict = Depends(require_write)):
    hub = await db.hubs.find_one({"id": hub_id}, {"_id": 0})
    if not hub:
        raise HTTPException(404, "hub_not_found")
    updates: Dict[str, Any] = {}
    if body.name is not None:
        nm = body.name.strip()
        clash = await db.hubs.find_one({"name": nm, "id": {"$ne": hub_id}}, {"_id": 0, "id": 1})
        if clash:
            raise HTTPException(409, "hub_name_exists")
        updates["name"] = nm
    for f in ("city", "capacity", "lat", "lng"):
        v = getattr(body, f)
        if v is not None:
            updates[f] = v.strip() if isinstance(v, str) else v
    if updates:
        await db.hubs.update_one({"id": hub_id}, {"$set": updates})
        await _audit(admin, "update_hub", hub_id, {k: v for k, v in updates.items() if k != "lat" and k != "lng"})
    return await _hub_out({**hub, **updates})


@api.delete("/admin/hubs/{hub_id}")
async def admin_delete_hub(hub_id: str, admin: Dict = Depends(require_write)):
    hub = await db.hubs.find_one({"id": hub_id}, {"_id": 0, "id": 1})
    if not hub:
        raise HTTPException(404, "hub_not_found")
    cars = await db.vehicles.count_documents({"hub_id": hub_id, "retired": {"$ne": True}})
    if cars > 0:
        raise HTTPException(409, "hub_has_cars")   # move cars out first
    await db.hubs.delete_one({"id": hub_id})
    await _audit(admin, "delete_hub", hub_id)
    return {"ok": True, "id": hub_id, "deleted": True}


@api.get("/admin/hubs/{hub_id}/roster")
async def admin_hub_roster(hub_id: str, admin: Dict = Depends(require_ops)):
    """A hub's full roster for the hub-detail page: its vehicles (with their
    day/night driver) and its drivers. Hub-managers may only open their hub."""
    scope = hub_scope(admin)
    if scope and scope != hub_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "out_of_hub_scope")
    hub = await db.hubs.find_one({"id": hub_id}, {"_id": 0})
    if not hub:
        raise HTTPException(404, "hub_not_found")

    vehicles = [v async for v in db.vehicles.find(
        {"hub_id": hub_id, "retired": {"$ne": True}}, {"_id": 0}).sort("number", 1)]
    vids = [v["id"] for v in vehicles]
    # Drivers in this hub (by hub_id) or holding one of its cars.
    drivers = [d async for d in db.drivers.find(
        {"archived": {"$ne": True}, "$or": [{"hub_id": hub_id}, {"vehicle_id": {"$in": vids or ['_none']}}]},
        {"_id": 0, "id": 1, "name": 1, "phone": 1, "code": 1, "shift_type": 1,
         "vehicle_id": 1, "active": 1})]
    by_slot: Dict[str, Dict[str, Any]] = {}
    for d in drivers:
        if d.get("vehicle_id"):
            by_slot[f"{d['vehicle_id']}:{d.get('shift_type', 'day')}"] = {
                "driver_id": d["id"], "name": d.get("name")}
    veh_out = []
    for v in vehicles:
        veh_out.append({
            "id": v["id"], "number": v.get("number"), "model": v.get("model"),
            "day_driver": by_slot.get(f"{v['id']}:day"),
            "night_driver": by_slot.get(f"{v['id']}:night"),
        })
    drv_out = [{
        "id": d["id"], "name": d.get("name"), "phone": d.get("phone"),
        "code": d.get("code"), "shift_type": d.get("shift_type", "day"),
        "vehicle_id": d.get("vehicle_id"), "active": d.get("active", True),
    } for d in sorted(drivers, key=lambda x: (x.get("code") or "", x.get("name") or ""))]
    return {"hub": await _hub_out(hub), "vehicles": veh_out, "drivers": drv_out}


class VehicleAssignIn(BaseModel):
    driver_id: Optional[str] = None     # None clears the slot
    shift: Literal["day", "night"] = "day"


@api.post("/admin/vehicles/{vehicle_id}/assign")
async def admin_assign_vehicle(
    vehicle_id: str, body: VehicleAssignIn, admin: Dict = Depends(require_ops)
):
    """Allot a car's day/night slot to a driver (or clear it). Atomic: frees the
    slot's current holder, moves the new driver onto this car+shift, and keeps
    the driver in the car's hub. Hub-managers are limited to their hub."""
    scope = hub_scope(admin)
    veh = await db.vehicles.find_one({"id": vehicle_id}, {"_id": 0, "id": 1, "hub_id": 1})
    if not veh:
        raise HTTPException(404, "vehicle_not_found")
    await _assert_vehicle_in_scope(veh, scope)
    # Free whoever currently holds this car on this shift.
    await db.drivers.update_many(
        {"vehicle_id": vehicle_id, "shift_type": body.shift},
        {"$set": {"vehicle_id": None}},
    )
    if body.driver_id:
        drv = await db.drivers.find_one(
            {"id": body.driver_id}, {"_id": 0, "id": 1, "hub_id": 1, "vehicle_id": 1})
        if not drv:
            raise HTTPException(404, "driver_not_found")
        await _assert_driver_in_scope(drv, scope)
        hub = await db.hubs.find_one({"id": veh.get("hub_id")}, {"_id": 0, "name": 1}) if veh.get("hub_id") else None
        await db.drivers.update_one(
            {"id": body.driver_id},
            {"$set": {
                "vehicle_id": vehicle_id, "shift_type": body.shift,
                "hub_id": veh.get("hub_id"), "hub_name": hub.get("name") if hub else None,
            }},
        )
        await _audit(admin, "assign_vehicle", vehicle_id,
                     {"driver_id": body.driver_id, "shift": body.shift})
    else:
        await _audit(admin, "clear_vehicle_slot", vehicle_id, {"shift": body.shift})
    return {"ok": True, "vehicle_id": vehicle_id, "shift": body.shift, "driver_id": body.driver_id}


async def _check_shift_slot(vehicle_id: Optional[str], shift_type: str, exclude_driver_id: Optional[str]) -> None:
    """A car holds one day-shift driver and one night-shift driver. Refuse a
    second active driver on the same car for the same shift."""
    if not vehicle_id:
        return
    q: Dict[str, Any] = {
        "vehicle_id": vehicle_id,
        "shift_type": shift_type,
        "archived": {"$ne": True},
    }
    if exclude_driver_id:
        q["id"] = {"$ne": exclude_driver_id}
    clash = await db.drivers.find_one(q, {"_id": 0, "id": 1, "name": 1})
    if clash:
        raise HTTPException(409, "shift_slot_taken")


async def _scope_vehicle_ids(scope: Optional[str]) -> Optional[List[str]]:
    """Vehicle ids under the scope hub; None means unrestricted."""
    if scope is None:
        return None
    return [v["id"] async for v in db.vehicles.find({"hub_id": scope}, {"_id": 0, "id": 1})]


async def _hub_driver_ids(hub_id: str) -> List[str]:
    """Driver ids belonging to a hub: set by hub_id, or holding one of its cars.
    Mirrors the roster's definition so every hub-scoped listing agrees on who
    'belongs' to a hub."""
    vids = [v["id"] async for v in db.vehicles.find({"hub_id": hub_id}, {"_id": 0, "id": 1})]
    return [d["id"] async for d in db.drivers.find(
        {"$or": [{"hub_id": hub_id}, {"vehicle_id": {"$in": vids or ['_none']}}]},
        {"_id": 0, "id": 1})]


def _hub_target(admin: Dict, hub_id: Optional[str]) -> Optional[str]:
    """Which hub a listing is scoped to. A hub_manager is pinned to their own
    hub and may not pass another's (403); an owner/manager may pass ?hub_id= to
    scope to one hub, or omit it for the whole fleet. None => whole fleet."""
    scope = hub_scope(admin)
    if scope and hub_id and hub_id != scope:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "out_of_hub_scope")
    return scope or hub_id


async def _assert_driver_in_scope(driver: Dict, scope: Optional[str]) -> None:
    if scope is None:
        return
    if driver.get("hub_id") == scope:
        return
    vid = driver.get("vehicle_id")
    if vid:
        v = await db.vehicles.find_one({"id": vid}, {"_id": 0, "hub_id": 1})
        if v and v.get("hub_id") == scope:
            return
    raise HTTPException(status.HTTP_403_FORBIDDEN, "out_of_hub_scope")


async def _assert_vehicle_in_scope(vehicle: Dict, scope: Optional[str]) -> None:
    if scope is None:
        return
    if vehicle.get("hub_id") != scope:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "out_of_hub_scope")


async def _assign_vehicle_hub(vehicle_id: str, hub_id: Optional[str]) -> None:
    """Validate a hub assignment and enforce its capacity. Raises HTTPException."""
    if not hub_id:
        return
    hub = await db.hubs.find_one({"id": hub_id}, {"_id": 0, "capacity": 1})
    if not hub:
        raise HTTPException(404, "hub_not_found")
    current = await db.vehicles.count_documents(
        {"hub_id": hub_id, "retired": {"$ne": True}, "id": {"$ne": vehicle_id}})
    if current >= hub.get("capacity", 12):
        raise HTTPException(409, "hub_full")


# ---- Fleet onboarding: vehicles + drivers ---------------------------------
@api.get("/admin/vehicles")
async def admin_list_vehicles(
    include_retired: bool = False, admin: Dict = Depends(get_admin)
):
    query: Dict[str, Any] = {} if include_retired else {"retired": {"$ne": True}}
    scope = hub_scope(admin)
    if scope:
        query["hub_id"] = scope   # a hub_manager sees only their hub's cars
    vehicles = [v async for v in db.vehicles.find(query, {"_id": 0}).sort("number", 1)]
    # Each car holds one day driver and one night driver. Track both per car so
    # the UI can show the pair and offer only the open shift slots.
    by_vehicle: Dict[str, Dict[str, str]] = {}
    async for d in db.drivers.find(
        {"vehicle_id": {"$ne": None}, "archived": {"$ne": True}},
        {"_id": 0, "vehicle_id": 1, "name": 1, "shift_type": 1},
    ):
        by_vehicle.setdefault(d["vehicle_id"], {})[d.get("shift_type", "day")] = d.get("name")
    hub_names = {h["id"]: h.get("name") async for h in db.hubs.find({}, {"_id": 0, "id": 1, "name": 1})}
    for v in vehicles:
        drs = by_vehicle.get(v["id"], {})
        v["day_driver"] = drs.get("day")
        v["night_driver"] = drs.get("night")
        v["day_open"] = "day" not in drs
        v["night_open"] = "night" not in drs
        v["assigned"] = bool(drs)
        v["assigned_driver"] = drs.get("day") or drs.get("night")   # backward compat
        v["retired"] = bool(v.get("retired"))
        v["hub_id"] = v.get("hub_id")
        v["hub_name"] = hub_names.get(v.get("hub_id"))
    return {"items": vehicles, "count": len(vehicles)}


@api.post("/admin/vehicles")
async def admin_create_vehicle(body: VehicleCreateIn, admin: Dict = Depends(require_ops)):
    number = body.number.strip().upper()
    if await db.vehicles.find_one({"number": number}, {"_id": 0, "id": 1}):
        raise HTTPException(409, "vehicle_number_exists")
    scope = hub_scope(admin)
    veh_hub = scope if scope is not None else body.hub_id   # a hub_manager's cars land in their hub
    vid = str(uuid.uuid4())
    await _assign_vehicle_hub(vid, veh_hub)
    row = {
        "id": vid,
        "number": number,
        "model": body.model,
        "current_soc": body.current_soc,
        "current_range_km": body.current_range_km,
        "hub_id": veh_hub,
        "created_by": admin["username"],
        "created_at": iso(now_utc()),
    }
    await db.vehicles.insert_one(row.copy())
    row.pop("_id", None)
    await _audit(admin, "create_vehicle", row["id"], {"number": number})
    return row


@api.patch("/admin/vehicles/{vehicle_id}")
async def admin_update_vehicle(
    vehicle_id: str, body: VehicleUpdateIn, admin: Dict = Depends(require_ops)
):
    veh = await db.vehicles.find_one({"id": vehicle_id}, {"_id": 0, "id": 1, "hub_id": 1})
    if not veh:
        raise HTTPException(404, "vehicle_not_found")
    scope = hub_scope(admin)
    await _assert_vehicle_in_scope(veh, scope)
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
    # A hub_manager can't move a car out of their hub.
    if body.hub_id is not None and scope is None:
        # "" clears the hub; any other value must exist and have room.
        hub_id = body.hub_id or None
        if hub_id:
            await _assign_vehicle_hub(vehicle_id, hub_id)
        updates["hub_id"] = hub_id
    if not updates:
        return {"ok": True, "unchanged": True}
    updates["updated_at"] = iso(now_utc())
    updates["updated_by"] = admin["username"]
    await db.vehicles.update_one({"id": vehicle_id}, {"$set": updates})
    return {"ok": True, "id": vehicle_id, "updated": list(updates.keys())}


@api.delete("/admin/vehicles/{vehicle_id}")
async def admin_retire_vehicle(vehicle_id: str, admin: Dict = Depends(require_ops)):
    """Retire a vehicle (reversible). Refuses while a driver still holds it —
    unassign the driver first so a plate is never orphaned on a live driver."""
    veh = await db.vehicles.find_one({"id": vehicle_id}, {"_id": 0, "id": 1, "hub_id": 1})
    if not veh:
        raise HTTPException(404, "vehicle_not_found")
    await _assert_vehicle_in_scope(veh, hub_scope(admin))
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
async def admin_restore_vehicle(vehicle_id: str, admin: Dict = Depends(require_ops)):
    veh = await db.vehicles.find_one({"id": vehicle_id}, {"_id": 0, "id": 1, "hub_id": 1})
    if not veh:
        raise HTTPException(404, "vehicle_not_found")
    await _assert_vehicle_in_scope(veh, hub_scope(admin))
    await db.vehicles.update_one(
        {"id": vehicle_id},
        {"$set": {"retired": False}, "$unset": {"retired_at": "", "retired_by": ""}},
    )
    return {"ok": True, "id": vehicle_id, "retired": False}


@api.post("/admin/drivers")
async def admin_create_driver(body: DriverCreateIn, admin: Dict = Depends(require_ops)):
    phone = _norm_phone(body.phone)   # stored the way login looks it up
    if await db.drivers.find_one({"phone": phone}, {"_id": 0, "id": 1}):
        raise HTTPException(409, "phone_already_registered")
    scope = hub_scope(admin)
    if body.vehicle_id:
        veh = await db.vehicles.find_one({"id": body.vehicle_id}, {"_id": 0, "id": 1, "hub_id": 1})
        if not veh:
            raise HTTPException(404, "vehicle_not_found")
        await _assert_vehicle_in_scope(veh, scope)   # hub_manager: car must be in their hub
        await _check_shift_slot(body.vehicle_id, body.shift_type, None)
    # A hub_manager's new drivers always belong to their hub.
    hub_id = scope if scope is not None else (body.hub_id or None)
    hub_name, hub_lat, hub_lng = body.hub_name, body.hub_lat, body.hub_lng
    if hub_id:
        hub = await db.hubs.find_one({"id": hub_id}, {"_id": 0})
        if not hub:
            raise HTTPException(404, "hub_not_found")
        hub_name = hub.get("name")           # keep the label in sync with the hub
        hub_lat = hub.get("lat", hub_lat)
        hub_lng = hub.get("lng", hub_lng)
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
        "hub_id": hub_id,
        "hub_name": hub_name,
        "hub_lat": hub_lat,
        "hub_lng": hub_lng,
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
    driver_id: str, body: DriverUpdateIn, admin: Dict = Depends(require_ops)
):
    driver = await db.drivers.find_one({"id": driver_id}, {"_id": 0})
    if not driver:
        raise HTTPException(404, "driver_not_found")
    scope = hub_scope(admin)
    await _assert_driver_in_scope(driver, scope)
    updates: Dict[str, Any] = {}
    for field in ("name", "phone", "vehicle_id", "hub_name", "hub_lat",
                  "hub_lng", "shift_type", "shift_start_time", "shift_end_time",
                  "status", "active"):
        val = getattr(body, field)
        if val is not None:
            val = val.strip() if isinstance(val, str) else val
            # A blank shift time clears it — back to "no hub-set wake-up".
            if field in ("shift_start_time", "shift_end_time") and val == "":
                val = None
            updates[field] = val
    if "phone" in updates:
        updates["phone"] = _norm_phone(updates["phone"])
        clash = await db.drivers.find_one(
            {"phone": updates["phone"], "id": {"$ne": driver_id}}, {"_id": 0, "id": 1}
        )
        if clash:
            raise HTTPException(409, "phone_already_registered")
    if updates.get("vehicle_id"):
        if not await db.vehicles.find_one({"id": updates["vehicle_id"]}, {"_id": 0, "id": 1}):
            raise HTTPException(404, "vehicle_not_found")
    # A hub_manager can only assign cars within their own hub.
    if scope is not None and updates.get("vehicle_id"):
        nv = await db.vehicles.find_one({"id": updates["vehicle_id"]}, {"_id": 0, "hub_id": 1})
        await _assert_vehicle_in_scope(nv or {}, scope)
    # Re-check the shift slot when the car or the shift changes.
    if "vehicle_id" in updates or "shift_type" in updates:
        new_vehicle = updates.get("vehicle_id", driver.get("vehicle_id"))
        new_shift = updates.get("shift_type", driver.get("shift_type", "day"))
        await _check_shift_slot(new_vehicle, new_shift, driver_id)
    # Only fleet managers may move a driver between hubs.
    if body.hub_id is not None and scope is None:
        hub_id = body.hub_id or None
        if hub_id:
            hub = await db.hubs.find_one({"id": hub_id}, {"_id": 0})
            if not hub:
                raise HTTPException(404, "hub_not_found")
            updates["hub_name"] = hub.get("name")   # keep the label in sync
            if hub.get("lat") is not None:
                updates["hub_lat"] = hub["lat"]
            if hub.get("lng") is not None:
                updates["hub_lng"] = hub["lng"]
        else:
            updates["hub_name"] = None
        updates["hub_id"] = hub_id
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
    await _assert_driver_in_scope(d, hub_scope(admin))
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
            "code": d.get("code"),
            "hub_id": d.get("hub_id"),
            "hub_name": d.get("hub_name"),
            "hub_lat": d.get("hub_lat"),
            "hub_lng": d.get("hub_lng"),
            "shift_type": d.get("shift_type"),
            "shift_start_time": d.get("shift_start_time"),
            "shift_end_time": d.get("shift_end_time"),
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
        "shift_alarms": [r async for r in db.alarm_responses.find(
            {"driver_id": driver_id}, {"_id": 0}).sort("created_at", -1).limit(20)],
    }


# How far either side of a tap to look for a phone fix when the tap itself
# carried no position.
ACTIVITY_PING_WINDOW_SECONDS = 180


async def _tap_position(driver_id: str, row: Dict, ts: datetime) -> Tuple[Optional[float], Optional[float], Optional[str]]:
    """Where a button was pressed: (lat, lng, source). `source` is "tap" when
    the phone sent its position with the press, "nearby_ping" when it did not
    and the closest tracked fix within a few minutes is used instead, or None
    when nothing is known. 0,0 from older app builds counts as unknown."""
    lat, lng = row.get("lat"), row.get("lng")
    if lat is not None and lng is not None and not (abs(lat) < 1e-6 and abs(lng) < 1e-6):
        return lat, lng, "tap"
    w = timedelta(seconds=ACTIVITY_PING_WINDOW_SECONDS)
    best = None
    async for p in db.phone_pings.find(
        {"driver_id": driver_id, "lat": {"$ne": None},
         "recorded_at": {"$gte": iso(ts - w)[:19], "$lte": iso(ts + w)[:19] + "~"}},
        {"_id": 0, "lat": 1, "lng": 1, "recorded_at": 1},
    ):
        try:
            gap = abs((_parse_iso(p["recorded_at"]) - ts).total_seconds())
        except Exception:
            continue
        if p.get("lng") is not None and gap <= ACTIVITY_PING_WINDOW_SECONDS and (best is None or gap < best[0]):
            best = (gap, p)
    if best:
        return best[1]["lat"], best[1]["lng"], "nearby_ping"
    return None, None, None


async def _activity_log(driver_id: str, business_date: str) -> List[Dict[str, Any]]:
    """Every button the driver pressed on a business day, oldest first, with
    where it was pressed. Each entry says what the press did:

      start_duty / end_duty
      apps_changed       an Uber / Rapido / Ola switch — see turned_on / turned_off
      to_charger / charging_started / charging_finished
      no_change          a press that changed nothing (e.g. "Not online" twice)

    `online_on` is the set of apps the driver was online on after the press.
    """
    day_start, day_end = business_day_bounds(business_date)
    apps: set = set()
    prev_state: Optional[str] = None
    out: List[Dict[str, Any]] = []
    async for r in db.duty_states.find({"driver_id": driver_id}, {"_id": 0}).sort("started_at", 1):
        try:
            ts = _parse_iso(r["started_at"])
        except Exception:
            continue
        state = r.get("state")
        before = set(apps)
        if state in ("start_duty", "end_duty"):
            apps = set()
        elif state in ("online", "not_online") or state in PLATFORMS:
            plats = r.get("platforms")
            if plats is None:
                plats = [state] if state in PLATFORMS else []
            apps = set(plats)
        if day_start <= ts < day_end:
            turned_on, turned_off = sorted(apps - before), sorted(before - apps)
            if state in ("start_duty", "end_duty", "to_charger"):
                action = state
            elif state == "charging":
                action = "charging_started"
            elif state == "not_online" and prev_state == "charging":
                action = "charging_finished"
            elif turned_on or turned_off:
                action = "apps_changed"
            else:
                action = "no_change"
            lat, lng, where = await _tap_position(driver_id, r, ts)
            out.append({
                "id": r.get("id"),
                "at": iso(ts),
                "action": action,
                "state": state,
                "turned_on": [] if state == "start_duty" else turned_on,
                "turned_off": [] if state == "start_duty" else turned_off,
                "online_on": sorted(apps),
                "lat": lat, "lng": lng, "location_source": where,
                "source": r.get("source") or "driver",
            })
        prev_state = state
    return out


@api.get("/admin/drivers/{driver_id}/duty")
async def admin_driver_duty(
    driver_id: str, date: Optional[str] = None, admin: Dict = Depends(get_admin)
):
    """One driver's duty rollup + segment timeline for a business day (defaults
    to today). Drives the driver page's duty/activity card. Hub-scoped."""
    d = await db.drivers.find_one(
        {"id": driver_id}, {"_id": 0, "id": 1, "vehicle_id": 1, "hub_id": 1})
    if not d:
        raise HTTPException(404, "driver_not_found")
    await _assert_driver_in_scope(d, hub_scope(admin))
    bd = _bd_or_400(date)
    summary = await _duty_summary(driver_id, d.get("vehicle_id"), bd)
    last = await _last_ping(d.get("vehicle_id"), driver_id)
    summary["last_ping_at"] = last.get("recorded_at")
    summary["last_lat"] = last.get("lat")
    summary["last_lng"] = last.get("lng")
    # Every button press of the day, with where it was pressed.
    summary["log"] = await _activity_log(driver_id, bd)
    return summary


@api.get("/admin/hubs/{hub_id}/activity")
async def admin_hub_activity(
    hub_id: str, date: Optional[str] = None, admin: Dict = Depends(require_ops)
):
    """A hub's duty board for a business day: each driver's on-duty status,
    platforms online, on-duty & working time, distance, and last GPS ping.
    Hub-managers may only open their own hub."""
    scope = hub_scope(admin)
    if scope and scope != hub_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "out_of_hub_scope")
    hub = await db.hubs.find_one({"id": hub_id}, {"_id": 0, "id": 1, "name": 1})
    if not hub:
        raise HTTPException(404, "hub_not_found")
    bd = _bd_or_400(date)
    ids = await _hub_driver_ids(hub_id)
    drivers = [d async for d in db.drivers.find(
        {"id": {"$in": ids}, "archived": {"$ne": True}},
        {"_id": 0, "id": 1, "name": 1, "code": 1, "phone": 1,
         "vehicle_id": 1, "shift_type": 1, "active": 1})]
    veh = {v["id"]: v async for v in db.vehicles.find(
        {"hub_id": hub_id}, {"_id": 0, "id": 1, "number": 1})}
    rows: List[Dict[str, Any]] = []
    for d in sorted(drivers, key=lambda x: (x.get("code") or "", x.get("name") or "")):
        summ = await _duty_summary(d["id"], d.get("vehicle_id"), bd)
        last = await _last_phone_ping(d["id"])
        track = await _tracking_status(d["id"], summ["on_duty"], last) if bd == business_date_now() else {}
        rows.append({
            "driver_id": d["id"], "name": d.get("name"), "code": d.get("code"),
            "phone": d.get("phone"), "shift_type": d.get("shift_type", "day"),
            "active": d.get("active", True),
            "vehicle_number": veh.get(d.get("vehicle_id"), {}).get("number"),
            "on_duty": summ["on_duty"],
            "current_platforms": summ["current_platforms"],
            "on_duty_seconds": summ["on_duty_seconds"],
            "working_seconds": summ["working_seconds"],
            "per_platform_seconds": summ["per_platform_seconds"],
            "distance_km": summ["distance_km"],
            "last_ping_at": last.get("recorded_at"),
            # today only: "live" | "stopped" (on duty but the phone has gone quiet) | None
            "tracking": track.get("tracking"),
            "tracking_reason": track.get("reason"),
        })
    on_now = sum(1 for r in rows if r["on_duty"])
    return {
        "hub": {"id": hub["id"], "name": hub.get("name")},
        "business_date": bd, "on_duty_now": on_now,
        "items": rows, "count": len(rows),
    }


@api.delete("/admin/drivers/{driver_id}")
async def admin_delete_driver(
    driver_id: str, hard: bool = False, admin: Dict = Depends(require_ops)
):
    """Remove a driver. Default is a reversible archive: the driver is
    deactivated, hidden from the roster, and their vehicle freed — cash and
    payout history are preserved for the audit trail. `hard=true` permanently
    deletes the driver record, and is refused when any financial history
    exists (deposits, platform cash, or payouts)."""
    d = await db.drivers.find_one({"id": driver_id}, {"_id": 0, "id": 1, "hub_id": 1, "vehicle_id": 1})
    if not d:
        raise HTTPException(404, "driver_not_found")
    await _assert_driver_in_scope(d, hub_scope(admin))

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
async def admin_restore_driver(driver_id: str, admin: Dict = Depends(require_ops)):
    d = await db.drivers.find_one({"id": driver_id}, {"_id": 0, "id": 1, "hub_id": 1, "vehicle_id": 1})
    if not d:
        raise HTTPException(404, "driver_not_found")
    await _assert_driver_in_scope(d, hub_scope(admin))
    await db.drivers.update_one(
        {"id": driver_id},
        {"$set": {"archived": False, "active": True},
         "$unset": {"archived_at": "", "archived_by": ""}},
    )
    return {"ok": True, "id": driver_id, "archived": False}


# ---- Live map --------------------------------------------------------------


@api.get("/admin/vehicles/live")
async def admin_vehicles_live(admin: Dict = Depends(fleet_admin)):
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
    # Drivers with no car assigned have no car dot; show them from their phone.
    async for d in db.drivers.find(
        {"vehicle_id": None, "archived": {"$ne": True}}, {"_id": 0, "id": 1, "name": 1, "hub_name": 1}
    ):
        last = await _last_phone_ping(d["id"])
        if not last:
            continue
        try:
            age_min = (now - _parse_iso(last["recorded_at"])).total_seconds() / 60
        except Exception:
            age_min = None
        out.append({
            "vehicle_id": None, "vehicle_number": None,
            "driver_id": d["id"], "driver_name": d.get("name"), "hub_name": d.get("hub_name"),
            "lat": last["lat"], "lng": last["lng"],
            "speed_kmph": None, "soc_pct": None, "accuracy_m": None,
            "recorded_at": last["recorded_at"],
            "age_minutes": round(age_min, 1) if age_min is not None else None,
            "stale": bool(age_min is not None and age_min > 10),
        })
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
async def admin_dashboard(days: int = 30, admin: Dict = Depends(fleet_admin)):
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
    include_all: bool = False, hub_id: Optional[str] = None,
    admin: Dict = Depends(fleet_admin),
):
    """Captures that need ops review. By default: flagged for movement or
    beyond the hub-warn radius and not yet reviewed. `include_all=true`
    returns every capture regardless of flags. `?hub_id=` scopes to one hub's
    drivers."""
    query: Dict[str, Any] = {}
    if not include_all:
        query = {
            "$or": [{"review_flag_movement": True}, {"hub_warn": True}],
            "review_decision": {"$exists": False},
        }
    target = _hub_target(admin, hub_id)
    if target:
        query["driver_id"] = {"$in": await _hub_driver_ids(target)}
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
async def admin_capture_media(capture_id: str, admin: Dict = Depends(fleet_admin)):
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
    include_all: bool = False, hub_id: Optional[str] = None,
    admin: Dict = Depends(fleet_admin),
):
    """Documents where an image has been uploaded but not yet verified.
    `include_all=true` returns every document regardless of state. `?hub_id=`
    scopes to one hub's drivers."""
    query: Dict[str, Any] = {} if include_all else {
        "verified": False,
        "image_b64": {"$ne": None},
    }
    target = _hub_target(admin, hub_id)
    if target:
        query["driver_id"] = {"$in": await _hub_driver_ids(target)}
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
async def admin_document_media(document_id: str, admin: Dict = Depends(fleet_admin)):
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
async def admin_summary(admin: Dict = Depends(fleet_admin)):
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
                                  "created_at": now_iso,
                                  "client_action_id": _day_row_key(platform, business_date)}},
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
# MANUAL DAILY EARNINGS (hub-entered) — the alternative to the CSV import.
# One canonical row per (driver, platform, business_date). A manual entry never
# overwrites an official settled import (precedence: settled > manual > ocr),
# so the two sources can't double-count.
# ---------------------------------------------------------------------------
def _day_row_key(platform: str, business_date: str) -> str:
    """The `client_action_id` for a driver's one canonical earnings row for a
    platform and day (hub-entered or imported from a report).

    platform_cash has a UNIQUE index on (driver_id, client_action_id), built
    for the driver app's idempotent uploads. A row written without that field
    counts as null, and a unique index allows only one null per driver — so
    without a key the hub could save a driver's earnings for exactly one day,
    and every other day was rejected. Every canonical row gets its own key."""
    return f"day:{platform}:{business_date}"


class EarningsEntryIn(BaseModel):
    business_date: Optional[str] = None          # YYYY-MM-DD; default today
    platform: Literal["uber", "rapido", "ola"] = "uber"
    gross_amount: float = Field(ge=0)
    cash_amount: float = Field(default=0, ge=0)  # cash the driver collected (drives dues)


@api.get("/admin/earnings")
async def admin_earnings_for_date(
    date: Optional[str] = None, platform: str = "uber",
    hub_id: Optional[str] = None, admin: Dict = Depends(require_ops)
):
    """The hub's drivers with their earnings entry for a given date+platform, so
    the daily-entry grid can prefill. A hub_manager is always pinned to their
    own hub; an owner may pass ?hub_id= to scope the grid to one hub (the
    hub-detail Earnings section does this)."""
    bd = date or business_date_now()
    scope = hub_scope(admin)
    if scope and hub_id and hub_id != scope:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "out_of_hub_scope")
    target_hub = scope or hub_id          # None => whole fleet (owner, no filter)
    dq: Dict[str, Any] = {"archived": {"$ne": True}}
    drivers = [d async for d in db.drivers.find(
        dq, {"_id": 0, "id": 1, "name": 1, "phone": 1, "code": 1, "hub_id": 1,
             "vehicle_id": 1, "shift_type": 1})]
    if target_hub:
        scoped_vids = set(await _scope_vehicle_ids(target_hub) or [])
        drivers = [d for d in drivers if d.get("hub_id") == target_hub or d.get("vehicle_id") in scoped_vids]
    ids = [d["id"] for d in drivers]
    rows = {r["driver_id"]: r async for r in db.platform_cash.find(
        {"driver_id": {"$in": ids}, "platform": platform, "business_date": bd},
        {"_id": 0, "driver_id": 1, "gross_amount": 1, "cash_amount": 1, "status": 1, "source": 1})} if ids else {}
    items = []
    for d in drivers:
        r = rows.get(d["id"])
        items.append({
            "driver_id": d["id"], "name": d.get("name"), "phone": d.get("phone"),
            "code": d.get("code"), "shift": d.get("shift_type", "day"),
            "gross_amount": (r or {}).get("gross_amount"),
            "cash_amount": (r or {}).get("cash_amount"),
            "source": (r or {}).get("source"),
            "locked": (r or {}).get("source") == "uber_report",   # official import — don't overwrite
        })
    items.sort(key=lambda x: (x["code"] or "", x["name"] or ""))
    return {"date": bd, "platform": platform, "items": items, "count": len(items)}


@api.post("/admin/drivers/{driver_id}/earnings")
async def admin_set_driver_earnings(
    driver_id: str, body: EarningsEntryIn, admin: Dict = Depends(require_ops)
):
    """Hub manually sets a driver's earnings for a day+platform. Upserts the one
    canonical row; refuses to overwrite an official settled import."""
    driver = await db.drivers.find_one(
        {"id": driver_id}, {"_id": 0, "id": 1, "hub_id": 1, "vehicle_id": 1})
    if not driver:
        raise HTTPException(404, "driver_not_found")
    await _assert_driver_in_scope(driver, hub_scope(admin))
    bd = _bd_or_400(body.business_date)          # any past day is fine; a bad date is a 400
    if bd > business_date_now():
        raise HTTPException(400, "future_date")
    existing = await db.platform_cash.find_one(
        {"driver_id": driver_id, "platform": body.platform, "business_date": bd},
        {"_id": 0, "source": 1})
    if existing and existing.get("source") == "uber_report":
        raise HTTPException(409, "already_imported")   # official report wins — don't clobber
    start, end = business_day_bounds(bd)
    now = iso(now_utc())
    # status "settled" so it counts toward dues/earnings/dashboard like a report;
    # source "manual" marks it hub-entered (editable; an import may later supersede).
    await db.platform_cash.update_one(
        {"driver_id": driver_id, "platform": body.platform, "business_date": bd},
        {"$set": {
            "driver_id": driver_id, "platform": body.platform, "business_date": bd,
            "gross_amount": round(body.gross_amount, 2),
            "cash_amount": round(body.cash_amount, 2),
            "status": "settled", "source": "manual",
            "window_start": iso(start), "window_end": iso(end),
            "entered_by": admin["username"], "updated_at": now,
         },
         "$setOnInsert": {"id": str(uuid.uuid4()), "created_at": now,
                          "client_action_id": _day_row_key(body.platform, bd)}},
        upsert=True,
    )
    await _audit(admin, "set_driver_earnings", driver_id,
                 {"date": bd, "platform": body.platform, "gross": round(body.gross_amount, 2)})
    return {"ok": True, "driver_id": driver_id, "business_date": bd,
            "platform": body.platform, "gross_amount": round(body.gross_amount, 2),
            "cash_amount": round(body.cash_amount, 2)}


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
async def admin_cash(hub_id: Optional[str] = None, admin: Dict = Depends(fleet_admin)):
    """Fleet cash reconciliation: per driver, settled platform cash collected
    (to yesterday) minus trusted deposits paid in. Reuses the single balance
    rule in `_driver_balances` so this never drifts from the driver's screen.
    `?hub_id=` scopes it to one hub's drivers."""
    target = _hub_target(admin, hub_id)
    dq: Dict[str, Any] = {"active": True}
    if target:
        dq["id"] = {"$in": await _hub_driver_ids(target)}
    drivers = [d async for d in db.drivers.find(
        dq,
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
async def admin_requests(
    state: Optional[str] = None, hub_id: Optional[str] = None,
    admin: Dict = Depends(fleet_admin),
):
    """Driver requests (advance / holiday / extra hours). `?state=pending`
    filters the queue; `?hub_id=` scopes to one hub's drivers."""
    query: Dict[str, Any] = {}
    if state:
        query["state"] = state
    target = _hub_target(admin, hub_id)
    if target:
        query["driver_id"] = {"$in": await _hub_driver_ids(target)}
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
async def admin_inspections(hub_id: Optional[str] = None, admin: Dict = Depends(fleet_admin)):
    """Daily vehicle inspections (dashboard photo + walkaround video). Media
    blobs are excluded here; fetch one via /admin/inspections/{id}/media.
    `?hub_id=` scopes to one hub's drivers."""
    target = _hub_target(admin, hub_id)
    iq: Dict[str, Any] = {}
    if target:
        iq["driver_id"] = {"$in": await _hub_driver_ids(target)}
    rows = [r async for r in db.inspections.find(
        iq, {"_id": 0, "dashboard_photo_b64": 0, "exterior_video_b64": 0},
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
async def admin_inspection_media(inspection_id: str, admin: Dict = Depends(fleet_admin)):
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
async def admin_shift_alarms(hub_id: Optional[str] = None, admin: Dict = Depends(get_admin)):
    """Recent shift-alarm responses — who acknowledged, who said they weren't
    coming, and the reason given. `?hub_id=` scopes to one hub's drivers; a
    hub_manager always sees their own hub. Answers to test alarms are left out."""
    target = _hub_target(admin, hub_id)
    aq: Dict[str, Any] = {"schedule_id": {"$not": {"$regex": _TEST_ALARM_REGEX}}}
    if target:
        aq["driver_id"] = {"$in": await _hub_driver_ids(target)}
    rows = [r async for r in db.alarm_responses.find(
        aq, {"_id": 0}
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
    unread_only: bool = False, hub_id: Optional[str] = None, limit: int = 200,
    admin: Dict = Depends(get_admin),
):
    """The inbox: what drivers wrote to ops, newest first, with the count ops
    has not read yet (the menu badge). A hub_manager sees their own hub's
    drivers; anyone else may pass `?hub_id=` to look at one hub."""
    await _alarm_watch()      # raises "no answer" / "not started" alerts when due
    query: Dict[str, Any] = {"direction": "from_driver"}
    target = _hub_target(admin, hub_id)
    if target:
        query["driver_id"] = {"$in": await _hub_driver_ids(target)}
    unread = await db.notifications.count_documents({**query, "read": False})
    if unread_only:
        query["read"] = False
    n = max(0, min(int(limit), 500))
    # limit=0 asks for the unread count only (to Mongo, 0 would mean "no limit")
    rows = [r async for r in db.notifications.find(query, {"_id": 0})
            .sort("created_at", -1).limit(n)] if n else []
    who = await _drivers_by_ids([r.get("driver_id") for r in rows])
    for r in rows:
        d = who.get(r.get("driver_id"), {})
        r["driver_name"] = d.get("name")
        r["driver_phone"] = d.get("phone")
    return {"items": rows, "count": len(rows), "unread": unread}


@api.get("/admin/drivers/{driver_id}/notifications")
async def admin_driver_notifications(driver_id: str, admin: Dict = Depends(get_admin)):
    scope = hub_scope(admin)
    if scope:
        d = await db.drivers.find_one({"id": driver_id}, {"_id": 0, "hub_id": 1, "vehicle_id": 1})
        if not d:
            raise HTTPException(404, "driver_not_found")
        await _assert_driver_in_scope(d, scope)
    rows = [r async for r in db.notifications.find(
        {"driver_id": driver_id}, {"_id": 0}
    ).sort("created_at", -1).limit(100)]
    return {"items": rows, "count": len(rows)}


async def _mark_driver_messages_read(driver_id: str, admin: Dict) -> int:
    """Mark everything this driver wrote that ops has not read yet as read."""
    res = await db.notifications.update_many(
        {"driver_id": driver_id, "direction": "from_driver", "read": False},
        {"$set": {"read": True, "read_at": iso(now_utc()), "read_by": admin["username"]}},
    )
    return res.modified_count


@api.post("/admin/drivers/{driver_id}/notifications/read")
async def admin_mark_driver_messages_read(driver_id: str, admin: Dict = Depends(require_ops)):
    """Ops has seen this driver's messages (without necessarily answering)."""
    driver = await db.drivers.find_one({"id": driver_id}, {"_id": 0, "id": 1, "hub_id": 1, "vehicle_id": 1})
    if not driver:
        raise HTTPException(404, "driver_not_found")
    await _assert_driver_in_scope(driver, hub_scope(admin))
    return {"ok": True, "marked": await _mark_driver_messages_read(driver_id, admin)}


@api.post("/admin/drivers/{driver_id}/notifications")
async def admin_send_notification(
    driver_id: str, body: AdminNotifyIn, admin: Dict = Depends(require_ops)
):
    """Ops sends a message to a driver — appears on the driver app's bell.
    A hub_manager may write to their own hub's drivers. Answering counts as
    having read what the driver wrote."""
    driver = await db.drivers.find_one({"id": driver_id}, {"_id": 0, "id": 1, "hub_id": 1, "vehicle_id": 1})
    if not driver:
        raise HTTPException(404, "driver_not_found")
    await _assert_driver_in_scope(driver, hub_scope(admin))
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
    await _mark_driver_messages_read(driver_id, admin)
    await _audit(admin, "notify_driver", driver_id)
    return row


@api.post("/admin/notifications/{notification_id}/read")
async def admin_mark_notification_read(
    notification_id: str, admin: Dict = Depends(require_ops)
):
    """Ops marks a driver → ops message as handled."""
    n = await db.notifications.find_one(
        {"id": notification_id, "direction": "from_driver"}, {"_id": 0, "driver_id": 1})
    if not n:
        raise HTTPException(404, "notification_not_found")
    scope = hub_scope(admin)
    if scope:
        driver = await db.drivers.find_one({"id": n["driver_id"]}, {"_id": 0, "hub_id": 1, "vehicle_id": 1})
        await _assert_driver_in_scope(driver or {}, scope)
    await db.notifications.update_one(
        {"id": notification_id, "direction": "from_driver"},
        {"$set": {"read": True, "read_at": iso(now_utc()), "read_by": admin["username"]}},
    )
    return {"ok": True}


# ---- Earnings & rewards leaderboard (admin) --------------------------------
async def _reward_gross(mon_bd: str, next_mon_bd: str, y_bd: str):
    """Per-driver weekly gross, the SET of days they operated, and yesterday's
    gross — the raw material for both car-level and driver-level rewards."""
    dweek: Dict[str, float] = {}
    ddays: Dict[str, set] = {}
    async for r in db.platform_cash.aggregate([
        {"$match": {"business_date": {"$gte": mon_bd, "$lt": next_mon_bd}}},
        {"$group": {
            "_id": {"d": "$driver_id", "bd": "$business_date"},
            "g": {"$sum": {"$ifNull": ["$gross_amount", "$cash_amount"]}},
        }},
    ]):
        did, bd, g = r["_id"]["d"], r["_id"]["bd"], float(r.get("g") or 0)
        dweek[did] = dweek.get(did, 0.0) + g
        if g > 0:
            ddays.setdefault(did, set()).add(bd)
    dyday: Dict[str, float] = {}
    async for r in db.platform_cash.aggregate([
        {"$match": {"business_date": y_bd}},
        {"$group": {"_id": "$driver_id", "g": {"$sum": {"$ifNull": ["$gross_amount", "$cash_amount"]}}}},
    ]):
        dyday[r["_id"]] = float(r.get("g") or 0)
    return dweek, ddays, dyday


@api.get("/admin/rewards")
async def admin_rewards(hub_id: Optional[str] = None, admin: Dict = Depends(get_admin)):
    """Weekly reward standings, grouped by hub. Each hub has a CARS board
    (day+night gross combined → top car of day/week) and a DRIVERS board
    (individual gross → top driver of week). Winners are the ★ per hub; ops
    pays them (rewards are on top of the 30% share)."""
    (REWARD_DAILY_TARGET, REWARD_TOP_CAR_DAY, REWARD_WEEK_CAR_TARGET,
     REWARD_TOP_CAR_WEEK, REWARD_WEEK_DRIVER_TARGET, REWARD_TOP_DRIVER_WEEK,
     REWARD_DAYS_REQUIRED) = _weekly_reward_cfg()
    today_bd = business_date_now()
    today_d = datetime.strptime(today_bd, "%Y-%m-%d").date()
    y_bd = (today_d - timedelta(days=1)).strftime("%Y-%m-%d")
    mon_bd, next_mon_bd, days_remaining = week_bounds_for_business_date(today_bd)
    dweek, ddays, dyday = await _reward_gross(mon_bd, next_mon_bd, y_bd)

    # A hub_manager is pinned to their hub; an owner may pass ?hub_id= to see
    # just one hub's board (the hub-detail Rewards tab does this).
    scope = _hub_target(admin, hub_id)
    veh_q: Dict[str, Any] = {"retired": {"$ne": True}}
    hub_q: Dict[str, Any] = {}
    if scope:
        veh_q["hub_id"] = scope
        hub_q["id"] = scope
    vehicles = {v["id"]: v async for v in db.vehicles.find(
        veh_q, {"_id": 0, "id": 1, "number": 1, "hub_id": 1})}
    hubs = [h async for h in db.hubs.find(hub_q, {"_id": 0, "id": 1, "name": 1})]
    hub_name = {h["id"]: h.get("name") for h in hubs}
    drivers = [d async for d in db.drivers.find(
        {"archived": {"$ne": True}},
        {"_id": 0, "id": 1, "name": 1, "phone": 1, "vehicle_id": 1, "hub_id": 1, "shift_type": 1})]
    if scope:
        # Drivers of the scoped hub, or drivers holding one of its cars.
        drivers = [d for d in drivers if d.get("hub_id") == scope or d.get("vehicle_id") in vehicles]

    def dstat(did):
        return dweek.get(did, 0.0), len(ddays.get(did, set())), dyday.get(did, 0.0)

    # ---- Cars: combine each car's day + night drivers ----
    cars_by_id: Dict[str, Dict[str, Any]] = {}
    for d in drivers:
        vid = d.get("vehicle_id")
        if not vid or vid not in vehicles:
            continue
        wk, _days, yd = dstat(d["id"])
        c = cars_by_id.setdefault(vid, {
            "vehicle_id": vid, "number": vehicles[vid].get("number"),
            "hub_id": vehicles[vid].get("hub_id"),
            "week_gross": 0.0, "yesterday_gross": 0.0, "day_set": set(), "drivers": [],
        })
        c["week_gross"] += wk
        c["yesterday_gross"] += yd
        c["day_set"] |= ddays.get(d["id"], set())
        c["drivers"].append({"driver_id": d["id"], "name": d.get("name"), "shift": d.get("shift_type", "day")})

    # ---- Group into hubs ----
    out_hubs: Dict[str, Dict[str, Any]] = {
        h["id"]: {"hub_id": h["id"], "hub_name": h.get("name"), "cars": [], "drivers": []} for h in hubs
    }
    UNASSIGNED = "_none"
    out_hubs[UNASSIGNED] = {"hub_id": None, "hub_name": None, "cars": [], "drivers": []}

    for c in cars_by_id.values():
        hid = c["hub_id"] if c["hub_id"] in out_hubs else UNASSIGNED
        out_hubs[hid]["cars"].append({
            "vehicle_id": c["vehicle_id"], "number": c["number"],
            "week_gross": round(c["week_gross"], 2),
            "yesterday_gross": round(c["yesterday_gross"], 2),
            "days_operated": len(c["day_set"]),
            "drivers": c["drivers"],
            "q_car_day": c["yesterday_gross"] >= REWARD_DAILY_TARGET,
            "q_car_week": c["week_gross"] >= REWARD_WEEK_CAR_TARGET and len(c["day_set"]) >= REWARD_DAYS_REQUIRED,
        })
    for d in drivers:
        hid = d.get("hub_id") or vehicles.get(d.get("vehicle_id"), {}).get("hub_id")
        hid = hid if hid in out_hubs else UNASSIGNED
        wk, days, yd = dstat(d["id"])
        out_hubs[hid]["drivers"].append({
            "driver_id": d["id"], "name": d.get("name"), "phone": d.get("phone"),
            "shift": d.get("shift_type", "day"),
            "week_gross": round(wk, 2), "yesterday_gross": round(yd, 2), "days_operated": days,
            "q_driver_week": wk >= REWARD_WEEK_DRIVER_TARGET,
        })

    # ---- Rank + mark the ★ leaders within each hub ----
    hubs_out: List[Dict[str, Any]] = []
    for hb in out_hubs.values():
        cars, drvs = hb["cars"], hb["drivers"]
        cars.sort(key=lambda c: c["week_gross"], reverse=True)
        drvs.sort(key=lambda d: d["week_gross"], reverse=True)
        day_q = [c for c in cars if c["q_car_day"]]
        car_q = [c for c in cars if c["q_car_week"]]
        drv_q = [d for d in drvs if d["q_driver_week"]]
        top_day = max(day_q, key=lambda c: c["yesterday_gross"])["vehicle_id"] if day_q else None
        top_car = max(car_q, key=lambda c: c["week_gross"])["vehicle_id"] if car_q else None
        top_drv = max(drv_q, key=lambda d: d["week_gross"])["driver_id"] if drv_q else None
        for c in cars:
            c["is_top_car_day"] = c["vehicle_id"] == top_day
            c["is_top_car_week"] = c["vehicle_id"] == top_car
        for d in drvs:
            d["is_top_driver_week"] = d["driver_id"] == top_drv
        if cars or drvs:
            hb["week_gross"] = round(sum(c["week_gross"] for c in cars), 2)
            hubs_out.append(hb)
    # Real hubs first (by gross), unassigned last.
    hubs_out.sort(key=lambda h: (h["hub_id"] is None, -h.get("week_gross", 0)))

    return {
        "week_start": mon_bd,
        "days_remaining": days_remaining,
        "hubs": hubs_out,
        "thresholds": {
            "daily_target": REWARD_DAILY_TARGET, "top_car_day": REWARD_TOP_CAR_DAY,
            "week_car_target": REWARD_WEEK_CAR_TARGET, "top_car_week": REWARD_TOP_CAR_WEEK,
            "week_driver_target": REWARD_WEEK_DRIVER_TARGET, "top_driver_week": REWARD_TOP_DRIVER_WEEK,
            "days_required": REWARD_DAYS_REQUIRED,
        },
    }


@api.get("/admin/loyalty")
async def admin_loyalty(admin: Dict = Depends(get_admin)):
    """Loyalty + yearly standings, grouped by hub. Each hub shows a YEARLY board
    (top driver + top car of the year, on cumulative gross) and a LOYALTY roster
    (each driver's tenure, next milestone, and vested total). Winners/vested
    amounts are paid manually by ops. Scoped to a hub_manager's own hub."""
    LOYALTY_MILESTONES = get_setting("loyalty_milestones")
    YEARLY_TOP_DRIVER = get_setting("yearly_top_driver")
    YEARLY_TOP_CAR = get_setting("yearly_top_car")
    scope = hub_scope(admin)
    today_bd = business_date_now()
    year_start, next_year, year_label = _year_bounds(today_bd)
    ygross = await _yearly_gross(year_start, next_year)

    veh_q: Dict[str, Any] = {"retired": {"$ne": True}}
    hub_q: Dict[str, Any] = {}
    if scope:
        veh_q["hub_id"] = scope
        hub_q["id"] = scope
    vehicles = {v["id"]: v async for v in db.vehicles.find(
        veh_q, {"_id": 0, "id": 1, "number": 1, "hub_id": 1})}
    hubs = [h async for h in db.hubs.find(hub_q, {"_id": 0, "id": 1, "name": 1})]
    drivers = [d async for d in db.drivers.find(
        {"archived": {"$ne": True}},
        {"_id": 0, "id": 1, "name": 1, "phone": 1, "vehicle_id": 1, "hub_id": 1,
         "shift_type": 1, "created_at": 1, "joined_at": 1, "active": 1, "archived": 1})]
    if scope:
        drivers = [d for d in drivers if d.get("hub_id") == scope or d.get("vehicle_id") in vehicles]

    UNASSIGNED = "_none"
    out_hubs: Dict[str, Dict[str, Any]] = {
        h["id"]: {"hub_id": h["id"], "hub_name": h.get("name"), "drivers": [], "cars": []} for h in hubs
    }
    out_hubs[UNASSIGNED] = {"hub_id": None, "hub_name": None, "drivers": [], "cars": []}

    def bucket(d) -> str:
        hid = d.get("hub_id") or vehicles.get(d.get("vehicle_id"), {}).get("hub_id")
        return hid if hid in out_hubs else UNASSIGNED

    # ---- Drivers: year gross + loyalty + wallet ----
    loyalty_start = get_setting("loyalty_wallet_start_date") or "2000-01-01"
    cum = await _cumulative_gross(loyalty_start)
    for d in drivers:
        hb = out_hubs[bucket(d)]
        ly = _loyalty_state(d, cum.get(d["id"], 0.0))
        wallet = await _loyalty_wallet(d, cum.get(d["id"], 0.0))
        att = await _attendance_state(d)
        hb["drivers"].append({
            "driver_id": d["id"], "name": d.get("name"), "phone": d.get("phone"),
            "shift": d.get("shift_type", "day"),
            "year_gross": round(ygross.get(d["id"], 0.0), 2),
            "tenure_days": ly["tenure_days"],
            "next_milestone": ly["next"],
            "vested_total": ly["vested_total"],
            "milestones": ly["milestones"],
            "wallet_balance": wallet["balance"],
            "wallet_accrued": wallet["accrued"],
            "wallet_paid": wallet["paid"],
            "att_good_days": att["good_days"],
            "att_min_days": att["min_days"],
            "att_qualified": att["qualified"],
            "att_bonus": att["bonus"],
            "att_paid": att["paid"],
            "att_month": att["month"],
        })

    # ---- Cars: combine day + night year gross ----
    cars: Dict[str, Dict[str, Any]] = {}
    for d in drivers:
        vid = d.get("vehicle_id")
        if not vid or vid not in vehicles:
            continue
        c = cars.setdefault(vid, {
            "vehicle_id": vid, "number": vehicles[vid].get("number"),
            "hub_id": vehicles[vid].get("hub_id"), "year_gross": 0.0, "drivers": [],
        })
        c["year_gross"] += ygross.get(d["id"], 0.0)
        c["drivers"].append({"driver_id": d["id"], "name": d.get("name"), "shift": d.get("shift_type", "day")})
    for c in cars.values():
        hid = c["hub_id"] if c["hub_id"] in out_hubs else UNASSIGNED
        out_hubs[hid]["cars"].append({
            "vehicle_id": c["vehicle_id"], "number": c["number"],
            "year_gross": round(c["year_gross"], 2), "drivers": c["drivers"],
        })

    # ---- Rank + mark ★ per hub ----
    hubs_out: List[Dict[str, Any]] = []
    for hb in out_hubs.values():
        drvs, crs = hb["drivers"], hb["cars"]
        drvs.sort(key=lambda d: d["year_gross"], reverse=True)
        crs.sort(key=lambda c: c["year_gross"], reverse=True)
        top_drv = drvs[0]["driver_id"] if drvs and drvs[0]["year_gross"] > 0 else None
        top_car = crs[0]["vehicle_id"] if crs and crs[0]["year_gross"] > 0 else None
        for d in drvs:
            d["is_top_driver_year"] = d["driver_id"] == top_drv
        for c in crs:
            c["is_top_car_year"] = c["vehicle_id"] == top_car
        if drvs or crs:
            hb["year_gross"] = round(sum(c["year_gross"] for c in crs), 2)
            hubs_out.append(hb)
    hubs_out.sort(key=lambda h: (h["hub_id"] is None, -h.get("year_gross", 0)))

    return {
        "year": year_label,
        "hubs": hubs_out,
        "milestones": LOYALTY_MILESTONES,
        "thresholds": {"top_driver_year": YEARLY_TOP_DRIVER, "top_car_year": YEARLY_TOP_CAR},
        "wallet_enabled": bool(get_setting("loyalty_wallet_enabled")),
        "attendance_enabled": bool(get_setting("attendance_enabled")),
    }


class LoyaltyPayoutIn(BaseModel):
    amount: float = Field(gt=0)
    note: Optional[str] = None


@api.post("/admin/drivers/{driver_id}/loyalty-payout")
async def admin_loyalty_payout(
    driver_id: str, body: LoyaltyPayoutIn, admin: Dict = Depends(require_write)
):
    """Record a payout of a driver's loyalty-wallet balance. Capped at the
    current payable balance so a driver can't be over-paid."""
    driver = await db.drivers.find_one(
        {"id": driver_id}, {"_id": 0, "id": 1, "active": 1, "archived": 1})
    if not driver:
        raise HTTPException(404, "driver_not_found")
    loyalty_start = get_setting("loyalty_wallet_start_date") or "2000-01-01"
    cum_gross = await _driver_cumulative_gross(driver_id, loyalty_start)
    wallet = await _loyalty_wallet(driver, cum_gross)
    if not wallet["enabled"]:
        raise HTTPException(409, "loyalty_wallet_disabled")
    if body.amount > wallet["balance"] + 0.01:
        raise HTTPException(409, "amount_exceeds_balance")
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver_id,
        "type": "loyalty_wallet",
        "amount": round(float(body.amount), 2),
        "note": body.note,
        "created_at": iso(now_utc()),
        "created_by": admin["username"],
    }
    await db.reward_payouts.insert_one(row.copy())
    await _audit(admin, "loyalty_wallet_payout", driver_id, {"amount": row["amount"]})
    return {"ok": True, "paid": row["amount"], "wallet": await _loyalty_wallet(driver, cum_gross)}


@api.post("/admin/drivers/{driver_id}/attendance-payout")
async def admin_attendance_payout(driver_id: str, admin: Dict = Depends(require_write)):
    """Pay the current month's attendance bonus. Only when the month qualifies,
    and once per driver per month (idempotent)."""
    driver = await db.drivers.find_one(
        {"id": driver_id}, {"_id": 0, "id": 1, "active": 1, "archived": 1})
    if not driver:
        raise HTTPException(404, "driver_not_found")
    att = await _attendance_state(driver)
    if not att["enabled"]:
        raise HTTPException(409, "attendance_disabled")
    if not att["qualified"]:
        raise HTTPException(409, "month_not_qualified")
    if att["paid"]:
        raise HTTPException(409, "already_paid_this_month")
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver_id,
        "type": "attendance",
        "month": att["month"],
        "amount": int(att["bonus"]),
        "created_at": iso(now_utc()),
        "created_by": admin["username"],
    }
    await db.reward_payouts.insert_one(row.copy())
    await _audit(admin, "attendance_payout", driver_id, {"month": att["month"], "amount": row["amount"]})
    return {"ok": True, "paid": row["amount"], "attendance": await _attendance_state(driver)}


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
    admin: Dict = Depends(fleet_admin),
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
async def admin_get_booking(booking_id: str, admin: Dict = Depends(fleet_admin)):
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


@api.get("/money/yesterday")
async def money_yesterday(driver: Dict = Depends(get_driver)):
    """Previous-day settlement — the figure Ride91 settles on. Yesterday's
    settled platform gross, the driver's share of it, the cash they collected
    vs what they deposited, plus the running balance they owe overall."""
    today_bd = business_date_now()
    today_d = datetime.strptime(today_bd, "%Y-%m-%d").date()
    y_bd = (today_d - timedelta(days=1)).strftime("%Y-%m-%d")
    rows = await _fetch_platform_cash(driver["id"], y_bd, today_bd)
    rate = get_setting("driver_share", DRIVER_SHARE)
    per_platform = {p: {"gross": 0.0, "cash": 0.0, "status": "pending"} for p in PLATFORMS}
    gross = cash = 0.0
    settled = False
    for r in rows:
        g = float(r.get("gross_amount", r.get("cash_amount", 0)) or 0)
        c = float(r.get("cash_amount", 0) or 0)
        gross += g
        cash += c
        p = r.get("platform")
        if p in per_platform:
            per_platform[p]["gross"] += g
            per_platform[p]["cash"] += c
            per_platform[p]["status"] = r.get("status", "pending")
        if r.get("status") == "settled":
            settled = True
    # Deposits attributed to yesterday's business day (trusted sources only).
    deposited = 0.0
    async for r in db.qr_payments.aggregate([
        {"$match": {"driver_id": driver["id"], "type": "deposit",
                    "source": {"$in": sorted(TRUSTED_CASH_SOURCES)},
                    "business_date": y_bd}},
        {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
    ]):
        deposited = float(r.get("total") or 0)
    balance = await _driver_balance(driver["id"])
    return {
        "business_date": y_bd,
        "settled": settled,
        "gross": round(gross, 2),
        "cash_collected": round(cash, 2),
        "deposited": round(deposited, 2),
        "net_cash_from_day": round(cash - deposited, 2),
        "share_rate": rate,
        "driver_share": round(gross * rate, 2),
        "per_platform": {
            p: {"gross": round(v["gross"], 2), "cash": round(v["cash"], 2), "status": v["status"]}
            for p, v in per_platform.items()
        },
        "you_owe": balance.get("you_owe", 0.0),
        "in_credit": balance.get("in_credit", 0.0),
        "balance": balance.get("balance", 0.0),
        "cash_limit": balance.get("cash_limit", get_setting("cash_limit", CASH_LIMIT)),
        "cash_over_limit": balance.get("over_limit", False),
    }


@api.get("/money/earnings")
async def money_earnings(period: str = "yesterday", driver: Dict = Depends(get_driver)):
    """Driver's earnings (their share of gross) for a period: yesterday, this
    week (Mon-to-date), or this month (to date). Powers the earnings-card
    period selector."""
    rate = get_setting("driver_share", DRIVER_SHARE)
    today_bd = business_date_now()
    today_d = datetime.strptime(today_bd, "%Y-%m-%d").date()
    tomorrow_bd = (today_d + timedelta(days=1)).strftime("%Y-%m-%d")
    if period == "week":
        mon_bd, _next, _d = week_bounds_for_business_date(today_bd)
        start, end, label = mon_bd, tomorrow_bd, "This week"
    elif period == "month":
        start, end, label = today_bd[:7] + "-01", tomorrow_bd, "This month"
    else:
        period = "yesterday"
        y_bd = (today_d - timedelta(days=1)).strftime("%Y-%m-%d")
        start, end, label = y_bd, today_bd, "Yesterday"
    rows = await _fetch_platform_cash(driver["id"], start, end)
    gross = 0.0
    days: set = set()
    per_platform = {p: 0.0 for p in PLATFORMS}
    for r in rows:
        g = float(r.get("gross_amount", r.get("cash_amount", 0)) or 0)
        gross += g
        if g > 0:
            days.add(r.get("business_date"))
        p = r.get("platform")
        if p in per_platform:
            per_platform[p] += g
    return {
        "period": period, "label": label, "start": start,
        "gross": round(gross, 2),
        "driver_share": round(gross * rate, 2),
        "share_rate": rate,
        "days_operated": len(days),
        "per_platform": {p: round(v, 2) for p, v in per_platform.items()},
    }


# (Reward thresholds + loyalty/yearly constants live near the top of the file,
# above SETTINGS_DEFAULTS, so they can be overridden from the settings doc.)


def _tenure_days(driver: Dict) -> Optional[int]:
    """Whole days since the driver joined (created_at). None if unknown."""
    raw = driver.get("joined_at") or driver.get("created_at")
    if not raw:
        return None
    try:
        joined = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    return max(0, (now_utc() - joined).days)


def _loyalty_state(driver: Dict, cumulative_gross: float) -> Dict[str, Any]:
    """A driver's loyalty standing, keyed on CUMULATIVE GROSS EARNINGS: each
    milestone pays when total gross crosses its ₹ threshold. A milestone vests
    only while the driver is active — leaving forfeits the rest."""
    milestones_cfg = sorted(get_setting("loyalty_milestones"), key=lambda m: m.get("amount", 0))
    active = driver.get("active", True) and not driver.get("archived")
    g = float(cumulative_gross or 0)
    ms: List[Dict[str, Any]] = []
    vested_total = 0
    nxt = None
    for m in milestones_cfg:
        amount = float(m.get("amount", 0))
        reward = m.get("reward", 0)
        reached = amount > 0 and g >= amount
        vested = reached and active            # forfeit-if-you-leave
        if vested:
            vested_total += reward
        if not reached and nxt is None and amount > 0:
            nxt = {
                "key": m["key"], "label": m["label"], "reward": reward,
                "amount": amount, "remaining": round(amount - g, 2),
                "progress": round(min(1.0, g / amount), 4),
            }
        ms.append({
            "key": m["key"], "label": m["label"], "reward": reward,
            "amount": amount, "reached": reached, "vested": vested,
            "forfeited": reached and not active,
        })
    return {
        "tenure_days": _tenure_days(driver),   # kept for display only
        "gross": round(g, 2),
        "active": active,
        "milestones": ms,
        "next": nxt,
        "vested_total": vested_total,
    }


async def _cumulative_gross(start_date: str) -> Dict[str, float]:
    """Per-driver cumulative gross from start_date onward (loyalty earnings)."""
    out: Dict[str, float] = {}
    async for r in db.platform_cash.aggregate([
        {"$match": {"business_date": {"$gte": start_date}}},
        {"$group": {"_id": "$driver_id", "g": {"$sum": {"$ifNull": ["$gross_amount", "$cash_amount"]}}}},
    ]):
        out[r["_id"]] = float(r.get("g") or 0)
    return out


async def _driver_cumulative_gross(driver_id: str, start_date: str) -> float:
    async for r in db.platform_cash.aggregate([
        {"$match": {"driver_id": driver_id, "business_date": {"$gte": start_date}}},
        {"$group": {"_id": None, "g": {"$sum": {"$ifNull": ["$gross_amount", "$cash_amount"]}}}},
    ]):
        return float(r.get("g") or 0)
    return 0.0


def _year_bounds(today_bd: str) -> Tuple[str, str, str]:
    """(year_start_bd, next_year_start_bd, year_label) for the business date's
    calendar year, e.g. ('2026-01-01', '2027-01-01', '2026')."""
    y = int(today_bd[:4])
    return f"{y}-01-01", f"{y + 1}-01-01", str(y)


async def _yearly_gross(year_start: str, next_year: str) -> Dict[str, float]:
    """Per-driver cumulative gross across the calendar year to date."""
    out: Dict[str, float] = {}
    async for r in db.platform_cash.aggregate([
        {"$match": {"business_date": {"$gte": year_start, "$lt": next_year}}},
        {"$group": {"_id": "$driver_id", "g": {"$sum": {"$ifNull": ["$gross_amount", "$cash_amount"]}}}},
    ]):
        out[r["_id"]] = float(r.get("g") or 0)
    return out


async def _loyalty_wallet_qualifying_days(driver_id: str, start_date: str, min_gross: float) -> int:
    """Count business days (from start_date onward) where the driver's gross met
    the minimum — these are the days that accrue into the loyalty wallet."""
    pipeline = [
        {"$match": {"driver_id": driver_id, "business_date": {"$gte": start_date}}},
        {"$group": {"_id": "$business_date", "g": {"$sum": {"$ifNull": ["$gross_amount", "$cash_amount"]}}}},
        {"$match": {"g": {"$gte": min_gross}}},
        {"$count": "days"},
    ]
    async for r in db.platform_cash.aggregate(pipeline):
        return int(r.get("days") or 0)
    return 0


async def _loyalty_wallet(driver: Dict, cumulative_gross: float = 0.0) -> Dict[str, Any]:
    """A driver's loyalty-wallet standing. The wallet holds BOTH halves of
    loyalty: a per-qualifying-day accrual PLUS the earnings-milestone bonuses
    credited when cumulative gross crosses each threshold. Minus what ops has
    paid out, forfeited once the driver leaves. All parameters are live."""
    enabled = bool(get_setting("loyalty_wallet_enabled"))
    per_day = int(get_setting("loyalty_wallet_per_day") or 0)
    min_gross = float(get_setting("loyalty_wallet_min_gross") or 0)
    start_date = get_setting("loyalty_wallet_start_date") or "2000-01-01"
    active = driver.get("active", True) and not driver.get("archived")
    if not enabled:
        return {"enabled": False, "balance": 0, "accrued": 0, "paid": 0,
                "qualifying_days": 0, "per_day": per_day, "daily_accrued": 0,
                "milestone_credit": 0, "forfeited": 0, "active": active}
    days = await _loyalty_wallet_qualifying_days(driver["id"], start_date, min_gross)
    daily_accrued = days * per_day
    # Milestone bonuses already reached (cumulative gross >= threshold) land in
    # the wallet too.
    g = float(cumulative_gross or 0)
    milestone_credit = sum(
        int(m.get("reward", 0))
        for m in get_setting("loyalty_milestones")
        if float(m.get("amount", 0)) > 0 and g >= float(m["amount"])
    )
    accrued = daily_accrued + milestone_credit
    paid = 0.0
    async for r in db.reward_payouts.aggregate([
        {"$match": {"driver_id": driver["id"], "type": "loyalty_wallet"}},
        {"$group": {"_id": None, "s": {"$sum": "$amount"}}},
    ]):
        paid = float(r.get("s") or 0)
    unpaid = max(0.0, accrued - paid)
    # A driver who has left forfeits the un-paid balance — it's no longer payable.
    return {
        "enabled": True,
        "per_day": per_day,
        "qualifying_days": days,
        "daily_accrued": round(daily_accrued, 2),
        "milestone_credit": round(milestone_credit, 2),
        "accrued": round(accrued, 2),
        "paid": round(paid, 2),
        "balance": round(0.0 if not active else unpaid, 2),   # payable now
        "forfeited": round(unpaid if not active else 0.0, 2),  # lost by leaving
        "active": active,
    }


def _month_start_bd(today_bd: str) -> str:
    return today_bd[:7] + "-01"


async def _attendance_state(driver: Dict) -> Dict[str, Any]:
    """Attendance & monthly-target standing for the current calendar month. A
    'good day' = daily gross >= target AND (if required) the driver started duty
    on time vs their own scheduled shift start + grace. The monthly bonus pays
    when good days (and optional monthly gross) clear the floor."""
    enabled = bool(get_setting("attendance_enabled"))
    daily_target = float(get_setting("attendance_daily_target") or 0)
    require_ontime = bool(get_setting("attendance_require_ontime"))
    grace_min = int(get_setting("attendance_grace_minutes") or 0)
    min_days = int(get_setting("attendance_monthly_min_days") or 0)
    min_gross = float(get_setting("attendance_monthly_min_gross") or 0)
    bonus = int(get_setting("attendance_monthly_bonus") or 0)
    active = driver.get("active", True) and not driver.get("archived")
    today_bd = business_date_now()
    month_start = _month_start_bd(today_bd)
    month = today_bd[:7]
    # What the driver's card needs to explain the rules in plain words: their
    # own hub-set shift time, the grace allowed, and how many days (today
    # included) are still left to earn counted days this month.
    _td = datetime.strptime(today_bd, "%Y-%m-%d").date()
    explain = {
        "grace_minutes": grace_min,
        "shift_start_time": driver.get("shift_start_time") or None,
        "days_left": calendar.monthrange(_td.year, _td.month)[1] - _td.day + 1,
    }
    if not enabled:
        return {"enabled": False, "month": month, "good_days": 0, "min_days": min_days,
                "month_gross": 0, "min_gross": min_gross, "bonus": bonus, "qualified": False,
                "require_ontime": require_ontime, "daily_target": daily_target, "active": active,
                "paid": False, **explain}

    did = driver["id"]
    # Daily gross for the month.
    daily_gross: Dict[str, float] = {}
    async for r in db.platform_cash.aggregate([
        {"$match": {"driver_id": did, "business_date": {"$gte": month_start, "$lte": today_bd}}},
        {"$group": {"_id": "$business_date", "g": {"$sum": {"$ifNull": ["$gross_amount", "$cash_amount"]}}}},
    ]):
        daily_gross[r["_id"]] = float(r.get("g") or 0)

    # Earliest start_duty per business day.
    first_start: Dict[str, datetime] = {}
    async for r in db.duty_states.find(
        {"driver_id": did, "state": "start_duty", "business_date": {"$gte": month_start, "$lte": today_bd}},
        {"_id": 0, "business_date": 1, "started_at": 1, "synced_at": 1},
    ):
        bd = r.get("business_date")
        raw = r.get("started_at") or r.get("synced_at")
        if not bd or not raw:
            continue
        try:
            ts = _parse_iso(raw)
        except Exception:
            continue
        if bd not in first_start or ts < first_start[bd]:
            first_start[bd] = ts

    # Scheduled shift start per business day (from the shift-alarm system).
    scheduled: Dict[str, datetime] = {}
    shift_time = driver.get("shift_start_time")   # HH:MM, ops-set per driver
    if require_ontime and shift_time:
        # Build the scheduled start for each day from the driver's own time.
        try:
            hh, mm = (int(x) for x in str(shift_time).split(":")[:2])
        except Exception:
            hh, mm = -1, 0
        if 0 <= hh <= 23 and 0 <= mm <= 59:
            for bd in daily_gross:
                d0 = datetime.strptime(bd, "%Y-%m-%d").date()
                # Before 04:00 IST belongs to the next calendar day of the business day.
                cal = d0 + timedelta(days=1) if hh < 4 else d0
                scheduled[bd] = datetime(cal.year, cal.month, cal.day, hh, mm, tzinfo=IST)
    elif require_ontime:
        # Fallback: the shift-alarm schedules the driver app created.
        async for r in db.shift_schedules.find(
            {"driver_id": did}, {"_id": 0, "shift_start": 1}
        ):
            raw = r.get("shift_start")
            if not raw:
                continue
            try:
                ts = _parse_iso(raw)
            except Exception:
                continue
            bd = business_date_from_dt(ts)
            if bd not in scheduled or ts < scheduled[bd]:
                scheduled[bd] = ts

    good_days = 0
    month_gross = 0.0
    for bd, g in daily_gross.items():
        month_gross += g
        if g < daily_target:
            continue
        if require_ontime:
            sched = scheduled.get(bd)
            started = first_start.get(bd)
            if not sched or not started:
                continue   # can't confirm punctuality → not a good day
            if started > sched + timedelta(minutes=grace_min):
                continue   # logged in late
        good_days += 1

    qualified = (good_days >= min_days) and (min_gross <= 0 or month_gross >= min_gross)
    paid = await db.reward_payouts.find_one(
        {"driver_id": did, "type": "attendance", "month": month}, {"_id": 1}) is not None
    return {
        "enabled": True, "month": month,
        "good_days": good_days, "min_days": min_days,
        "month_gross": round(month_gross, 2), "min_gross": min_gross,
        "bonus": bonus, "qualified": qualified and active,
        "require_ontime": require_ontime, "daily_target": daily_target,
        "active": active, "paid": paid, **explain,
    }


@api.get("/money/rewards")
async def money_rewards(driver: Dict = Depends(get_driver)):
    """Progress toward the weekly reward system. Rewards are additional to the
    driver's 30% share; this only reports how close the driver is to each
    qualifying threshold — the actual top-car / top-driver winner is decided by
    ops across the hub."""
    (REWARD_DAILY_TARGET, REWARD_TOP_CAR_DAY, REWARD_WEEK_CAR_TARGET,
     REWARD_TOP_CAR_WEEK, REWARD_WEEK_DRIVER_TARGET, REWARD_TOP_DRIVER_WEEK,
     REWARD_DAYS_REQUIRED) = _weekly_reward_cfg()
    today_bd = business_date_now()
    today_d = datetime.strptime(today_bd, "%Y-%m-%d").date()
    y_bd = (today_d - timedelta(days=1)).strftime("%Y-%m-%d")
    mon_bd, next_mon_bd, days_remaining = week_bounds_for_business_date(today_bd)
    rate = get_setting("driver_share", DRIVER_SHARE)

    def _gross(r):
        return float(r.get("gross_amount", r.get("cash_amount", 0)) or 0)

    async def _one(did: str):
        yr = await _fetch_platform_cash(did, y_bd, today_bd)
        wr = await _fetch_platform_cash(did, mon_bd, next_mon_bd)
        days = {r["business_date"] for r in wr if _gross(r) > 0}
        return round(sum(_gross(r) for r in yr), 2), round(sum(_gross(r) for r in wr), 2), days

    # This driver's own numbers → the Top-Driver tier (on gross, not the take).
    driver_y, driver_week, driver_days = await _one(driver["id"])

    # The car's combined numbers → the Top-Car tiers (day + night shift drivers).
    car_y, car_week, car_days = driver_y, driver_week, set(driver_days)
    if driver.get("vehicle_id"):
        async for p in db.drivers.find(
            {"vehicle_id": driver.get("vehicle_id"), "id": {"$ne": driver["id"]}, "archived": {"$ne": True}},
            {"_id": 0, "id": 1},
        ):
            py, pw, pd = await _one(p["id"])
            car_y += py
            car_week += pw
            car_days |= pd
    car_days_n = len(car_days)

    def pct(x: float, target: float) -> float:
        return round(min(1.0, x / target), 4) if target else 0.0

    return {
        "week_start": mon_bd,
        "days_operated": car_days_n,          # the car's operated days (any shift)
        "days_required": REWARD_DAYS_REQUIRED,
        "share_rate": rate,
        "daily": {
            "label": "Top car of the day",
            "target": REWARD_DAILY_TARGET,
            "value": round(car_y, 2),
            "qualified": car_y >= REWARD_DAILY_TARGET,
            "progress": pct(car_y, REWARD_DAILY_TARGET),
            "reward": REWARD_TOP_CAR_DAY,
        },
        "top_car_week": {
            "label": "Top car of the week",
            "target": REWARD_WEEK_CAR_TARGET,
            "value": round(car_week, 2),
            "all_days": car_days_n >= REWARD_DAYS_REQUIRED,
            "qualified": car_week >= REWARD_WEEK_CAR_TARGET and car_days_n >= REWARD_DAYS_REQUIRED,
            "progress": pct(car_week, REWARD_WEEK_CAR_TARGET),
            "reward": REWARD_TOP_CAR_WEEK,
        },
        "top_driver_week": {
            "label": "Top driver of the week",
            "target": REWARD_WEEK_DRIVER_TARGET,
            "value": round(driver_week, 2),
            "qualified": driver_week >= REWARD_WEEK_DRIVER_TARGET,
            "progress": pct(driver_week, REWARD_WEEK_DRIVER_TARGET),
            "reward": REWARD_TOP_DRIVER_WEEK,
        },
    }


@api.get("/money/loyalty")
async def money_loyalty(driver: Dict = Depends(get_driver)):
    """The driver's loyalty (tenure) standing plus where they sit in this
    year's hub race. Loyalty vests only while active — leaving forfeits what
    hasn't been reached yet. Yearly winners are decided per hub by ops."""
    YEARLY_TOP_DRIVER = get_setting("yearly_top_driver")
    loyalty_start = get_setting("loyalty_wallet_start_date") or "2000-01-01"
    cum_gross = await _driver_cumulative_gross(driver["id"], loyalty_start)
    loyalty = _loyalty_state(driver, cum_gross)
    wallet = await _loyalty_wallet(driver, cum_gross)
    attendance = await _attendance_state(driver)

    today_bd = business_date_now()
    year_start, next_year, year_label = _year_bounds(today_bd)
    ygross = await _yearly_gross(year_start, next_year)
    my_year = round(ygross.get(driver["id"], 0.0), 2)

    # Rank within the driver's hub (by year gross) so they see how close #1 is.
    hub_id = driver.get("hub_id")
    peers = []
    if hub_id:
        vids = {v["id"] async for v in db.vehicles.find({"hub_id": hub_id}, {"_id": 0, "id": 1})}
        async for d in db.drivers.find(
            {"archived": {"$ne": True}}, {"_id": 0, "id": 1, "hub_id": 1, "vehicle_id": 1}
        ):
            if d.get("hub_id") == hub_id or d.get("vehicle_id") in vids:
                peers.append(ygross.get(d["id"], 0.0))
    peers_sorted = sorted(peers, reverse=True)
    rank = (peers_sorted.index(my_year) + 1) if my_year in peers_sorted else None
    leader = peers_sorted[0] if peers_sorted else my_year

    return {
        "year": year_label,
        "loyalty": loyalty,
        "wallet": wallet,
        "attendance": attendance,
        "yearly": {
            "label": "Top driver of the year",
            "value": my_year,
            "hub_leader": round(leader, 2),
            "rank": rank,
            "of": len(peers_sorted),
            "gap_to_leader": round(max(0.0, leader - my_year), 2),
            "reward": YEARLY_TOP_DRIVER,
        },
    }


@api.get("/money/collection-qr")
async def money_collection_qr(driver: Dict = Depends(get_driver)):
    """The driver's own collection QR, to show riders for payment. Created on
    first open (which also assigns their R91D code). Degrades gracefully if
    Razorpay isn't configured."""
    row = await db.driver_collection_qrs.find_one({"driver_id": driver["id"]}, {"_id": 0})
    if not row and _razorpay_configured():
        try:
            row = await _get_or_create_collection_qr(driver)
        except HTTPException:
            row = None
    code = driver.get("code")
    if not code:
        d = await db.drivers.find_one({"id": driver["id"]}, {"_id": 0, "code": 1})
        code = (d or {}).get("code")
    return {
        "qr_code_id": (row or {}).get("qr_code_id"),
        "image_url": (row or {}).get("image_url"),
        "short_url": (row or {}).get("short_url"),
        "code": code,
        "enabled": _razorpay_configured(),
    }


@api.get("/money/collections/today")
async def money_collections_today(driver: Dict = Depends(get_driver)):
    """Today's QR collections for this driver — running total, count, and the
    most recent payments. The app polls this so each completed rider payment
    shows up live."""
    today_bd = business_date_now()
    total = 0.0
    count = 0
    items: List[Dict[str, Any]] = []
    async for r in db.collections.find(
        {"driver_id": driver["id"], "business_date": today_bd},
        {"_id": 0, "amount": 1, "occurred_at": 1},
    ).sort("occurred_at", -1).limit(50):
        amt = float(r.get("amount") or 0)
        total += amt
        count += 1
        items.append({"amount": round(amt, 2), "at": r.get("occurred_at")})
    return {
        "business_date": today_bd,
        "total": round(total, 2),
        "count": count,
        "items": items,
    }


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


# Live credentials: a value saved in the settings doc (owner-editable from the
# admin) wins over the environment variable, so keys can be rotated without a
# redeploy. The secret values are never read back out through the API.
def _rzp_key_id() -> str:
    return get_setting("razorpay_key_id") or RAZORPAY_KEY_ID


def _rzp_key_secret() -> str:
    return get_setting("razorpay_key_secret") or RAZORPAY_KEY_SECRET


def _rzp_webhook_secret() -> str:
    return get_setting("razorpay_webhook_secret") or RAZORPAY_WEBHOOK_SECRET


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
    return bool(_rzp_key_id() and _rzp_key_secret())


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
            auth=(_rzp_key_id(), _rzp_key_secret()),
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
        "key_id": _rzp_key_id() if _razorpay_configured() else None,
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
            "key_id": _rzp_key_id(),
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
        "key_id": _rzp_key_id(),
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
        _rzp_key_secret().encode(), msg, hashlib.sha256
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


# ---------------------------------------------------------------------------
# DEPOSIT LINK — the driver hands in the collection cash they are holding by
# paying a Razorpay payment link. The app asks for a link for what the driver
# owes, opens it, and watches for the payment. A paid link becomes a trusted
# "deposit" row, exactly like the other Razorpay deposit paths, so "You owe"
# drops as soon as the payment is seen.
#
# A payment is seen three ways, whichever comes first: the payment_link.paid
# webhook, the payment.captured webhook (the link's notes ride on the payment),
# or the app asking for the link's status, which checks Razorpay directly. So
# the balance still updates if a webhook is late or was never switched on.
# ---------------------------------------------------------------------------
DEPOSIT_LINK_TTL_MINUTES = 30        # Razorpay needs expire_by at least 15 minutes ahead
DEPOSIT_LINK_RECHECK_SECONDS = 4     # how often one link may be checked against Razorpay


class DepositLinkIn(BaseModel):
    client_action_id: str
    # Leave out to pay everything owed. Never more than is owed.
    amount_rupees: Optional[float] = Field(default=None, gt=0)


def _deposit_link_out(rec: Dict) -> Dict[str, Any]:
    status = rec["status"]
    if status == "created" and int(now_utc().timestamp()) > int(rec.get("expire_by") or 0):
        status = "expired"
    return {
        "client_action_id": rec["client_action_id"],
        "status": status,                              # created | paid | expired | cancelled
        "short_url": rec.get("short_url"),
        "amount": round(int(rec["amount_paise"]) / 100, 2),
        "amount_received": round(int(rec.get("amount_received_paise") or 0) / 100, 2),
        "expire_by": rec.get("expire_by"),
        "paid_at": rec.get("paid_at"),
    }


async def _reconcile_deposit_link_once(
    link_id: str, razorpay_payment_id: Optional[str], amount_paise: int
) -> None:
    """Mark a deposit link paid and write its deposit row. Only the first call
    for a link does anything, so the webhooks and the status check can all
    report the same payment safely."""
    r = await db.deposit_links.find_one_and_update(
        {"link_id": link_id, "status": {"$ne": "paid"}},
        {"$set": {
            "status": "paid",
            "razorpay_payment_id": razorpay_payment_id,
            "amount_received_paise": int(amount_paise),
            "paid_at": iso(now_utc()),
        }},
        return_document=False,
    )
    if not r:
        return  # unknown or already paid — safe no-op
    await db.qr_payments.update_one(
        {"driver_id": r["driver_id"], "client_action_id": r["client_action_id"]},
        {"$setOnInsert": {
            "id": str(uuid.uuid4()),
            "driver_id": r["driver_id"],
            "type": "deposit",
            "amount": round(int(amount_paise) / 100, 2),
            "reference": link_id,
            "platform": None,
            "occurred_at": iso(now_utc()),
            "business_date": business_date_now(),
            "source": "razorpay",
            "razorpay_payment_link_id": link_id,
            "razorpay_payment_id": razorpay_payment_id,
            "client_action_id": r["client_action_id"],
            "created_at": iso(now_utc()),
        }},
        upsert=True,
    )


async def _refresh_deposit_link(rec: Dict) -> Dict:
    """Bring one unpaid link up to date with Razorpay and return the stored
    row. Rate-limited per link; a Razorpay hiccup just leaves the row as it is."""
    if rec["status"] != "created":
        return rec
    recheck_before = iso(now_utc() - timedelta(seconds=DEPOSIT_LINK_RECHECK_SECONDS))
    claimed = await db.deposit_links.update_one(
        {"link_id": rec["link_id"], "status": "created",
         "$or": [{"checked_at": None}, {"checked_at": {"$lt": recheck_before}}]},
        {"$set": {"checked_at": iso(now_utc())}},
    )
    if claimed.modified_count != 1:
        return rec
    try:
        pl = await _rzp_request("GET", f"/payment_links/{rec['link_id']}")
    except HTTPException:
        return rec
    st = pl.get("status")
    if st == "paid":
        pays = pl.get("payments") or []
        await _reconcile_deposit_link_once(
            rec["link_id"],
            (pays[0] or {}).get("payment_id") if pays else None,
            int(pl.get("amount_paid") or rec["amount_paise"]),
        )
    elif st in ("cancelled", "expired"):
        await db.deposit_links.update_one(
            {"link_id": rec["link_id"], "status": "created"}, {"$set": {"status": st}})
    return await db.deposit_links.find_one({"link_id": rec["link_id"]}, {"_id": 0}) or rec


@api.post("/money/deposit-link")
async def create_deposit_link(body: DepositLinkIn, driver: Dict = Depends(get_driver)):
    """A Razorpay payment link for the collection cash the driver owes. The
    amount is the server's figure for what is owed (or less, if the driver
    asks for less) — never the client's word for it."""
    if not _razorpay_configured():
        raise HTTPException(503, "razorpay_not_configured")
    did = driver["id"]
    existing = await db.deposit_links.find_one(
        {"driver_id": did, "client_action_id": body.client_action_id}, {"_id": 0})
    if existing:
        return _deposit_link_out(existing)
    dues_paise = await _driver_dues_paise(did)
    if dues_paise < 100:
        raise HTTPException(409, "no_dues")
    amount_paise = dues_paise
    if body.amount_rupees is not None:
        req = int(round(float(body.amount_rupees) * 100))
        if req < 100:
            raise HTTPException(400, "amount_below_minimum")
        amount_paise = min(req, dues_paise)

    now_ts = int(now_utc().timestamp())
    # Links still open from earlier taps. One that was in fact paid is settled
    # here first; one for this same amount with time left is handed back; the
    # rest are cancelled, so there is never a second link that could be paid
    # on top of this one.
    async for old in db.deposit_links.find({"driver_id": did, "status": "created"}, {"_id": 0}):
        old = await _refresh_deposit_link(old)
        if old["status"] == "paid":
            raise HTTPException(409, "just_paid")
        if old["status"] != "created":
            continue
        if old["amount_paise"] == amount_paise and int(old.get("expire_by") or 0) > now_ts + 300:
            return _deposit_link_out(old)
        try:
            await _rzp_request("POST", f"/payment_links/{old['link_id']}/cancel")
        except HTTPException:
            pass    # already expired or paid at Razorpay; the status check sorts it out
        await db.deposit_links.update_one(
            {"link_id": old["link_id"], "status": "created"}, {"$set": {"status": "cancelled"}})

    expire_by = now_ts + DEPOSIT_LINK_TTL_MINUTES * 60
    name = (driver.get("name") or "Ride91 driver").strip()
    customer: Dict[str, Any] = {"name": name[:50]}
    phone = str(driver.get("phone") or "")
    if len(phone) == 10 and phone.isdigit():
        customer["contact"] = "+91" + phone
    pl = await _rzp_request(
        "POST", "/payment_links",
        json={
            "amount": amount_paise,
            "currency": "INR",
            "accept_partial": False,
            "expire_by": expire_by,
            "reference_id": body.client_action_id[:40],
            "description": f"Ride91 cash deposit - {name}"[:120],
            "customer": customer,
            "notify": {"sms": False, "email": False},
            "reminder_enable": False,
            "notes": {
                "driver_id": did,
                "client_action_id": body.client_action_id,
                "purpose": "deposit_link",
            },
        },
    )
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": did,
        "client_action_id": body.client_action_id,
        "link_id": pl["id"],
        "short_url": pl.get("short_url"),
        "amount_paise": amount_paise,
        "status": "created",
        "expire_by": expire_by,
        "checked_at": None,
        "created_at": iso(now_utc()),
    }
    await db.deposit_links.insert_one(row.copy())
    return _deposit_link_out(row)


@api.get("/money/deposit-link")
async def current_deposit_link(driver: Dict = Depends(get_driver)):
    """The driver's most recent deposit link, checked against Razorpay if it
    is still unpaid. The app polls this while a link is open, and calls it on
    opening the Earnings tab to pick up a payment made while it was closed."""
    rec = await db.deposit_links.find_one(
        {"driver_id": driver["id"]}, {"_id": 0}, sort=[("created_at", -1)])
    if not rec:
        return {"link": None}
    rec = await _refresh_deposit_link(rec)
    return {"link": _deposit_link_out(rec)}


# ---------------------------------------------------------------------------
# COLLECTION QR — a permanent, reusable UPI QR per driver. The RIDER scans it
# and pays the fare; money lands in the fleet's Razorpay account, tagged with
# the driver_id (notes.purpose = "collection"). This is tracked money only: it
# is recorded in its own `collections` ledger and deliberately does NOT touch
# the driver's cash-in-hand, dues, gross, or rewards.
# ---------------------------------------------------------------------------
async def _reconcile_collection_once(
    driver_id: str, qr_code_id: str, razorpay_payment_id: str, amount_paise: int
) -> None:
    """Record one rider payment on a driver's collection QR, and credit it
    against the driver's cash-in-hand — the money was a cash Uber trip paid to
    the fleet instead of to the driver. Both writes are idempotent on the
    razorpay_payment_id so a replayed webhook never double-counts."""
    amount = round(int(amount_paise) / 100, 2)
    now = iso(now_utc())
    bd = business_date_now()
    await db.collections.update_one(
        {"razorpay_payment_id": razorpay_payment_id},
        {"$setOnInsert": {
            "id": str(uuid.uuid4()),
            "driver_id": driver_id,
            "amount": amount,
            "qr_code_id": qr_code_id,
            "razorpay_payment_id": razorpay_payment_id,
            "occurred_at": now,
            "business_date": bd,
            "created_at": now,
        }},
        upsert=True,
    )
    # Settle the driver's cash-in-hand: a trusted "deposit" the fleet received on
    # their behalf. Keyed on (driver_id, client_action_id) — the qr_payments
    # unique index — so it's written exactly once.
    await db.qr_payments.update_one(
        {"driver_id": driver_id, "client_action_id": f"qrcol:{razorpay_payment_id}"},
        {"$setOnInsert": {
            "id": str(uuid.uuid4()),
            "driver_id": driver_id,
            "type": "deposit",
            "amount": amount,
            "reference": qr_code_id,
            "platform": None,
            "occurred_at": now,
            "business_date": bd,
            "source": "qr_collection",
            "razorpay_qr_code_id": qr_code_id,
            "razorpay_payment_id": razorpay_payment_id,
            "client_action_id": f"qrcol:{razorpay_payment_id}",
            "created_at": now,
        }},
        upsert=True,
    )


# Driver codes: R91D-<4-digit running number>-<CITY>, e.g. R91D-0106-PNQ. One
# global sequence across cities; the city comes from the driver's hub.
CITY_CODES = {"ahmedabad": "AMD", "amdavad": "AMD", "pune": "PNQ"}


def _city_code_from_text(txt: Optional[str]) -> Optional[str]:
    t = (txt or "").lower()
    for key, code in CITY_CODES.items():
        if key in t:
            return code
    return None


async def _driver_city_code(driver: Dict) -> str:
    """City code (AMD/PNQ) from the driver's hub; 'XXX' if it can't be told."""
    hub = None
    if driver.get("hub_id"):
        hub = await db.hubs.find_one({"id": driver["hub_id"]}, {"_id": 0, "city": 1, "name": 1})
    if hub:
        return (_city_code_from_text(hub.get("city"))
                or _city_code_from_text(hub.get("name")) or "XXX")
    return _city_code_from_text(driver.get("hub_name")) or "XXX"


async def _next_driver_seq() -> int:
    """Atomically take the next number in the global driver-code sequence."""
    doc = await db.counters.find_one_and_update(
        {"id": "driver_code"}, {"$inc": {"seq": 1}},
        upsert=True, return_document=True,
    )
    return int(doc["seq"])


async def _assign_driver_code(driver: Dict) -> str:
    """Return the driver's code, assigning the next one in the sequence if they
    don't have it yet (R91D-<seq>-<CITY>)."""
    if driver.get("code"):
        return driver["code"]
    city = await _driver_city_code(driver)
    n = await _next_driver_seq()
    code = f"R91D-{n:04d}-{city}"
    await db.drivers.update_one({"id": driver["id"]}, {"$set": {"code": code}})
    driver["code"] = code
    return code


async def _get_or_create_collection_qr(driver: Dict) -> Dict[str, Any]:
    """Return the driver's reusable collection QR, creating it on first use.
    The QR is named with the driver's code (R91D-####-CITY) to match the
    fleet's existing Razorpay naming."""
    existing = await db.driver_collection_qrs.find_one(
        {"driver_id": driver["id"]}, {"_id": 0}
    )
    if existing:
        return existing
    code = await _assign_driver_code(driver)
    label = f"{code} {driver.get('name') or ''}".strip()
    qr = await _rzp_request(
        "POST", "/payments/qr_codes",
        json={
            "type": "upi_qr",
            "name": code[:27],             # the QR's name = the driver code
            "usage": "multiple_use",       # reusable — one QR for the driver, forever
            "fixed_amount": False,         # rider enters the fare
            "description": label,
            "notes": {"driver_id": driver["id"], "code": code, "purpose": "collection"},
        },
    )
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": driver["id"],
        "qr_code_id": qr["id"],
        "image_url": qr.get("image_url"),
        "short_url": qr.get("short_url"),
        "status": "active",
        "created_at": iso(now_utc()),
        "created_by": None,
    }
    await db.driver_collection_qrs.insert_one(row.copy())
    row.pop("_id", None)
    return row


def _collection_qr_out(row: Optional[Dict], code: Optional[str] = None) -> Optional[Dict[str, Any]]:
    if not row:
        return None
    return {
        "qr_code_id": row.get("qr_code_id"),
        "image_url": row.get("image_url"),
        "short_url": row.get("short_url"),
        "status": row.get("status"),
        "created_at": row.get("created_at"),
        "code": code,
    }


@api.post("/admin/drivers/{driver_id}/collection-qr")
async def admin_create_collection_qr(driver_id: str, admin: Dict = Depends(require_write)):
    if not _razorpay_configured():
        raise HTTPException(503, "razorpay_not_configured")
    driver = await db.drivers.find_one(
        {"id": driver_id}, {"_id": 0, "id": 1, "name": 1, "hub_id": 1, "hub_name": 1, "code": 1})
    if not driver:
        raise HTTPException(404, "driver_not_found")
    row = await _get_or_create_collection_qr(driver)
    await _audit(admin, "create_collection_qr", driver_id, {"qr_code_id": row.get("qr_code_id")})
    return _collection_qr_out(row, driver.get("code"))


@api.get("/admin/drivers/{driver_id}/collection-qr")
async def admin_get_collection_qr(driver_id: str, admin: Dict = Depends(fleet_admin)):
    row = await db.driver_collection_qrs.find_one({"driver_id": driver_id}, {"_id": 0})
    d = await db.drivers.find_one({"id": driver_id}, {"_id": 0, "code": 1})
    return _collection_qr_out(row, (d or {}).get("code")) or {"qr_code_id": None, "code": (d or {}).get("code")}


@api.get("/admin/collections")
async def admin_collections(
    from_date: Optional[str] = None, to_date: Optional[str] = None,
    admin: Dict = Depends(fleet_admin),
):
    """Money collected via drivers' collection QRs: a per-driver total (plus
    count + last payment) and the fleet grand total, optionally filtered by a
    business-date range [from_date, to_date] inclusive."""
    match: Dict[str, Any] = {}
    if from_date or to_date:
        bd: Dict[str, Any] = {}
        if from_date:
            bd["$gte"] = from_date
        if to_date:
            bd["$lte"] = to_date
        match["business_date"] = bd

    per: Dict[str, Dict[str, Any]] = {}
    grand_total = 0.0
    grand_count = 0
    pipeline = [{"$match": match}] if match else []
    pipeline.append({"$group": {
        "_id": "$driver_id",
        "total": {"$sum": "$amount"},
        "count": {"$sum": 1},
        "last_at": {"$max": "$occurred_at"},
    }})
    async for r in db.collections.aggregate(pipeline):
        per[r["_id"]] = {"total": round(float(r.get("total") or 0), 2),
                         "count": r.get("count", 0), "last_at": r.get("last_at")}
        grand_total += float(r.get("total") or 0)
        grand_count += r.get("count", 0)

    # Attach driver names (hide archived unless they have collections).
    ids = list(per.keys())
    names = {d["id"]: d async for d in db.drivers.find(
        {"id": {"$in": ids}}, {"_id": 0, "id": 1, "name": 1, "phone": 1, "code": 1})} if ids else {}
    items = []
    for did, v in per.items():
        d = names.get(did, {})
        items.append({
            "driver_id": did, "name": d.get("name"), "phone": d.get("phone"), "code": d.get("code"),
            "total": v["total"], "count": v["count"], "last_at": v["last_at"],
        })
    items.sort(key=lambda x: x["total"], reverse=True)
    return {
        "items": items,
        "grand_total": round(grand_total, 2),
        "count": grand_count,
        "from_date": from_date, "to_date": to_date,
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
    # Only allow redirecting back into the app (ride91://) or our own https
    # origins — never an arbitrary attacker-supplied URL (open-redirect guard).
    # "https://ride91-" used to be accepted as a prefix, which also matched any
    # look-alike domain an attacker registers (https://ride91-anything.com).
    # An https address must now be one of our own origins, matched whole.
    own_https = any(
        redirect == o or redirect.startswith((o + "/", o + "#", o + "?"))
        for o in _cors_origins if o.startswith("https://"))
    if not (redirect.startswith("ride91://")
            or own_https
            or redirect.startswith("exp://")):   # Expo Go during dev
        redirect = "ride91://money"
    safe_redirect = html_lib.escape(redirect)
    safe_name = html_lib.escape(name)
    rzp_key = _rzp_key_id()
    verify_url = "/api/payments/razorpay/verify"
    page = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ride91 · Pay dues</title><style>body{{font-family:-apple-system,system-ui,sans-serif;background:#EEF1EC;color:#10231C;margin:0;padding:40px 24px;text-align:center}} .card{{max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;box-shadow:0 4px 20px rgba(16,35,28,.08)}} h1{{margin:0 0 8px}} .amt{{font-size:36px;font-weight:700;color:#0B7A4B;margin:16px 0}} button{{background:#0B7A4B;color:#fff;border:none;border-radius:8px;padding:14px 28px;font-size:16px;font-weight:600;cursor:pointer;width:100%}} .muted{{color:#67756D;font-size:13px;margin-top:16px}}</style></head><body><div class="card"><h1>Ride91 · Pay dues</h1><div class="amt">₹{amount/100:.2f}</div><button id="pay">Open Razorpay</button></div><script src="https://checkout.razorpay.com/v1/checkout.js"></script><script>const CFG={_json.dumps({"key":rzp_key,"order_id":safe_order,"amount":amount,"action":safe_action,"redirect":safe_redirect,"name":safe_name,"verify":verify_url})};function pay(){{const rzp=new Razorpay({{key:CFG.key,order_id:CFG.order_id,amount:CFG.amount,currency:"INR",name:CFG.name,description:"Driver dues",theme:{{color:"#0B7A4B"}},handler:async function(r){{await fetch(CFG.verify,{{method:"POST",headers:{{"Content-Type":"application/json"}},body:JSON.stringify({{client_action_id:CFG.action,razorpay_payment_id:r.razorpay_payment_id,razorpay_order_id:r.razorpay_order_id,razorpay_signature:r.razorpay_signature}})}}).catch(()=>{{}});location.href=CFG.redirect+"#status=paid&order_id="+encodeURIComponent(r.razorpay_order_id);}},modal:{{ondismiss:function(){{location.href=CFG.redirect+"#status=dismissed";}}}}}});rzp.open();}}document.getElementById("pay").onclick=pay;setTimeout(pay,300);</script></body></html>"""
    return Response(content=page, media_type="text/html")


@api.post("/webhooks/razorpay")
async def razorpay_webhook(req: Request):
    """Razorpay → us. Source of truth for payment state. Verify HMAC on
    the RAW body before parsing JSON. Dedup by event id."""
    raw = await req.body()
    got = req.headers.get("X-Razorpay-Signature", "")
    wh_secret = _rzp_webhook_secret()
    if not wh_secret:
        raise HTTPException(503, "webhook_not_configured")
    want = hmac.new(wh_secret.encode(), raw, hashlib.sha256).hexdigest()
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
        if notes.get("purpose") == "deposit_link":
            # A deposit link was paid; its notes ride on the payment.
            link = await db.deposit_links.find_one(
                {"driver_id": driver_id, "client_action_id": client_action_id}, {"_id": 0, "link_id": 1})
            if link and payment_id:
                await _reconcile_deposit_link_once(link["link_id"], payment_id, int(amount_paise))
        elif order_id and payment_id and client_action_id and driver_id:
            await _reconcile_razorpay_once(
                driver_id=driver_id,
                client_action_id=client_action_id,
                razorpay_order_id=order_id,
                razorpay_payment_id=payment_id,
                amount_paise=int(amount_paise),
            )
    elif kind == "payment_link.paid":
        payload = event.get("payload") or {}
        pl = (payload.get("payment_link") or {}).get("entity") or {}
        payment = (payload.get("payment") or {}).get("entity") or {}
        if pl.get("id"):
            await _reconcile_deposit_link_once(
                pl["id"], payment.get("id"),
                int(pl.get("amount_paid") or payment.get("amount") or 0))
    elif kind in ("payment_link.expired", "payment_link.cancelled"):
        pl = ((event.get("payload") or {}).get("payment_link") or {}).get("entity") or {}
        if pl.get("id"):
            await db.deposit_links.update_one(
                {"link_id": pl["id"], "status": "created"},
                {"$set": {"status": kind.split(".")[1]}})
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
            if notes.get("purpose") == "collection":
                # Rider paid a driver's collection QR — tracked money only.
                await _reconcile_collection_once(
                    driver_id=driver_id,
                    qr_code_id=qr_code_id,
                    razorpay_payment_id=payment_id,
                    amount_paise=int(amount_paise),
                )
            else:
                # Driver paid their dues via a single-use deposit QR.
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


# Admin Settings win over the env vars. The key pair falls back to the Razorpay
# one, but only as a pair, so a RazorpayX key ID is never matched with a
# Razorpay secret. The account number has no fallback: payouts stay off until
# someone enters it.
def _rzpx_own_keys() -> bool:
    return bool(get_setting("razorpayx_key_id") or RAZORPAYX_KEY_ID)


def _rzpx_key_id() -> str:
    return get_setting("razorpayx_key_id") or RAZORPAYX_KEY_ID or _rzp_key_id()


def _rzpx_key_secret() -> str:
    if _rzpx_own_keys():
        return get_setting("razorpayx_key_secret") or RAZORPAYX_KEY_SECRET
    return _rzp_key_secret()


def _rzpx_account_number() -> str:
    return get_setting("razorpayx_account_number") or RAZORPAYX_ACCOUNT_NUMBER


def _rzpx_webhook_secret() -> str:
    return get_setting("razorpayx_webhook_secret") or RAZORPAYX_WEBHOOK_SECRET


def _razorpayx_configured() -> bool:
    return bool(_rzpx_key_id() and _rzpx_key_secret() and _rzpx_account_number())


async def _rzpx_request(method: str, path: str, **kw) -> Dict[str, Any]:
    if not _razorpayx_configured():
        raise HTTPException(503, "razorpayx_not_configured")
    import httpx
    async with httpx.AsyncClient(timeout=20.0) as c:
        r = await c.request(
            method,
            RAZORPAYX_BASE + path,
            auth=(_rzpx_key_id(), _rzpx_key_secret()),
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
    # Sent to RazorpayX as the payout's idempotency key. Give the same key on a
    # retry and RazorpayX returns the first payout instead of sending a second.
    idempotency_key: Optional[str] = None


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
    idem = body.idempotency_key or str(uuid.uuid4())
    payload = {
        "account_number": _rzpx_account_number(),
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
    hub_id: Optional[str] = None,
    limit: int = 100,
    admin: Dict = Depends(fleet_admin),
):
    q: Dict[str, Any] = {}
    if driver_id:
        q["driver_id"] = driver_id
    else:
        target = _hub_target(admin, hub_id)
        if target:
            q["driver_id"] = {"$in": await _hub_driver_ids(target)}
    cursor = db.payouts.find(q, {"_id": 0}).sort("created_at", -1).limit(min(limit, 500))
    items = [p async for p in cursor]
    return {"items": items}


@api.get("/admin/payouts/{payout_id}/refresh")
async def admin_refresh_payout(
    payout_id: str, admin: Dict = Depends(fleet_admin)
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


# ---------- Salary cash-out ---------------------------------------------------
# A driver's salary is their share of settled gross. They withdraw it from the
# app. With direct withdrawal on (and RazorpayX set up, and a bank / UPI saved)
# the money is sent straight away. Otherwise the withdrawal waits as a request
# for the hub, which pays it (RazorpayX payout, or by hand) or rejects it.
#
#   earned    = share × settled gross, up to and including yesterday
#   paid      = payouts already sent + requests the hub marked paid by hand
#   pending   = requests waiting on the hub
#   cash owed = collection cash the driver still has to hand in ("You owe")
#   available = earned − paid − pending − cash owed        (never below 0)
#
# Cash owed is held back rather than deducted: the driver still pays it in the
# usual way, and the held-back salary is released as soon as they do. Nothing
# here ever writes to the cash ledger.

# A payout in one of these states did not (or will not) reach the driver.
PAYOUT_DEAD_STATES = {"failed", "reversed", "cancelled", "rejected"}


async def _salary_state(driver: Dict, exclude_withdrawal_id: Optional[str] = None) -> Dict[str, Any]:
    """The driver's salary position. `exclude_withdrawal_id` leaves one pending
    request out of `pending`, so paying that request can be checked against
    what is available without it counting against itself."""
    did = driver["id"]
    rate = get_setting("driver_share", DRIVER_SHARE)
    today_bd = business_date_now()

    gross = 0.0
    async for r in db.platform_cash.aggregate([
        {"$match": {"driver_id": did, "status": "settled", "business_date": {"$lt": today_bd}}},
        {"$group": {"_id": None, "g": {"$sum": {"$ifNull": ["$gross_amount", "$cash_amount"]}}}},
    ]):
        gross = float(r.get("g") or 0)
    earned = round(gross * rate, 2)

    paid = 0.0
    async for p in db.payouts.find({"driver_id": did}, {"_id": 0, "amount_rupees": 1, "status": 1}):
        if (p.get("status") or "") not in PAYOUT_DEAD_STATES:
            paid += float(p.get("amount_rupees") or 0)
    pending = 0.0
    async for w in db.salary_withdrawals.find(
        {"driver_id": did, "state": {"$in": ["pending", "paying", "paid"]}},
        {"_id": 0, "id": 1, "amount": 1, "state": 1, "method": 1},
    ):
        if w["state"] in ("pending", "paying"):
            if w["id"] != exclude_withdrawal_id:
                pending += float(w.get("amount") or 0)
        elif w.get("method") == "manual":
            # Paid by hand, so there is no payout row carrying this amount.
            paid += float(w.get("amount") or 0)

    cash_owed = float((await _driver_balance(did)).get("you_owe") or 0)
    held = cash_owed if get_setting("withdraw_hold_cash_owed") else 0.0
    available = max(0.0, round(earned - paid - pending - held, 2))
    return {
        "share_rate": rate,
        "gross": round(gross, 2),
        "earned": earned,
        "paid": round(paid, 2),
        "pending": round(pending, 2),
        "cash_owed": round(cash_owed, 2),
        "cash_held_back": round(held, 2),
        "available": available,
        "min_amount": float(get_setting("withdraw_min_amount") or 0),
    }


def _withdrawal_out(w: Dict) -> Dict[str, Any]:
    out = {k: w.get(k) for k in (
        "id", "driver_id", "amount", "state", "method", "reference", "note",
        "requested_at", "decided_at", "decided_by", "payout_id", "direct", "direct_error")}
    # "paying" is an internal marker while a payment is in flight; to the
    # driver and the hub the request is simply still pending.
    if out["state"] == "paying":
        out["state"] = "pending"
        out["decided_by"] = None
    return out


class WithdrawIn(BaseModel):
    # Leave the amount out to withdraw everything available.
    amount_rupees: Optional[float] = Field(default=None, gt=0)
    client_action_id: str


@api.get("/money/salary")
async def money_salary(driver: Dict = Depends(get_driver)):
    """The driver's salary position and their recent withdrawal requests."""
    state = await _salary_state(driver)
    reqs = [_withdrawal_out(w) async for w in db.salary_withdrawals.find(
        {"driver_id": driver["id"]}, {"_id": 0}).sort("requested_at", -1).limit(5)]
    bank = await db.driver_bank_accounts.find_one({"driver_id": driver["id"]}, {"_id": 0, "kind": 1})
    direct_on = _direct_withdraw_on()
    return {**state, "bank_saved": bool(bank), "has_pending": any(r["state"] == "pending" for r in reqs),
            "requests": reqs, "payments": await _salary_payments(driver["id"]),
            # True when a withdrawal goes straight to the bank without the hub.
            "direct": direct_on and bool(bank),
            "direct_left_today": await _direct_left_today(driver["id"]) if direct_on else None}


async def _salary_payments(driver_id: str, limit: int = 10) -> List[Dict[str, Any]]:
    """Every salary payment the driver has received, newest first, however it
    was paid: a bank / UPI transfer (a payout row) or by hand (a withdrawal
    request the hub marked paid). A request paid by transfer appears once, as
    its transfer. Transfers that failed or were reversed never arrived, so they
    are left out."""
    out: List[Dict[str, Any]] = []
    async for p in db.payouts.find({"driver_id": driver_id}, {"_id": 0}).sort("created_at", -1).limit(50):
        status_ = p.get("status") or ""
        if status_ in PAYOUT_DEAD_STATES:
            continue
        out.append({
            "id": p["id"],
            "amount": float(p.get("amount_rupees") or 0),
            "at": p.get("created_at"),
            "method": "upi" if p.get("mode") == "UPI" else "bank",
            # "processed" is RazorpayX's word for arrived; anything else is still on its way.
            "status": "paid" if status_ == "processed" else "processing",
            "reference": p.get("utr"),
        })
    async for w in db.salary_withdrawals.find(
        {"driver_id": driver_id, "state": "paid", "method": "manual"}, {"_id": 0},
    ).sort("decided_at", -1).limit(50):
        out.append({
            "id": w["id"],
            "amount": float(w.get("amount") or 0),
            "at": w.get("decided_at") or w.get("requested_at"),
            "method": "hand",
            "status": "paid",
            "reference": w.get("reference"),
        })
    out.sort(key=lambda r: r.get("at") or "", reverse=True)
    return out[:limit]


# Who the audit log and the payout row name when a withdrawal pays itself.
DIRECT_ACTOR = {"username": "driver-app", "role": "system"}


def _direct_withdraw_on() -> bool:
    return bool(get_setting("withdraw_direct")) and _razorpayx_configured()


async def _direct_left_today(driver_id: str) -> Optional[float]:
    """How much more the driver can take directly today, or None for no limit."""
    cap = float(get_setting("withdraw_direct_daily_max") or 0)
    if cap <= 0:
        return None
    start, _end = business_day_bounds(business_date_now())
    taken = 0.0
    async for w in db.salary_withdrawals.find(
        {"driver_id": driver_id, "direct": True, "state": "paid", "decided_at": {"$gte": iso(start)}},
        {"_id": 0, "amount": 1},
    ):
        taken += float(w.get("amount") or 0)
    return max(0.0, round(cap - taken, 2))


async def _send_withdrawal(w: Dict, actor: Dict) -> str:
    """Send a withdrawal to the driver's saved bank / UPI and return the payout
    id. Keyed on the withdrawal's id at both ends, so sending the same
    withdrawal again returns the first payout rather than a second one."""
    ba = await db.driver_bank_accounts.find_one({"driver_id": w["driver_id"]}, {"_id": 0, "kind": 1})
    if not ba:
        raise HTTPException(400, "bank_account_not_saved")
    res = await admin_create_payout(
        AdminPayoutIn(
            driver_id=w["driver_id"],
            amount_rupees=float(w["amount"]),
            mode="UPI" if ba.get("kind") == "vpa" else "IMPS",
            narration="Ride91 salary",
            client_action_id=f"wd:{w['id']}",
            idempotency_key=w["id"],
        ),
        actor,
    )
    return res["payout_id"]


async def _pay_withdrawal_direct(row: Dict) -> Optional[str]:
    """Try to pay a fresh withdrawal straight away. Returns None when it was
    paid, otherwise why it was left for the hub:
      off              direct withdrawal is switched off or RazorpayX is not set up
      no_bank          the driver has not saved a bank account or UPI
      over_daily_limit this would take the driver past today's direct limit
      transfer_failed  the bank transfer could not be sent
    """
    wid, did = row["id"], row["driver_id"]
    if not _direct_withdraw_on():
        return "off"
    if not await db.driver_bank_accounts.find_one({"driver_id": did}, {"_id": 1}):
        return "no_bank"
    left = await _direct_left_today(did)
    if left is not None and float(row["amount"]) > left + 0.005:
        return "over_daily_limit"
    claimed = await db.salary_withdrawals.update_one(
        {"id": wid, "state": "pending"},
        {"$set": {"state": "paying", "paying_at": iso(now_utc()), "decided_by": DIRECT_ACTOR["username"]}},
    )
    if claimed.modified_count != 1:
        return "transfer_failed"
    try:
        payout_id = await _send_withdrawal(row, DIRECT_ACTOR)
    except Exception as e:
        # Hand it to the hub. "Pay now" there is safe even if this attempt did
        # reach RazorpayX: it reuses the same key and gets the same payout back.
        why = str(e.detail) if isinstance(e, HTTPException) else type(e).__name__
        logger.warning("direct withdrawal %s not sent: %s", wid, why)
        await db.salary_withdrawals.update_one(
            {"id": wid, "state": "paying"},
            {"$set": {"state": "pending", "direct_error": why[:200]},
             "$unset": {"decided_by": "", "paying_at": ""}},
        )
        return "transfer_failed"
    await db.salary_withdrawals.update_one(
        {"id": wid},
        {"$set": {
            "state": "paid", "method": "razorpayx", "direct": True, "payout_id": payout_id,
            "decided_at": iso(now_utc()), "decided_by": DIRECT_ACTOR["username"],
        }},
    )
    await _audit(DIRECT_ACTOR, "direct_withdrawal", did,
                 {"amount": row["amount"], "withdrawal_id": wid})
    return None


@api.post("/money/salary/withdraw")
async def money_salary_withdraw(body: WithdrawIn, driver: Dict = Depends(get_driver)):
    """Withdraw salary. Paid straight to the driver's bank / UPI when direct
    withdrawal is available; otherwise it waits for the hub. One at a time; the
    amount can never exceed what is available. Idempotent on client_action_id."""
    did = driver["id"]
    existing = await db.salary_withdrawals.find_one(
        {"driver_id": did, "client_action_id": body.client_action_id}, {"_id": 0})
    if existing:
        return {"ok": True, "duplicate": True, "request": _withdrawal_out(existing),
                "direct": bool(existing.get("direct"))}
    open_q = {"driver_id": did, "state": {"$in": ["pending", "paying"]}}
    if await db.salary_withdrawals.find_one(open_q, {"_id": 1}):
        raise HTTPException(409, "withdrawal_pending")
    state = await _salary_state(driver)
    amount = round(float(body.amount_rupees if body.amount_rupees is not None else state["available"]), 2)
    if amount <= 0 or state["available"] <= 0:
        raise HTTPException(409, "nothing_to_withdraw")
    if amount > state["available"] + 0.005:
        raise HTTPException(409, "exceeds_available")
    if amount < state["min_amount"]:
        raise HTTPException(400, "below_minimum")
    row = {
        "id": str(uuid.uuid4()),
        "driver_id": did,
        "amount": amount,
        "state": "pending",                 # pending | paid | rejected
        "requested_at": iso(now_utc()),
        "client_action_id": body.client_action_id,
    }
    await db.salary_withdrawals.insert_one(row.copy())
    # Two taps landing together can both get past the check above. Only the
    # first one in stands; the other is withdrawn before any money moves.
    first = await db.salary_withdrawals.find_one(
        open_q, {"_id": 0, "id": 1}, sort=[("requested_at", 1), ("id", 1)])
    if first and first["id"] != row["id"]:
        await db.salary_withdrawals.delete_one({"id": row["id"], "state": "pending"})
        raise HTTPException(409, "withdrawal_pending")
    # ...and if another withdrawal was paid in that same instant, the amount
    # checked above is out of date. Check it again now that this one is on file.
    fresh = await _salary_state(driver, exclude_withdrawal_id=row["id"])
    if amount > fresh["available"] + 0.005:
        await db.salary_withdrawals.delete_one({"id": row["id"], "state": "pending"})
        raise HTTPException(409, "exceeds_available")

    left_for_hub = await _pay_withdrawal_direct(row)
    saved = await db.salary_withdrawals.find_one({"id": row["id"]}, {"_id": 0}) or row
    return {"ok": True, "duplicate": False, "request": _withdrawal_out(saved),
            "direct": left_for_hub is None, "direct_reason": left_for_hub}


@api.get("/admin/withdrawals")
async def admin_withdrawals(
    state: Optional[str] = None, hub_id: Optional[str] = None,
    admin: Dict = Depends(fleet_admin),
):
    """Salary withdrawal requests, newest first. `?state=pending` is the hub's
    to-pay queue; `?hub_id=` scopes to one hub's drivers. Each pending row
    carries the driver's current salary position so the hub can see at a glance
    whether it is still payable."""
    q: Dict[str, Any] = {}
    if state:
        q["state"] = {"$in": ["pending", "paying"]} if state == "pending" else state
    target = _hub_target(admin, hub_id)
    if target:
        q["driver_id"] = {"$in": await _hub_driver_ids(target)}
    rows = [w async for w in db.salary_withdrawals.find(q, {"_id": 0}).sort("requested_at", -1).limit(300)]
    who = await _drivers_by_ids([w.get("driver_id") for w in rows])
    banks = {b["driver_id"]: b async for b in db.driver_bank_accounts.find(
        {"driver_id": {"$in": [w["driver_id"] for w in rows] or ["_none"]}},
        {"_id": 0, "driver_id": 1, "kind": 1, "masked": 1})}
    items = []
    for w in rows:
        d = who.get(w["driver_id"], {})
        out = _withdrawal_out(w)
        out["driver_name"] = d.get("name")
        out["driver_phone"] = d.get("phone")
        b = banks.get(w["driver_id"])
        out["bank_kind"] = b.get("kind") if b else None
        out["bank_masked"] = b.get("masked") if b else None
        if out["state"] == "pending":
            drv = await db.drivers.find_one({"id": w["driver_id"]}, {"_id": 0, "id": 1})
            if drv:
                st = await _salary_state(drv, exclude_withdrawal_id=w["id"])
                out["payable_now"] = st["available"]
                out["cash_owed"] = st["cash_owed"]
        items.append(out)
    return {"items": items, "count": len(items),
            "pending": sum(1 for i in items if i["state"] == "pending"),
            "razorpayx_ready": _razorpayx_configured()}


class WithdrawalPayIn(BaseModel):
    # razorpayx: send the money now to the driver's saved bank / UPI.
    # manual:    the hub paid some other way (cash, own bank transfer) and is recording it.
    method: Literal["razorpayx", "manual"]
    reference: Optional[str] = None      # required for manual (slip / UTR / "cash")


@api.post("/admin/withdrawals/{withdrawal_id}/pay")
async def admin_pay_withdrawal(
    withdrawal_id: str, body: WithdrawalPayIn, admin: Dict = Depends(require_write)
):
    """Pay a pending withdrawal request. Re-checks the amount against the
    driver's salary position at this moment, so a request that has since
    become unpayable (e.g. the driver collected more cash) is refused."""
    w = await db.salary_withdrawals.find_one({"id": withdrawal_id}, {"_id": 0})
    if not w:
        raise HTTPException(404, "withdrawal_not_found")
    if w["state"] not in ("pending", "paying"):
        raise HTTPException(409, "already_decided")
    drv = await db.drivers.find_one({"id": w["driver_id"]}, {"_id": 0})
    if not drv:
        raise HTTPException(404, "driver_not_found")
    st = await _salary_state(drv, exclude_withdrawal_id=withdrawal_id)
    if float(w["amount"]) > st["available"] + 0.005:
        raise HTTPException(409, "exceeds_available")
    if body.method == "manual" and not (body.reference or "").strip():
        raise HTTPException(400, "reference_required")

    # Claim the request first, so two clicks (or two admins) cannot both pay it.
    # A claim left behind by a crashed attempt can be taken over after two
    # minutes; a RazorpayX retry is safe because the payout is keyed on this
    # request's id and is returned rather than sent twice.
    stale = iso(now_utc() - timedelta(minutes=2))
    claimed = await db.salary_withdrawals.update_one(
        {"id": withdrawal_id, "$or": [
            {"state": "pending"},
            {"state": "paying", "paying_at": {"$lt": stale}},
        ]},
        {"$set": {"state": "paying", "paying_at": iso(now_utc()), "decided_by": admin["username"]}},
    )
    if claimed.modified_count != 1:
        raise HTTPException(409, "already_decided")

    payout_id = None
    try:
        if body.method == "razorpayx":
            payout_id = await _send_withdrawal(w, admin)
    except Exception:
        # Nothing was sent: hand the request back to the queue.
        await db.salary_withdrawals.update_one(
            {"id": withdrawal_id, "state": "paying"},
            {"$set": {"state": "pending"}, "$unset": {"decided_by": "", "paying_at": ""}},
        )
        raise

    await db.salary_withdrawals.update_one(
        {"id": withdrawal_id},
        {"$set": {
            "state": "paid", "method": body.method,
            "reference": (body.reference or "").strip() or None,
            "payout_id": payout_id,
            "decided_at": iso(now_utc()), "decided_by": admin["username"],
        }, "$unset": {"direct_error": ""}},
    )
    await _audit(admin, "pay_withdrawal", w["driver_id"],
                 {"amount": w["amount"], "method": body.method, "withdrawal_id": withdrawal_id})
    return {"ok": True, "id": withdrawal_id, "state": "paid", "payout_id": payout_id}


@api.post("/admin/withdrawals/{withdrawal_id}/reject")
async def admin_reject_withdrawal(
    withdrawal_id: str, body: RequestDecisionIn, admin: Dict = Depends(require_write)
):
    """Turn a pending request down; the amount goes back to the driver's
    available salary. `note` is shown to the driver."""
    res = await db.salary_withdrawals.update_one(
        {"id": withdrawal_id, "state": "pending"},
        {"$set": {"state": "rejected", "note": body.note,
                  "decided_at": iso(now_utc()), "decided_by": admin["username"]}},
    )
    if res.modified_count != 1:
        if not await db.salary_withdrawals.find_one({"id": withdrawal_id}, {"_id": 1}):
            raise HTTPException(404, "withdrawal_not_found")
        raise HTTPException(409, "already_decided")
    w = await db.salary_withdrawals.find_one({"id": withdrawal_id}, {"_id": 0})
    await _audit(admin, "reject_withdrawal", w["driver_id"],
                 {"amount": w["amount"], "withdrawal_id": withdrawal_id})
    return {"ok": True, "id": withdrawal_id, "state": "rejected"}


# ---------- Webhook -----------------------------------------------------------

@api.post("/webhooks/razorpayx")
async def razorpayx_webhook(req: Request):
    """RazorpayX → us. Same signature scheme as regular Razorpay webhooks
    (HMAC-SHA256 of raw body). Deduped by X-Razorpay-Event-Id."""
    raw = await req.body()
    got = req.headers.get("X-Razorpay-Signature", "")
    event_hdr = req.headers.get("X-Razorpay-Event-Id", "")
    secret = _rzpx_webhook_secret()
    if not secret:
        raise HTTPException(503, "webhook_not_configured")
    want = hmac.new(
        secret.encode(), raw, hashlib.sha256
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
    # Automatic notes to the hub about this driver are not part of the
    # conversation the driver sees.
    rows = [r for r in rows if r.get("kind") != "system"]
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
async def vehicle_ping_ingest(
    body: VehiclePingIn, x_tracker_secret: Optional[str] = Header(default=None)
):
    """Hardware tracker feed. Authenticated with a shared secret so random
    callers can't inject fake GPS. Set TRACKER_INGEST_SECRET (env) or
    `tracker_ingest_secret` in settings and send it as the X-Tracker-Secret
    header. Filter `accuracy_m > 30` at read time."""
    expected = get_setting("tracker_ingest_secret") or TRACKER_INGEST_SECRET
    if not expected:
        raise HTTPException(503, "tracker_ingest_not_configured")
    if not x_tracker_secret or not hmac.compare_digest(x_tracker_secret, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad_tracker_secret")
    row = body.model_dump()
    row["id"] = str(uuid.uuid4())
    row["received_at"] = iso(now_utc())
    await db.vehicle_pings.insert_one(row)
    return {"ok": True, "id": row["id"]}



# ---------------------------------------------------------------------------
# VEHICLE PING helpers


TRACKING_QUIET_MINUTES = 10      # an on-duty phone silent for longer than this has stopped tracking


async def _last_phone_ping(driver_id: str) -> Dict[str, Any]:
    """The driver's own latest phone fix, or {}. Unlike _last_ping this does
    not need a car, so a driver with no car assigned is still covered."""
    row = await db.phone_pings.find_one(
        {"driver_id": driver_id, "lat": {"$ne": None}}, {"_id": 0}, sort=[("recorded_at", -1)])
    return row or {}


async def _tracking_status(driver_id: str, on_duty: bool, last_ping: Dict[str, Any]) -> Dict[str, Any]:
    """Whether an on-duty driver's phone is still reporting. Off duty there is
    nothing to flag. `reason` says what the phone last told us about itself."""
    if not on_duty:
        return {"tracking": None, "reason": None}
    age_min = None
    if last_ping.get("recorded_at"):
        try:
            age_min = (now_utc() - _parse_iso(last_ping["recorded_at"])).total_seconds() / 60
        except Exception:
            age_min = None
    if age_min is not None and age_min <= TRACKING_QUIET_MINUTES:
        return {"tracking": "live", "reason": None}
    hb = await db.heartbeats.find_one({"driver_id": driver_id}, {"_id": 0}, sort=[("received_at", -1)])
    reason = "no_signal"         # phone off, no network, or the app was closed by the phone
    if hb and hb.get("permission_ok") is False:
        reason = "location_off"  # the driver switched location off or took the permission away
    return {"tracking": "stopped", "reason": reason}


async def _last_ping(vehicle_id: Optional[str], driver_id: Optional[str] = None) -> Dict[str, Any]:
    """Most recent GPS ping for a car, or {} if none. With `driver_id`, only
    that driver's own phone pings count — on a car shared by a day and a night
    driver, the off-shift driver must not look 'live' off the other's phone."""
    if not vehicle_id:
        return {}
    q: Dict[str, Any] = {"vehicle_id": vehicle_id}
    if driver_id:
        q["driver_id"] = driver_id
    row = await db.vehicle_pings.find_one(q, {"_id": 0}, sort=[("recorded_at", -1)])
    return row or {}


async def _compute_distance(
    vehicle_id: str, start: datetime, end: datetime, driver_id: Optional[str] = None
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

    With `driver_id`, pings recorded by a *different* driver's phone are
    skipped, so two drivers sharing one car each get their own distance rather
    than both being credited the car's whole day. Pings with no driver_id
    (hardware feed) still count.

    Returns a diagnostics dict so callers can display / test the numbers.
    """
    # Only read pings near the window instead of the car's whole history. The
    # ±1 day pad makes the string range a safe superset whatever the stored
    # timestamp's suffix/offset; the exact cut is still done on parsed
    # datetimes below. Served by the (vehicle_id, recorded_at) index.
    cursor = db.vehicle_pings.find(
        {
            "vehicle_id": vehicle_id,
            "recorded_at": {
                "$gte": iso(start - timedelta(days=1)),
                "$lt": iso(end + timedelta(days=1)),
            },
        },
        {"_id": 0},
    ).sort("recorded_at", 1)
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
        if driver_id and p.get("driver_id") and p["driver_id"] != driver_id:
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


async def _distance_today(
    vehicle_id: str, start: datetime, end: datetime, driver_id: Optional[str] = None
) -> float:
    stats = await _compute_distance(vehicle_id, start, end, driver_id)
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
    if vehicle_id != driver.get("vehicle_id"):
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

# CORS: only browsers enforce this, and only the admin SPA is a browser client
# (the driver app is native and the checkout page is same-origin). Lock it to
# the admin origin(s). Override with ALLOWED_ORIGINS (comma-separated), or set
# it to "*" to allow all (not recommended).
_DEFAULT_ORIGINS = [
    "https://ride91-admin-561130004577.asia-south1.run.app",
    "http://localhost:5173", "http://localhost:3000",   # local admin dev
]
_origins_env = os.environ.get("ALLOWED_ORIGINS", "").strip()
if _origins_env == "*":
    _cors_origins = ["*"]
elif _origins_env:
    _cors_origins = [o.strip() for o in _origins_env.split(",") if o.strip()]
else:
    _cors_origins = _DEFAULT_ORIGINS
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=_cors_origins,
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
    # Latest phone fix / heartbeat per driver (tracking-stopped flag, live map).
    await db.phone_pings.create_index([("driver_id", 1), ("recorded_at", -1)])
    await db.heartbeats.create_index([("driver_id", 1), ("received_at", -1)])
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
    await db.alarm_responses.create_index([("driver_id", 1), ("schedule_id", 1)])
    await db.alarm_arming.create_index([("driver_id", 1), ("schedule_id", 1)], unique=True)
    await db.notifications.create_index([("driver_id", 1), ("client_action_id", 1)])
    # Razorpay dedup — order per driver+action; unique order id from Razorpay.
    await db.razorpay_orders.create_index(
        [("driver_id", 1), ("client_action_id", 1)], unique=True
    )
    await db.razorpay_orders.create_index([("razorpay_order_id", 1)], unique=True)
    # Deposit links: by client_action_id (create replay), link_id (reconcile),
    # and newest-first per driver (the app's status poll).
    await db.deposit_links.create_index([("driver_id", 1), ("client_action_id", 1)], unique=True)
    await db.deposit_links.create_index([("link_id", 1)], unique=True)
    await db.deposit_links.create_index([("driver_id", 1), ("created_at", -1)])
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
    await db.notifications.create_index([("driver_id", 1), ("direction", 1), ("read", 1)])
    await db.hubs.create_index([("name", 1)], unique=True)
    await db.vehicles.create_index([("hub_id", 1)])
    await db.driver_collection_qrs.create_index([("driver_id", 1)], unique=True)
    await db.salary_withdrawals.create_index([("driver_id", 1), ("client_action_id", 1)], unique=True)
    await db.salary_withdrawals.create_index([("state", 1), ("requested_at", -1)])
    await db.collections.create_index([("razorpay_payment_id", 1)], unique=True)
    await db.collections.create_index([("driver_id", 1), ("business_date", 1)])
    await db.reward_payouts.create_index([("driver_id", 1), ("type", 1)])
    await db.drivers.create_index([("code", 1)], unique=True, sparse=True)
    # Seed the driver-code sequence so the first new code is R91D-0106-*
    # (continuing after the fleet's existing R91D-0105). Leaves it if present.
    await db.counters.update_one(
        {"id": "driver_code"}, {"$setOnInsert": {"id": "driver_code", "seq": 105}}, upsert=True)
    await _seed_admin_owner()
    await load_settings()
    if SEED_DEMO:
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
    # Only bootstrap when an explicit ADMIN_PASSWORD is provided — never seed a
    # guessable default owner. If it's unset, an owner must be created out of band.
    if not ADMIN_PASSWORD:
        logger.warning("no ADMIN_PASSWORD set — skipping bootstrap owner seed")
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
