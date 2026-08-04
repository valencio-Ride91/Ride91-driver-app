"""Ride91 backend API tests — inspection gate, driver flows, duty, close-outs, money, requests, tracking.

All tests live in this single module so pytest-xdist loadscope pins them to one
worker and executes them sequentially — the inspection classes must run BEFORE
the duty/regression classes because the hard-gate requires no inspection at
first, then an inspection is created and unlocks working-platform duty states.
"""
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv(Path(__file__).resolve().parents[1].parent / "frontend" / ".env")
load_dotenv(Path(__file__).resolve().parents[1] / ".env")


def _ist_day_key() -> str:
    ist = timezone(timedelta(hours=5, minutes=30))
    return datetime.now(timezone.utc).astimezone(ist).strftime("%Y-%m-%d")


# ================================================================
# PRE-SHIFT INSPECTION (must run first — establishes / creates today's inspection)
# ================================================================
DASH_B64 = "data:image/jpeg;base64," + ("A" * 128)
VIDEO_B64 = "data:video/mp4;base64," + ("B" * 256)


def _duty_payload(state: str) -> dict:
    return {
        "state": state,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "lat": 12.9716,
        "lng": 77.5946,
        "client_action_id": str(uuid.uuid4()),
    }


@pytest.fixture(scope="module", autouse=True)
def _clean_today_inspection(auth, mongo_db, today_key):
    """Delete any prior inspection for today so hard-gate tests start clean."""
    mongo_db.inspections.delete_many(
        {"driver_id": auth["driver"]["id"], "day_key": today_key}
    )
    yield


