"""Ride91 backend — Part 8b: Shift-END alarm ETA endpoint tests (iteration 6).

Covers:
- /shift-alarm/schedule persists shift_end + end_buffer_min + end_state
- /shift-alarm/end-eta: no schedule, no hub, computed ETA with query lat/lng,
  fallback to last vehicle_ping when lat/lng omitted
- /shift-alarm/response: end/start phase discriminator (400s), idempotency,
  and end_state flip on heading_back/delayed (only).
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest


pytestmark = pytest.mark.xdist_group("shift_end_alarm")


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


@pytest.fixture(scope="module", autouse=True)
def _wipe(auth, mongo_db):
    did = auth["driver"]["id"]
    mongo_db.shift_schedules.delete_many({"driver_id": did})
    mongo_db.alarm_responses.delete_many({"driver_id": did})
    yield
    mongo_db.shift_schedules.delete_many({"driver_id": did})
    mongo_db.alarm_responses.delete_many({"driver_id": did})


def _schedule(api_client, base_url, auth, *, with_end=True, end_hours=8, buffer=10):
    start = datetime.now(timezone.utc) + timedelta(hours=1)
    payload = {
        "shift_start": _iso(start),
        "shift_type": "day",
        "client_action_id": str(uuid.uuid4()),
    }
    if with_end:
        payload["shift_end"] = _iso(start + timedelta(hours=end_hours))
        payload["end_buffer_min"] = buffer
    r = api_client.post(
        f"{base_url}/api/shift-alarm/schedule", json=payload, headers=auth["headers"]
    )
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------------------
# schedule persists end fields
# ---------------------------------------------------------------------------
class TestShiftEndAlarm:
    def test_with_shift_end_populates_end_state_scheduled(
        self, api_client, base_url, auth, mongo_db
    ):
        mongo_db.shift_schedules.delete_many({"driver_id": auth["driver"]["id"]})
        row = _schedule(api_client, base_url, auth, with_end=True, buffer=15)
        assert row["shift_end"]
        assert row["end_buffer_min"] == 15
        assert row["end_state"] == "scheduled"

    def test_without_shift_end_marks_end_state_na(
        self, api_client, base_url, auth, mongo_db
    ):
        mongo_db.shift_schedules.delete_many({"driver_id": auth["driver"]["id"]})
        row = _schedule(api_client, base_url, auth, with_end=False)
        assert row.get("shift_end") is None
        assert row["end_state"] == "na"


# ---------------------------------------------------------------------------
# end-eta endpoint
# ---------------------------------------------------------------------------
    def test_no_schedule_returns_false(self, api_client, base_url, auth, mongo_db):
        mongo_db.shift_schedules.delete_many({"driver_id": auth["driver"]["id"]})
        r = api_client.get(
            f"{base_url}/api/shift-alarm/end-eta", headers=auth["headers"]
        )
        assert r.status_code == 200
        assert r.json() == {"has_end_alarm": False}

    def test_with_hub_and_query_lat_lng(
        self, api_client, base_url, auth, mongo_db
    ):
        mongo_db.shift_schedules.delete_many({"driver_id": auth["driver"]["id"]})
        row = _schedule(api_client, base_url, auth, with_end=True, end_hours=6, buffer=10)
        # MG Road-ish point ~5km from Koramangala hub
        r = api_client.get(
            f"{base_url}/api/shift-alarm/end-eta?lat=12.9716&lng=77.5946",
            headers=auth["headers"],
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["has_end_alarm"] is True
        assert body["has_hub"] is True
        assert body["schedule_id"] == row["id"]
        assert body["hub_name"] == "Koramangala Hub"
        assert body["distance_km"] > 0.5
        assert body["eta_minutes"] > 0
        assert 12.0 <= body["avg_speed_kmph"] <= 45.0
        # alarm_at ≈ shift_end - (eta + buffer) minutes
        shift_end_dt = datetime.fromisoformat(body["shift_end"].replace("Z", "+00:00"))
        alarm_at_dt = datetime.fromisoformat(body["alarm_at"].replace("Z", "+00:00"))
        expected_delta = (body["eta_minutes"] + body["buffer_minutes"]) * 60
        actual_delta = (shift_end_dt - alarm_at_dt).total_seconds()
        assert abs(actual_delta - expected_delta) < 5, (
            f"alarm_at drift: expected {expected_delta}s, got {actual_delta}s"
        )

    def test_uses_last_vehicle_ping_when_no_query(
        self, api_client, base_url, auth, mongo_db
    ):
        mongo_db.shift_schedules.delete_many({"driver_id": auth["driver"]["id"]})
        _schedule(api_client, base_url, auth, with_end=True)
        # Confirm the demo driver has vehicle_pings seeded around MG Road
        did = auth["driver"]["id"]
        drv = mongo_db.drivers.find_one({"id": did}, {"_id": 0})
        ping = mongo_db.vehicle_pings.find_one(
            {"vehicle_id": drv["vehicle_id"]}, sort=[("recorded_at", -1)]
        )
        assert ping is not None, "seed pings missing — /end-eta ping fallback cannot be tested"
        r = api_client.get(
            f"{base_url}/api/shift-alarm/end-eta", headers=auth["headers"]
        )
        assert r.status_code == 200
        body = r.json()
        assert body["has_end_alarm"] is True
        assert body["has_hub"] is True
        # current_* should match latest ping (within float precision)
        assert abs(body["current_lat"] - ping["lat"]) < 1e-6
        assert abs(body["current_lng"] - ping["lng"]) < 1e-6

    def test_driver_without_hub_has_hub_false(
        self, api_client, base_url, auth, mongo_db
    ):
        did = auth["driver"]["id"]
        mongo_db.shift_schedules.delete_many({"driver_id": did})
        row = _schedule(api_client, base_url, auth, with_end=True)
        # Temporarily strip hub fields
        original = mongo_db.drivers.find_one({"id": did}, {"_id": 0})
        mongo_db.drivers.update_one(
            {"id": did},
            {"$unset": {"hub_lat": "", "hub_lng": "", "hub_name": ""}},
        )
        try:
            r = api_client.get(
                f"{base_url}/api/shift-alarm/end-eta?lat=12.9716&lng=77.5946",
                headers=auth["headers"],
            )
            assert r.status_code == 200
            body = r.json()
            assert body["has_end_alarm"] is True
            assert body["has_hub"] is False
            assert body["schedule_id"] == row["id"]
            assert body["shift_end"]
        finally:
            # Restore
            mongo_db.drivers.update_one(
                {"id": did},
                {"$set": {
                    "hub_name": original.get("hub_name", "Koramangala Hub"),
                    "hub_lat": original.get("hub_lat", 12.9352),
                    "hub_lng": original.get("hub_lng", 77.6245),
                }},
            )


# ---------------------------------------------------------------------------
# phase discriminator on response endpoint
# ---------------------------------------------------------------------------
    def test_end_phase_with_awake_400(self, api_client, base_url, auth, mongo_db):
        mongo_db.shift_schedules.delete_many({"driver_id": auth["driver"]["id"]})
        row = _schedule(api_client, base_url, auth, with_end=True)
        r = api_client.post(
            f"{base_url}/api/shift-alarm/response",
            json={
                "schedule_id": row["id"],
                "phase": "end",
                "response": "awake",
                "fired_at": _iso(datetime.now(timezone.utc)),
                "responded_at": _iso(datetime.now(timezone.utc)),
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r.status_code == 400
        assert r.json().get("detail") == "invalid_response_for_end_phase"

    def test_start_phase_with_heading_back_400(
        self, api_client, base_url, auth, mongo_db
    ):
        mongo_db.shift_schedules.delete_many({"driver_id": auth["driver"]["id"]})
        row = _schedule(api_client, base_url, auth, with_end=True)
        r = api_client.post(
            f"{base_url}/api/shift-alarm/response",
            json={
                "schedule_id": row["id"],
                "phase": "start",
                "response": "heading_back",
                "fired_at": _iso(datetime.now(timezone.utc)),
                "responded_at": _iso(datetime.now(timezone.utc)),
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r.status_code == 400
        assert r.json().get("detail") == "invalid_response_for_start_phase"

    def test_end_heading_back_idempotent_and_flips_only_end_state(
        self, api_client, base_url, auth, mongo_db
    ):
        did = auth["driver"]["id"]
        mongo_db.shift_schedules.delete_many({"driver_id": did})
        mongo_db.alarm_responses.delete_many({"driver_id": did})
        row = _schedule(api_client, base_url, auth, with_end=True)
        cid = str(uuid.uuid4())
        payload = {
            "schedule_id": row["id"],
            "phase": "end",
            "response": "heading_back",
            "fired_at": _iso(datetime.now(timezone.utc)),
            "responded_at": _iso(datetime.now(timezone.utc)),
            "client_action_id": cid,
        }
        r1 = api_client.post(
            f"{base_url}/api/shift-alarm/response", json=payload, headers=auth["headers"]
        )
        r2 = api_client.post(
            f"{base_url}/api/shift-alarm/response", json=payload, headers=auth["headers"]
        )
        assert r1.status_code == 200 and r2.status_code == 200
        assert r1.json()["id"] == r2.json()["id"], "not idempotent"
        assert r1.json()["phase"] == "end"
        # Verify DB state: end_state flipped, start state untouched
        db_row = mongo_db.shift_schedules.find_one({"id": row["id"]}, {"_id": 0})
        assert db_row["end_state"] == "responded"
        assert db_row["state"] == "scheduled", (
            f"start state incorrectly changed: {db_row['state']}"
        )

    def test_end_snooze_does_not_flip_end_state(
        self, api_client, base_url, auth, mongo_db
    ):
        did = auth["driver"]["id"]
        mongo_db.shift_schedules.delete_many({"driver_id": did})
        mongo_db.alarm_responses.delete_many({"driver_id": did})
        row = _schedule(api_client, base_url, auth, with_end=True)
        r = api_client.post(
            f"{base_url}/api/shift-alarm/response",
            json={
                "schedule_id": row["id"],
                "phase": "end",
                "response": "snooze",
                "fired_at": _iso(datetime.now(timezone.utc)),
                "responded_at": _iso(datetime.now(timezone.utc)),
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r.status_code == 200, r.text
        db_row = mongo_db.shift_schedules.find_one({"id": row["id"]}, {"_id": 0})
        assert db_row["end_state"] == "scheduled"

    def test_end_delayed_flips_end_state(
        self, api_client, base_url, auth, mongo_db
    ):
        did = auth["driver"]["id"]
        mongo_db.shift_schedules.delete_many({"driver_id": did})
        mongo_db.alarm_responses.delete_many({"driver_id": did})
        row = _schedule(api_client, base_url, auth, with_end=True)
        r = api_client.post(
            f"{base_url}/api/shift-alarm/response",
            json={
                "schedule_id": row["id"],
                "phase": "end",
                "response": "delayed",
                "fired_at": _iso(datetime.now(timezone.utc)),
                "responded_at": _iso(datetime.now(timezone.utc)),
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r.status_code == 200
        db_row = mongo_db.shift_schedules.find_one({"id": row["id"]}, {"_id": 0})
        assert db_row["end_state"] == "responded"


# ---------------------------------------------------------------------------
# /next returns row when only end_state is scheduled (state already responded)
# ---------------------------------------------------------------------------
    def test_next_returns_row_when_start_responded_but_end_scheduled(
        self, api_client, base_url, auth, mongo_db
    ):
        did = auth["driver"]["id"]
        mongo_db.shift_schedules.delete_many({"driver_id": did})
        mongo_db.alarm_responses.delete_many({"driver_id": did})
        row = _schedule(api_client, base_url, auth, with_end=True)
        # Flip start state to 'responded' via awake
        r = api_client.post(
            f"{base_url}/api/shift-alarm/response",
            json={
                "schedule_id": row["id"],
                "phase": "start",
                "response": "awake",
                "fired_at": _iso(datetime.now(timezone.utc)),
                "responded_at": _iso(datetime.now(timezone.utc)),
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r.status_code == 200
        # /next should still return the row because end_state is 'scheduled'
        nxt = api_client.get(
            f"{base_url}/api/shift-alarm/next", headers=auth["headers"]
        ).json()
        assert nxt.get("id") == row["id"]
        assert nxt.get("state") == "responded"
        assert nxt.get("end_state") == "scheduled"
