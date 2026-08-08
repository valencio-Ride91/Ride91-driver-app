"""Ride91 backend API tests — iteration 4.

Big restructure:
  - Duty is two layers: DUTY_LAYER (start_duty/end_duty) and
    PLATFORM_LAYER (uber/rapido/ola/not_online). Ride91 dropped from platforms.
  - Money model: platform_cash + qr_payments collections, business-day
    (04:00 IST -> 03:59 next-day IST) bucketing, /api/money/today and
    /api/money/week endpoints.

Test order matters. All classes live in this single module so pytest-xdist
loadscope pins them to one worker and executes sequentially.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest

IST = timezone(timedelta(hours=5, minutes=30))
BUSINESS_DAY_OFFSET_HOURS = 4


def business_date_now() -> str:
    now = datetime.now(timezone.utc)
    shifted = now.astimezone(IST) - timedelta(hours=BUSINESS_DAY_OFFSET_HOURS)
    return shifted.strftime("%Y-%m-%d")


def _duty_payload(state: str) -> dict:
    return {
        "state": state,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "lat": 12.9716,
        "lng": 77.5946,
        "client_action_id": str(uuid.uuid4()),
    }


DASH_B64 = "data:image/jpeg;base64," + ("A" * 128)
VIDEO_B64 = "data:video/mp4;base64," + ("B" * 256)


# =============================================================================
# Module-scoped cleanup: reset gates before this iteration's tests
# =============================================================================
@pytest.fixture(scope="module", autouse=True)
def _clean_state(auth, mongo_db):
    """Clear per-driver state so gates and math start from a known baseline."""
    driver_id = auth["driver"]["id"]
    today_bd = business_date_now()
    mongo_db.inspections.delete_many({"driver_id": driver_id, "day_key": today_bd})
    # Wipe any prior duty rows for today so start_duty/end_duty tests are deterministic
    mongo_db.duty_states.delete_many(
        {"driver_id": driver_id, "business_date": today_bd}
    )
    # Wipe today's platform_cash + qr_payments so math is predictable
    mongo_db.platform_cash.delete_many(
        {"driver_id": driver_id, "business_date": today_bd}
    )
    mongo_db.qr_payments.delete_many(
        {"driver_id": driver_id, "business_date": today_bd}
    )
    yield


# =============================================================================
# Health / Auth regression
# =============================================================================
def test_health(api_client, base_url):
    r = api_client.get(f"{base_url}/api/")
    assert r.status_code == 200
    assert r.json().get("ok") is True and r.json().get("service") == "ride91"


class TestAuth:
    def test_otp_request_demo(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/auth/otp/request", json={"phone": "+919900000001"}
        )
        assert r.status_code == 200
        assert r.json().get("debug_code") == "123456"

    def test_verify_universal_otp(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/auth/otp/verify",
            json={
                "phone": "+919900000001",
                "code": "123456",
                "client_action_id": str(uuid.uuid4()),
            },
        )
        assert r.status_code == 200
        d = r.json()
        assert d["token"] and d["driver"]["phone"] == "+919900000001"

    def test_verify_bad_otp_400(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/auth/otp/verify",
            json={
                "phone": "+919900000001",
                "code": "000000",
                "client_action_id": str(uuid.uuid4()),
            },
        )
        assert r.status_code == 400

    def test_me_requires_auth(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/auth/me")
        assert r.status_code == 401

    def test_me_ok(self, api_client, base_url, auth):
        r = api_client.get(f"{base_url}/api/auth/me", headers=auth["headers"])
        assert r.status_code == 200
        assert r.json()["driver"]["id"] == auth["driver"]["id"]


# =============================================================================
# PART 2 — Duty state enum: accepts start_duty/end_duty/not_online, rejects ride91
# =============================================================================
class TestBB_DutyLayerEnum:
    def test_ride91_rejected(self, api_client, base_url, auth):
        r = api_client.post(
            f"{base_url}/api/duty/state",
            json=_duty_payload("ride91"),
            headers=auth["headers"],
        )
        # Ride91 is not a platform anymore — Pydantic Literal 422 (or 400 guard)
        assert r.status_code in (400, 422), r.text

    def test_not_online_accepted(self, api_client, base_url, auth):
        r = api_client.post(
            f"{base_url}/api/duty/state",
            json=_duty_payload("not_online"),
            headers=auth["headers"],
        )
        assert r.status_code == 200, r.text
        assert r.json()["state"] == "not_online"


# =============================================================================
# PART 2 — Inspection gate: start_duty needs inspection; 'uber' does not
# =============================================================================
class TestCC_InspectionGate:
    def test_inspection_today_initially_missing(
        self, api_client, base_url, auth, mongo_db
    ):
        today = business_date_now()
        mongo_db.inspections.delete_many(
            {"driver_id": auth["driver"]["id"], "day_key": today}
        )
        r = api_client.get(
            f"{base_url}/api/inspection/today", headers=auth["headers"]
        )
        assert r.status_code == 200
        assert r.json() == {"completed": False, "day_key": today}

    def test_start_duty_blocked_without_inspection(
        self, api_client, base_url, auth, mongo_db
    ):
        today = business_date_now()
        mongo_db.inspections.delete_many(
            {"driver_id": auth["driver"]["id"], "day_key": today}
        )
        r = api_client.post(
            f"{base_url}/api/duty/state",
            json=_duty_payload("start_duty"),
            headers=auth["headers"],
        )
        assert r.status_code == 409, r.text
        assert r.json().get("detail") == "inspection_required"

    def test_uber_platform_does_not_require_inspection(
        self, api_client, base_url, auth, mongo_db
    ):
        """Platform-layer switches are NOT gated — the client blocks them
        client-side until on-duty. Spec explicit: only start_duty gates."""
        today = business_date_now()
        mongo_db.inspections.delete_many(
            {"driver_id": auth["driver"]["id"], "day_key": today}
        )
        r = api_client.post(
            f"{base_url}/api/duty/state",
            json=_duty_payload("uber"),
            headers=auth["headers"],
        )
        assert r.status_code == 200, r.text
        assert r.json()["state"] == "uber"

    def test_inspection_create_and_start_duty_unblocks(
        self, api_client, base_url, auth
    ):
        r = api_client.post(
            f"{base_url}/api/inspection",
            json={
                "dashboard_photo_b64": DASH_B64,
                "exterior_video_b64": VIDEO_B64,
                "exterior_video_mime": "video/mp4",
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r.status_code == 200, r.text
        assert r.json()["completed"] is True

        r2 = api_client.post(
            f"{base_url}/api/duty/state",
            json=_duty_payload("start_duty"),
            headers=auth["headers"],
        )
        assert r2.status_code == 200, r2.text
        assert r2.json()["state"] == "start_duty"
        assert r2.json().get("business_date") == business_date_now()

    def test_end_duty_accepted(self, api_client, base_url, auth):
        r = api_client.post(
            f"{base_url}/api/duty/state",
            json=_duty_payload("end_duty"),
            headers=auth["headers"],
        )
        assert r.status_code == 200
        assert r.json()["state"] == "end_duty"


# =============================================================================
# PART 3 — Business-day bucketing
# =============================================================================
class TestDD_BusinessDay:
    def test_money_today_business_date_matches(
        self, api_client, base_url, auth
    ):
        r = api_client.get(f"{base_url}/api/money/today", headers=auth["headers"])
        assert r.status_code == 200
        assert r.json()["business_date"] == business_date_now()

    def test_yesterday_platform_cash_excluded_from_money_today(
        self, api_client, base_url, auth, mongo_db
    ):
        """Inserting a platform_cash row for business_date=today-1 must NOT
        appear in money/today."""
        driver_id = auth["driver"]["id"]
        today = business_date_now()
        yesterday = (
            datetime.strptime(today, "%Y-%m-%d").date() - timedelta(days=1)
        ).strftime("%Y-%m-%d")
        # Drop any today row so baseline is clean, and stamp a yesterday row.
        mongo_db.platform_cash.delete_many(
            {"driver_id": driver_id, "business_date": today}
        )
        yid = str(uuid.uuid4())
        mongo_db.platform_cash.insert_one(
            {
                "id": yid,
                "driver_id": driver_id,
                "platform": "uber",
                "cash_amount": 999.0,
                "business_date": yesterday,
                "source": "ocr",
                "status": "provisional",
                "client_action_id": str(uuid.uuid4()),
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        r = api_client.get(
            f"{base_url}/api/money/today", headers=auth["headers"]
        )
        assert r.status_code == 200
        body = r.json()
        assert body["business_date"] == today
        # No uber cash for TODAY should exist yet — yesterday's row must not leak
        assert body["per_platform"]["uber"]["cash_collected"] == 0.0
        # cleanup
        mongo_db.platform_cash.delete_one({"id": yid})

    def test_money_week_monday_bounds(self, api_client, base_url, auth):
        r = api_client.get(f"{base_url}/api/money/week", headers=auth["headers"])
        assert r.status_code == 200, r.text
        body = r.json()
        assert "week_start" in body and "week_end_exclusive" in body
        ws = datetime.strptime(body["week_start"], "%Y-%m-%d").date()
        we = datetime.strptime(body["week_end_exclusive"], "%Y-%m-%d").date()
        assert ws.weekday() == 0, "week_start must be Monday"
        assert we.weekday() == 0, "week_end_exclusive must be Monday"
        assert (we - ws).days == 7


# =============================================================================
# PART 4 — Cash-in-hand math & endpoints
# =============================================================================
class TestEE_CashMath:
    def test_platform_cash_ride91_rejected(self, api_client, base_url, auth):
        r = api_client.post(
            f"{base_url}/api/platform-cash",
            json={
                "platform": "ride91",
                "cash_amount": 100.0,
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r.status_code == 422, r.text

    def test_platform_cash_provisional_and_appears_in_money_today(
        self, api_client, base_url, auth, mongo_db
    ):
        driver_id = auth["driver"]["id"]
        today = business_date_now()
        # Clean today's cash/qr so math is deterministic
        mongo_db.platform_cash.delete_many(
            {"driver_id": driver_id, "business_date": today}
        )
        mongo_db.qr_payments.delete_many(
            {"driver_id": driver_id, "business_date": today}
        )

        # Uber cash 1000
        r = api_client.post(
            f"{base_url}/api/platform-cash",
            json={
                "platform": "uber",
                "cash_amount": 1000.0,
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r.status_code == 200, r.text
        row = r.json()
        assert row["status"] == "provisional"
        assert row["source"] == "ocr"
        assert row["platform"] == "uber"
        assert row["business_date"] == today

        # QR fare 200
        r_qr_fare = api_client.post(
            f"{base_url}/api/qr-payment",
            json={
                "amount": 200.0,
                "type": "fare",
                "reference": "FARE-TEST-1",
                "platform": "uber",
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r_qr_fare.status_code == 200, r_qr_fare.text
        assert r_qr_fare.json()["type"] == "fare"

        # QR deposit 300
        r_qr_dep = api_client.post(
            f"{base_url}/api/qr-payment",
            json={
                "amount": 300.0,
                "type": "deposit",
                "reference": "DEP-TEST-1",
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r_qr_dep.status_code == 200, r_qr_dep.text
        assert r_qr_dep.json()["type"] == "deposit"

        # money/today: 1000 - 200 - 300 = 500
        m = api_client.get(
            f"{base_url}/api/money/today", headers=auth["headers"]
        ).json()
        assert m["business_date"] == today
        assert m["per_platform"]["uber"]["cash_collected"] == 1000.0
        assert m["per_platform"]["uber"]["status"] == "provisional"
        assert m["qr_fares"] == 200.0
        assert m["deposits"] == 300.0
        assert m["cash_in_hand"] == 500.0
        # Deposits NOT double-counted as fares
        assert m["qr_fares"] != m["qr_fares"] + m["deposits"]
        # you_owe zero when cash_in_hand positive
        assert m["you_owe"] == 0.0

    def test_money_today_status_pending_for_empty_platforms(
        self, api_client, base_url, auth
    ):
        m = api_client.get(
            f"{base_url}/api/money/today", headers=auth["headers"]
        ).json()
        # Rapido and Ola weren't populated in test above -> pending
        assert m["per_platform"]["rapido"]["status"] == "pending"
        assert m["per_platform"]["ola"]["status"] == "pending"

    def test_you_owe_positive_when_cash_negative(
        self, api_client, base_url, auth, mongo_db
    ):
        driver_id = auth["driver"]["id"]
        today = business_date_now()
        # Wipe today's cash and add only a big deposit — cash_in_hand goes negative
        mongo_db.platform_cash.delete_many(
            {"driver_id": driver_id, "business_date": today}
        )
        mongo_db.qr_payments.delete_many(
            {"driver_id": driver_id, "business_date": today}
        )
        r = api_client.post(
            f"{base_url}/api/qr-payment",
            json={
                "amount": 500.0,
                "type": "deposit",
                "reference": "DEP-OWE-1",
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r.status_code == 200
        m = api_client.get(
            f"{base_url}/api/money/today", headers=auth["headers"]
        ).json()
        assert m["cash_in_hand"] == -500.0
        assert m["you_owe"] == 500.0


# =============================================================================
# PART 5 — /api/money/week shape
# =============================================================================
class TestFF_MoneyWeek:
    def test_shape(self, api_client, base_url, auth):
        r = api_client.get(f"{base_url}/api/money/week", headers=auth["headers"])
        assert r.status_code == 200, r.text
        body = r.json()
        for k in (
            "week_start", "week_end_exclusive", "days_remaining",
            "per_platform", "total_settled", "total_provisional",
            "estimated_gross", "driver_share", "cash_held", "advance",
            "advance_recovery_week", "payable_estimate",
        ):
            assert k in body, f"missing key {k}: {body.keys()}"
        for p in ("uber", "rapido", "ola"):
            assert p in body["per_platform"]
            for pk in ("settled_gross", "provisional_gross"):
                assert pk in body["per_platform"][p]
        # driver_share = estimated_gross * 0.30
        expected = round(body["estimated_gross"] * 0.30, 2)
        assert abs(body["driver_share"] - expected) < 0.02
        # numeric even if negative
        assert isinstance(body["payable_estimate"], (int, float))


# =============================================================================
# PART 6 — Vehicle pings ingest with nullable fields & accuracy/speed filters
# =============================================================================
class TestGG_VehiclePings:
    def test_ingest_nullable_soc_and_odometer(
        self, api_client, base_url, auth
    ):
        r = api_client.post(
            f"{base_url}/api/vehicles/pings/ingest",
            json={
                "vehicle_id": auth["driver"]["vehicle_id"],
                "recorded_at": datetime.now(timezone.utc).isoformat(),
                "lat": 12.97, "lng": 77.59,
                "speed_kmph": 20.0,
                "ignition": True,
                # soc_pct and odometer_km omitted (nullable)
                "accuracy_m": 10.0,
            },
        )
        assert r.status_code == 200, r.text
        assert r.json().get("ok") is True

    def test_accuracy_over_30_filtered_from_distance(
        self, api_client, base_url, auth
    ):
        # baseline
        d0 = api_client.get(
            f"{base_url}/api/duty/today", headers=auth["headers"]
        ).json()["distance_km"]
        # low-accuracy far ping
        api_client.post(
            f"{base_url}/api/vehicles/pings/ingest",
            json={
                "vehicle_id": auth["driver"]["vehicle_id"],
                "recorded_at": datetime.now(timezone.utc).isoformat(),
                "lat": 13.0716, "lng": 77.6946,
                "speed_kmph": 30.0,
                "ignition": True,
                "accuracy_m": 80.0,  # > 30 -> must be dropped
            },
        )
        d1 = api_client.get(
            f"{base_url}/api/duty/today", headers=auth["headers"]
        ).json()["distance_km"]
        assert d1 - d0 < 1.0, f"low-accuracy ping leaked (d0={d0}, d1={d1})"

    def test_speed_over_120_kmh_jump_dropped(
        self, api_client, base_url, auth
    ):
        """Two pings ~11 km apart 10 seconds apart implies ~4000 km/h — server
        must reset the anchor and not add that segment to distance."""
        d0 = api_client.get(
            f"{base_url}/api/duty/today", headers=auth["headers"]
        ).json()["distance_km"]
        now = datetime.now(timezone.utc)
        api_client.post(
            f"{base_url}/api/vehicles/pings/ingest",
            json={
                "vehicle_id": auth["driver"]["vehicle_id"],
                "recorded_at": (now - timedelta(seconds=20)).isoformat(),
                "lat": 12.97, "lng": 77.59,
                "speed_kmph": 20.0, "ignition": True,
                "accuracy_m": 8.0,
            },
        )
        api_client.post(
            f"{base_url}/api/vehicles/pings/ingest",
            json={
                "vehicle_id": auth["driver"]["vehicle_id"],
                "recorded_at": (now - timedelta(seconds=10)).isoformat(),
                "lat": 13.0716, "lng": 77.6946,  # ~11km jump
                "speed_kmph": 30.0, "ignition": True,
                "accuracy_m": 8.0,
            },
        )
        d1 = api_client.get(
            f"{base_url}/api/duty/today", headers=auth["headers"]
        ).json()["distance_km"]
        assert d1 - d0 < 2.0, f"high-speed jump not dropped (d0={d0}, d1={d1})"


# =============================================================================
# REGRESSION — requests idempotency + admin correction
# =============================================================================
class TestHH_RequestsIdempotent:
    def test_same_client_action_id_returns_same_row(
        self, api_client, base_url, auth
    ):
        cid = str(uuid.uuid4())
        payload = {
            "type": "advance",
            "payload": {"amount": 1000, "reason": "TEST"},
            "client_action_id": cid,
        }
        r1 = api_client.post(
            f"{base_url}/api/requests", json=payload, headers=auth["headers"]
        )
        r2 = api_client.post(
            f"{base_url}/api/requests", json=payload, headers=auth["headers"]
        )
        assert r1.status_code == 200 and r2.status_code == 200
        assert r1.json()["id"] == r2.json()["id"]

    def test_unique_index_blocks_bypass(
        self, api_client, base_url, auth, mongo_db
    ):
        """If someone bypasses the guard, the unique index must throw."""
        from pymongo.errors import DuplicateKeyError

        driver_id = auth["driver"]["id"]
        cid = str(uuid.uuid4())
        doc = {
            "id": str(uuid.uuid4()),
            "driver_id": driver_id,
            "type": "advance",
            "payload": {},
            "state": "pending",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "decided_at": None,
            "client_action_id": cid,
        }
        mongo_db.requests.insert_one(doc.copy())
        dup = doc.copy()
        dup["_id"] = None
        del dup["_id"]
        dup["id"] = str(uuid.uuid4())
        with pytest.raises(DuplicateKeyError):
            mongo_db.requests.insert_one(dup)
        # cleanup
        mongo_db.requests.delete_many({"client_action_id": cid})


class TestII_AdminCorrection:
    def test_source_admin_correction_stored(self, api_client, base_url, auth):
        cid = str(uuid.uuid4())
        r = api_client.post(
            f"{base_url}/api/duty/state",
            json={
                "state": "not_online",
                "started_at": datetime.now(timezone.utc).isoformat(),
                "lat": 12.97, "lng": 77.59,
                "source": "admin_correction",
                "client_action_id": cid,
            },
            headers=auth["headers"],
        )
        assert r.status_code == 200, r.text
        assert r.json().get("source") == "admin_correction"


# =============================================================================
# REGRESSION — tracking heartbeat + close-out legacy endpoint still works
# =============================================================================
class TestJJ_Tracking:
    def test_heartbeat_ok(self, api_client, base_url, auth):
        r = api_client.post(
            f"{base_url}/api/tracking/heartbeat",
            json={
                "ts": datetime.now(timezone.utc).isoformat(),
                "permission_ok": True,
                "network_up": True,
                "battery_pct": 82.5,
            },
            headers=auth["headers"],
        )
        assert r.status_code == 200 and r.json().get("ok") is True

    def test_close_out_legacy_still_accepts(self, api_client, base_url, auth):
        """Legacy endpoint — kept alive, but ignored by new money math."""
        cid = str(uuid.uuid4())
        now = datetime.now(timezone.utc)
        payload = {
            "platform": "uber",
            "from_ts": (now - timedelta(hours=1)).isoformat(),
            "to_ts": now.isoformat(),
            "trips": 3,
            "gross_amount": 400.0,
            "cash_collected": 120.0,
            "client_action_id": cid,
        }
        r1 = api_client.post(
            f"{base_url}/api/close-out", json=payload, headers=auth["headers"]
        )
        r2 = api_client.post(
            f"{base_url}/api/close-out", json=payload, headers=auth["headers"]
        )
        assert r1.status_code == 200 and r2.status_code == 200
        assert r1.json()["id"] == r2.json()["id"]


# =============================================================================
# REGRESSION — inspection today endpoint shape
# =============================================================================
class TestKK_InspectionToday:
    def test_completed_after_earlier_submit(self, api_client, base_url, auth):
        # An inspection was submitted in TestCC_InspectionGate
        r = api_client.get(
            f"{base_url}/api/inspection/today", headers=auth["headers"]
        )
        assert r.status_code == 200
        body = r.json()
        assert body["completed"] is True
        assert body["day_key"] == business_date_now()
        assert "dashboard_photo_b64" not in body
        assert "exterior_video_b64" not in body


# =============================================================================
# REGRESSION — earnings extract (Gemini). Auth only — real LLM call is optional
# =============================================================================
class TestLL_EarningsExtractAuth:
    def test_requires_auth(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/earnings/extract",
            json={
                "platform": "uber",
                "image_base64": "AA==",
                "mime": "image/png",
                "client_action_id": str(uuid.uuid4()),
            },
        )
        assert r.status_code == 401