class TestInspectionAuth:
    def test_get_today_requires_auth(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/inspection/today")
        assert r.status_code == 401

    def test_post_requires_auth(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/inspection",
            json={
                "dashboard_photo_b64": DASH_B64,
                "exterior_video_b64": VIDEO_B64,
                "exterior_video_mime": "video/mp4",
                "client_action_id": str(uuid.uuid4()),
            },
        )
        assert r.status_code == 401


class TestAA_InspectionGateBeforeSubmit:
    """Prefixed AA_ so this class collects before every other class in module."""

    def test_today_shows_not_completed(self, api_client, base_url, auth, today_key):
        r = api_client.get(f"{base_url}/api/inspection/today", headers=auth["headers"])
        assert r.status_code == 200, r.text
        assert r.json() == {"completed": False, "day_key": today_key}

    @pytest.mark.parametrize("platform", ["ride91", "uber", "rapido", "ola"])
    def test_going_on_platform_without_inspection_is_409(
        self, api_client, base_url, auth, platform
    ):
        r = api_client.post(
            f"{base_url}/api/duty/state",
            json=_duty_payload(platform),
            headers=auth["headers"],
        )
        assert r.status_code == 409, f"{platform}: {r.status_code} {r.text}"
        assert r.json().get("detail") == "inspection_required"

    def test_offline_allowed_without_inspection(self, api_client, base_url, auth):
        r = api_client.post(
            f"{base_url}/api/duty/state",
            json=_duty_payload("offline"),
            headers=auth["headers"],
        )
        assert r.status_code == 200, r.text
        assert r.json()["state"] == "offline"

    def test_shift_end_allowed_without_inspection(self, api_client, base_url, auth):
        r = api_client.post(
            f"{base_url}/api/duty/state",
            json=_duty_payload("shift_end"),
            headers=auth["headers"],
        )
        assert r.status_code == 200, r.text
        assert r.json()["state"] == "shift_end"


class TestAB_InspectionSubmit:
    first_id: str | None = None
    first_cid: str | None = None

    def test_create_success_no_blobs_echoed(self, api_client, base_url, auth):
        cid = str(uuid.uuid4())
        r = api_client.post(
            f"{base_url}/api/inspection",
            json={
                "dashboard_photo_b64": DASH_B64,
                "exterior_video_b64": VIDEO_B64,
                "exterior_video_mime": "video/mp4",
                "client_action_id": cid,
            },
            headers=auth["headers"],
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("completed") is True
        assert isinstance(body.get("id"), str)
        assert "created_at" in body
        assert "dashboard_photo_b64" not in body
        assert "exterior_video_b64" not in body
        TestAB_InspectionSubmit.first_id = body["id"]
        TestAB_InspectionSubmit.first_cid = cid

    def test_idempotent_same_client_action_id(self, api_client, base_url, auth):
        assert TestAB_InspectionSubmit.first_cid
        r = api_client.post(
            f"{base_url}/api/inspection",
            json={
                "dashboard_photo_b64": DASH_B64,
                "exterior_video_b64": VIDEO_B64,
                "exterior_video_mime": "video/mp4",
                "client_action_id": TestAB_InspectionSubmit.first_cid,
            },
            headers=auth["headers"],
        )
        assert r.status_code == 200
        assert r.json()["id"] == TestAB_InspectionSubmit.first_id
        assert "dashboard_photo_b64" not in r.json()

    def test_idempotent_per_driver_per_day_different_cid(
        self, api_client, base_url, auth, mongo_db, today_key
    ):
        driver_id = auth["driver"]["id"]
        before = mongo_db.inspections.count_documents(
            {"driver_id": driver_id, "day_key": today_key}
        )
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
        assert r.status_code == 200
        assert r.json()["id"] == TestAB_InspectionSubmit.first_id
        after = mongo_db.inspections.count_documents(
            {"driver_id": driver_id, "day_key": today_key}
        )
        assert after == before == 1

    def test_today_after_submit_completed_no_blobs(
        self, api_client, base_url, auth, today_key
    ):
        r = api_client.get(f"{base_url}/api/inspection/today", headers=auth["headers"])
        assert r.status_code == 200
        body = r.json()
        assert body["completed"] is True
        assert body["id"] == TestAB_InspectionSubmit.first_id
        assert body["day_key"] == today_key
        assert "created_at" in body
        assert "dashboard_photo_b64" not in body
        assert "exterior_video_b64" not in body

    def test_ride91_allowed_after_inspection(self, api_client, base_url, auth):
        r = api_client.post(
            f"{base_url}/api/duty/state",
            json=_duty_payload("ride91"),
            headers=auth["headers"],
        )
        assert r.status_code == 200, r.text
        assert r.json()["state"] == "ride91"


# ================================================================
# REGRESSION — health, auth, duty, close-outs, money, requests, tracking
# ================================================================
# ---------------------------------------------------------------- health
def test_health(api_client, base_url):
    r = api_client.get(f"{base_url}/api/")
    assert r.status_code == 200
    body = r.json()
    assert body.get("ok") is True
    assert body.get("service") == "ride91"


# ---------------------------------------------------------------- auth
class TestAuth:
    def test_otp_request_any_phone(self, api_client, base_url):
        r = api_client.post(f"{base_url}/api/auth/otp/request", json={"phone": "+919888777666"})
        assert r.status_code == 200
        body = r.json()
        assert body.get("sent") is True
        assert "debug_code" in body and len(str(body["debug_code"])) == 6

    def test_otp_request_demo_phone_returns_universal_code(self, api_client, base_url):
        r = api_client.post(f"{base_url}/api/auth/otp/request", json={"phone": "+919900000001"})
        assert r.status_code == 200
        assert r.json().get("debug_code") == "123456"

    def test_verify_universal_otp_returns_token_and_driver(self, api_client, base_url):
        cid = str(uuid.uuid4())
        r = api_client.post(
            f"{base_url}/api/auth/otp/verify",
            json={"phone": "+919900000001", "code": "123456", "client_action_id": cid},
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["token"] and isinstance(d["token"], str)
        drv = d["driver"]
        assert drv["phone"] == "+919900000001"
        for k in ("id", "name", "vehicle_id", "vehicle_number", "qr_code"):
            assert k in drv

    def test_verify_idempotent_same_client_action_id(self, api_client, base_url):
        cid = str(uuid.uuid4())
        payload = {"phone": "+919900000001", "code": "123456", "client_action_id": cid}
        r1 = api_client.post(f"{base_url}/api/auth/otp/verify", json=payload)
        r2 = api_client.post(f"{base_url}/api/auth/otp/verify", json=payload)
        assert r1.status_code == r2.status_code == 200
        assert r1.json()["token"] == r2.json()["token"], "verify must be idempotent per client_action_id"

    def test_verify_bad_otp_400(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/auth/otp/verify",
            json={"phone": "+919900000001", "code": "000000", "client_action_id": str(uuid.uuid4())},
        )
        assert r.status_code == 400

    def test_me_requires_auth(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/auth/me")
        assert r.status_code == 401

    def test_me_with_token(self, api_client, base_url, auth):
        r = api_client.get(f"{base_url}/api/auth/me", headers=auth["headers"])
        assert r.status_code == 200
        body = r.json()
        assert body["driver"]["phone"] == "+919900000001"
        assert body.get("vehicle", {}).get("id") == auth["driver"]["vehicle_id"]


# ---------------------------------------------------------------- duty states
class TestDutyStates:
    def test_append_requires_auth(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/duty/state",
            json={
                "state": "ride91",
                "started_at": datetime.now(timezone.utc).isoformat(),
                "lat": 12.97, "lng": 77.59,
                "client_action_id": str(uuid.uuid4()),
            },
        )
        assert r.status_code == 401

    def test_append_and_idempotency(self, api_client, base_url, auth):
        cid = str(uuid.uuid4())
        payload = {
            "state": "uber",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "lat": 12.9716, "lng": 77.5946,
            "client_action_id": cid,
        }
        r1 = api_client.post(f"{base_url}/api/duty/state", json=payload, headers=auth["headers"])
        assert r1.status_code == 200, r1.text
        row1 = r1.json()
        assert row1["state"] == "uber"
        assert "id" in row1
        # Same client_action_id => must echo same row, not create new
        r2 = api_client.post(f"{base_url}/api/duty/state", json=payload, headers=auth["headers"])
        assert r2.status_code == 200
        assert r2.json()["id"] == row1["id"], "duty_state must be idempotent on client_action_id"

    def test_today_returns_segments_and_totals(self, api_client, base_url, auth):
        # Append a fresh state so 'current_state' is deterministic
        cid = str(uuid.uuid4())
        api_client.post(
            f"{base_url}/api/duty/state",
            json={
                "state": "ride91",
                "started_at": datetime.now(timezone.utc).isoformat(),
                "lat": 12.9716, "lng": 77.5946,
                "client_action_id": cid,
            },
            headers=auth["headers"],
        )
        r = api_client.get(f"{base_url}/api/duty/today", headers=auth["headers"])
        assert r.status_code == 200
        body = r.json()
        for k in ("segments", "totals_seconds", "shift_seconds", "working_seconds", "current_state", "distance_km"):
            assert k in body, f"missing key {k}"
        assert isinstance(body["segments"], list) and len(body["segments"]) > 0
        # ordered by from_ts ascending
        ts = [s["from_ts"] for s in body["segments"]]
        assert ts == sorted(ts)
        assert body["current_state"] == body["segments"][-1]["state"]
        assert body["current_state"] == "ride91"
        assert isinstance(body["distance_km"], (int, float))


# ---------------------------------------------------------------- vehicle pings & distance filter
class TestVehiclePings:
    def test_ingest_without_auth(self, api_client, base_url, auth):
        vehicle_id = auth["driver"]["vehicle_id"]
        r = api_client.post(
            f"{base_url}/api/vehicles/pings/ingest",
            json={
                "vehicle_id": vehicle_id,
                "recorded_at": datetime.now(timezone.utc).isoformat(),
                "lat": 12.9716, "lng": 77.5946,
                "speed_kmph": 25.0, "ignition": True, "soc_pct": 62.0,
                "accuracy_m": 12.0,
            },
        )
        assert r.status_code == 200
        assert r.json().get("ok") is True

    def test_low_accuracy_ping_filtered_from_distance(self, api_client, base_url, auth):
        vehicle_id = auth["driver"]["vehicle_id"]
        # baseline
        r0 = api_client.get(f"{base_url}/api/duty/today", headers=auth["headers"])
        d0 = r0.json()["distance_km"]

        # Insert a low-accuracy ping ~1 km away from any prior good ping.
        # If it were counted, distance would jump by >~1 km.
        far_payload = {
            "vehicle_id": vehicle_id,
            "recorded_at": datetime.now(timezone.utc).isoformat(),
            "lat": 13.0716,  # ~11km away, would explode distance if counted
            "lng": 77.6946,
            "speed_kmph": 30.0, "ignition": True, "soc_pct": 60.0,
            "accuracy_m": 80.0,  # >30 => must be filtered
        }
        r = api_client.post(f"{base_url}/api/vehicles/pings/ingest", json=far_payload)
        assert r.status_code == 200

        r1 = api_client.get(f"{base_url}/api/duty/today", headers=auth["headers"])
        d1 = r1.json()["distance_km"]
        # Low-accuracy ping must not push a huge jump
        assert d1 - d0 < 1.0, f"low-accuracy ping leaked into distance (d0={d0}, d1={d1})"


# ---------------------------------------------------------------- close-outs & money
class TestCloseOutsAndMoney:
    def test_close_out_idempotent(self, api_client, base_url, auth):
        cid = str(uuid.uuid4())
        now = datetime.now(timezone.utc)
        payload = {
            "platform": "ride91",
            "from_ts": (now - timedelta(hours=1)).isoformat(),
            "to_ts": now.isoformat(),
            "trips": 3,
            "gross_amount": 400.0,
            "cash_collected": 120.0,
            "client_action_id": cid,
        }
        r1 = api_client.post(f"{base_url}/api/close-out", json=payload, headers=auth["headers"])
        assert r1.status_code == 200, r1.text
        r2 = api_client.post(f"{base_url}/api/close-out", json=payload, headers=auth["headers"])
        assert r2.status_code == 200
        assert r1.json()["id"] == r2.json()["id"], "close-out must be idempotent"

    def test_money_today_shape_and_share_math(self, api_client, base_url, auth):
        r = api_client.get(f"{base_url}/api/money/today", headers=auth["headers"])
        assert r.status_code == 200
        body = r.json()
        for k in ("gross_by_platform", "gross", "driver_share", "cash_held", "cash_over_limit", "payable"):
            assert k in body, f"missing {k}"
        for p in ("ride91", "uber", "rapido", "ola"):
            assert p in body["gross_by_platform"], f"missing platform {p} in gross_by_platform"
        # share = gross * 0.30
        expected_share = round(body["gross"] * 0.30, 2)
        assert abs(body["driver_share"] - expected_share) < 0.02
        # payable = share - cash - advance_recovery_today
        expected_payable = round(body["driver_share"] - body["cash_held"] - body.get("advance_recovery_today", 0), 2)
        assert abs(body["payable"] - expected_payable) < 0.02

    def test_cash_over_limit_flag_toggles(self, api_client, base_url, auth):
        # Force cash > 1500 with a big close-out (today)
        now = datetime.now(timezone.utc)
        r = api_client.post(
            f"{base_url}/api/close-out",
            json={
                "platform": "uber",
                "from_ts": (now - timedelta(minutes=5)).isoformat(),
                "to_ts": now.isoformat(),
                "trips": 1,
                "gross_amount": 5000.0,
                "cash_collected": 2000.0,  # pushes cash_held over 1500
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r.status_code == 200
        r2 = api_client.get(f"{base_url}/api/money/today", headers=auth["headers"])
        b = r2.json()
        assert b["cash_held"] > 1500
        assert b["cash_over_limit"] is True

    def test_money_weekly_7_days_ordered(self, api_client, base_url, auth):
        r = api_client.get(f"{base_url}/api/money/weekly", headers=auth["headers"])
        assert r.status_code == 200
        days = r.json()["days"]
        assert len(days) == 7
        dates = [d["date"] for d in days]
        assert dates == sorted(dates), "weekly must be oldest -> newest"


# ---------------------------------------------------------------- requests
class TestRequests:
    def test_create_and_list_idempotent(self, api_client, base_url, auth):
        cid = str(uuid.uuid4())
        payload = {
            "type": "advance",
            "payload": {"amount": 1000, "reason": "TEST"},
            "client_action_id": cid,
        }
        r1 = api_client.post(f"{base_url}/api/requests", json=payload, headers=auth["headers"])
        assert r1.status_code == 200, r1.text
        assert r1.json()["state"] == "pending"
        r2 = api_client.post(f"{base_url}/api/requests", json=payload, headers=auth["headers"])
        assert r2.status_code == 200
        assert r1.json()["id"] == r2.json()["id"], "requests must be idempotent"

        r3 = api_client.get(f"{base_url}/api/requests", headers=auth["headers"])
        assert r3.status_code == 200
        items = r3.json()["items"]
        assert any(it["id"] == r1.json()["id"] for it in items)


# ---------------------------------------------------------------- tracking
class TestTracking:
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
        assert r.status_code == 200
        assert r.json().get("ok") is True

    def test_phone_ping_ok(self, api_client, base_url, auth):
        r = api_client.post(
            f"{base_url}/api/tracking/ping",
            json={
                "recorded_at": datetime.now(timezone.utc).isoformat(),
                "lat": 12.97, "lng": 77.59,
            },
            headers=auth["headers"],
        )
        assert r.status_code == 200
        assert r.json().get("ok") is True
