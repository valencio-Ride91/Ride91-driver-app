"""Ride91 backend — Part 8 Shift Alarm endpoint tests (iteration 5).

Endpoints covered:
- POST /api/shift-alarm/schedule  (idempotent, alarm_fires_at = shift_start - 1h)
- GET  /api/shift-alarm/next      (earliest scheduled|no_response or {} )
- POST /api/shift-alarm/response  (reason gate for not_coming, idempotent,
                                   flips schedule state to 'responded')
- GET  /api/shift-alarm/responses (newest first)
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest


# Keep every class in this module on the same xdist worker so per-test
# cleanups on the shared demo-driver's shift_schedules don't race across
# workers.
pytestmark = pytest.mark.xdist_group("shift_alarm")


ALLOWED_REASONS = {
    "unwell", "family_emergency", "vehicle_problem",
    "transport_problem", "personal", "other",
}


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


@pytest.fixture(scope="module", autouse=True)
def _wipe_alarm_state(auth, mongo_db):
    """Clear the demo driver's shift alarm state before this module runs
    and after it finishes so we don't pollute the next iteration."""
    did = auth["driver"]["id"]
    mongo_db.shift_schedules.delete_many({"driver_id": did})
    mongo_db.alarm_responses.delete_many({"driver_id": did})
    yield
    mongo_db.shift_schedules.delete_many({"driver_id": did})
    mongo_db.alarm_responses.delete_many({"driver_id": did})


# ---------------------------------------------------------------------------
# schedule endpoint
# ---------------------------------------------------------------------------
class TestScheduleAlarm:
    def test_schedule_creates_row_and_alarm_fires_at_1h_before(
        self, api_client, base_url, auth
    ):
        shift = datetime.now(timezone.utc) + timedelta(hours=3)
        cid = str(uuid.uuid4())
        r = api_client.post(
            f"{base_url}/api/shift-alarm/schedule",
            json={
                "shift_start": _iso(shift),
                "shift_type": "day",
                "client_action_id": cid,
            },
            headers=auth["headers"],
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["id"]
        assert body["driver_id"] == auth["driver"]["id"]
        assert body["state"] == "scheduled"
        assert body["shift_type"] == "day"
        # alarm_fires_at should be shift_start - 1h (allow 2s tolerance)
        parsed_shift = datetime.fromisoformat(
            body["shift_start"].replace("Z", "+00:00")
        )
        parsed_alarm = datetime.fromisoformat(
            body["alarm_fires_at"].replace("Z", "+00:00")
        )
        delta = (parsed_shift - parsed_alarm).total_seconds()
        assert 3595 <= delta <= 3605, f"alarm not exactly 1h before shift: {delta}s"

    def test_schedule_is_idempotent_on_client_action_id(
        self, api_client, base_url, auth
    ):
        shift = datetime.now(timezone.utc) + timedelta(hours=4)
        cid = str(uuid.uuid4())
        payload = {
            "shift_start": _iso(shift),
            "shift_type": "night",
            "client_action_id": cid,
        }
        r1 = api_client.post(
            f"{base_url}/api/shift-alarm/schedule",
            json=payload,
            headers=auth["headers"],
        )
        r2 = api_client.post(
            f"{base_url}/api/shift-alarm/schedule",
            json=payload,
            headers=auth["headers"],
        )
        assert r1.status_code == 200 and r2.status_code == 200
        assert r1.json()["id"] == r2.json()["id"], "not idempotent"

    def test_schedule_requires_auth(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/shift-alarm/schedule",
            json={
                "shift_start": _iso(datetime.now(timezone.utc) + timedelta(hours=3)),
                "shift_type": "day",
                "client_action_id": str(uuid.uuid4()),
            },
        )
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# next endpoint
# ---------------------------------------------------------------------------
class TestNextAlarm:
    def test_next_returns_earliest_scheduled(
        self, api_client, base_url, auth, mongo_db
    ):
        # Clean and seed two rows so we can assert ordering
        did = auth["driver"]["id"]
        mongo_db.shift_schedules.delete_many({"driver_id": did})
        early = datetime.now(timezone.utc) + timedelta(hours=2)
        late = datetime.now(timezone.utc) + timedelta(hours=6)
        for start in (late, early):  # insert out of order
            api_client.post(
                f"{base_url}/api/shift-alarm/schedule",
                json={
                    "shift_start": _iso(start),
                    "shift_type": "day",
                    "client_action_id": str(uuid.uuid4()),
                },
                headers=auth["headers"],
            )
        r = api_client.get(
            f"{base_url}/api/shift-alarm/next", headers=auth["headers"]
        )
        assert r.status_code == 200
        body = r.json()
        assert body.get("id"), f"empty next: {body}"
        parsed = datetime.fromisoformat(
            body["shift_start"].replace("Z", "+00:00")
        )
        # It must be the earlier one (within 5s of `early`)
        assert abs((parsed - early).total_seconds()) < 5

    def test_next_returns_empty_when_all_responded(
        self, api_client, base_url, auth, mongo_db
    ):
        did = auth["driver"]["id"]
        mongo_db.shift_schedules.delete_many({"driver_id": did})
        mongo_db.alarm_responses.delete_many({"driver_id": did})
        # No rows -> should return {}
        r = api_client.get(
            f"{base_url}/api/shift-alarm/next", headers=auth["headers"]
        )
        assert r.status_code == 200
        assert r.json() == {}


# ---------------------------------------------------------------------------
# response endpoint
# ---------------------------------------------------------------------------
class TestAlarmResponse:
    def _seed_schedule(self, api_client, base_url, auth) -> str:
        shift = datetime.now(timezone.utc) + timedelta(hours=3)
        r = api_client.post(
            f"{base_url}/api/shift-alarm/schedule",
            json={
                "shift_start": _iso(shift),
                "shift_type": "day",
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r.status_code == 200
        return r.json()["id"]

    def test_not_coming_without_reason_400(
        self, api_client, base_url, auth
    ):
        sid = self._seed_schedule(api_client, base_url, auth)
        r = api_client.post(
            f"{base_url}/api/shift-alarm/response",
            json={
                "schedule_id": sid,
                "response": "not_coming",
                # reason_code omitted
                "fired_at": _iso(datetime.now(timezone.utc)),
                "responded_at": _iso(datetime.now(timezone.utc)),
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r.status_code == 400
        assert r.json().get("detail") == "reason_required"

    def test_not_coming_bad_reason_400(self, api_client, base_url, auth):
        sid = self._seed_schedule(api_client, base_url, auth)
        r = api_client.post(
            f"{base_url}/api/shift-alarm/response",
            json={
                "schedule_id": sid,
                "response": "not_coming",
                "reason_code": "hangover",  # not in whitelist
                "fired_at": _iso(datetime.now(timezone.utc)),
                "responded_at": _iso(datetime.now(timezone.utc)),
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r.status_code == 400
        assert r.json().get("detail") == "reason_required"

    def test_awake_flips_schedule_state_to_responded(
        self, api_client, base_url, auth, mongo_db
    ):
        did = auth["driver"]["id"]
        mongo_db.shift_schedules.delete_many({"driver_id": did})
        mongo_db.alarm_responses.delete_many({"driver_id": did})
        sid = self._seed_schedule(api_client, base_url, auth)
        r = api_client.post(
            f"{base_url}/api/shift-alarm/response",
            json={
                "schedule_id": sid,
                "response": "awake",
                "fired_at": _iso(datetime.now(timezone.utc)),
                "responded_at": _iso(datetime.now(timezone.utc)),
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r.status_code == 200, r.text
        assert r.json()["response"] == "awake"
        # /next should now be empty since the only row is responded
        nxt = api_client.get(
            f"{base_url}/api/shift-alarm/next", headers=auth["headers"]
        ).json()
        assert nxt == {}, f"schedule state didn't flip: {nxt}"

    def test_not_coming_with_reason_flips_state(
        self, api_client, base_url, auth, mongo_db
    ):
        did = auth["driver"]["id"]
        mongo_db.shift_schedules.delete_many({"driver_id": did})
        mongo_db.alarm_responses.delete_many({"driver_id": did})
        sid = self._seed_schedule(api_client, base_url, auth)
        r = api_client.post(
            f"{base_url}/api/shift-alarm/response",
            json={
                "schedule_id": sid,
                "response": "not_coming",
                "reason_code": "unwell",
                "fired_at": _iso(datetime.now(timezone.utc)),
                "responded_at": _iso(datetime.now(timezone.utc)),
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r.status_code == 200, r.text
        # schedule row must now be 'responded'
        row = mongo_db.shift_schedules.find_one({"id": sid}, {"_id": 0})
        assert row["state"] == "responded"

    def test_response_idempotent_on_client_action_id(
        self, api_client, base_url, auth, mongo_db
    ):
        did = auth["driver"]["id"]
        mongo_db.shift_schedules.delete_many({"driver_id": did})
        mongo_db.alarm_responses.delete_many({"driver_id": did})
        sid = self._seed_schedule(api_client, base_url, auth)
        cid = str(uuid.uuid4())
        payload = {
            "schedule_id": sid,
            "response": "awake",
            "fired_at": _iso(datetime.now(timezone.utc)),
            "responded_at": _iso(datetime.now(timezone.utc)),
            "client_action_id": cid,
        }
        r1 = api_client.post(
            f"{base_url}/api/shift-alarm/response",
            json=payload,
            headers=auth["headers"],
        )
        r2 = api_client.post(
            f"{base_url}/api/shift-alarm/response",
            json=payload,
            headers=auth["headers"],
        )
        assert r1.status_code == 200 and r2.status_code == 200
        assert r1.json()["id"] == r2.json()["id"]

    def test_snooze_does_not_flip_state(
        self, api_client, base_url, auth, mongo_db
    ):
        did = auth["driver"]["id"]
        mongo_db.shift_schedules.delete_many({"driver_id": did})
        mongo_db.alarm_responses.delete_many({"driver_id": did})
        sid = self._seed_schedule(api_client, base_url, auth)
        r = api_client.post(
            f"{base_url}/api/shift-alarm/response",
            json={
                "schedule_id": sid,
                "response": "snooze",
                "fired_at": _iso(datetime.now(timezone.utc)),
                "responded_at": _iso(datetime.now(timezone.utc)),
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r.status_code == 200
        row = mongo_db.shift_schedules.find_one({"id": sid}, {"_id": 0})
        assert row["state"] == "scheduled"


# ---------------------------------------------------------------------------
# responses listing
# ---------------------------------------------------------------------------
class TestListResponses:
    def test_returns_newest_first(self, api_client, base_url, auth, mongo_db):
        did = auth["driver"]["id"]
        mongo_db.shift_schedules.delete_many({"driver_id": did})
        mongo_db.alarm_responses.delete_many({"driver_id": did})
        # Seed two schedules with different responded_at timestamps
        for h in (3, 5):
            shift = datetime.now(timezone.utc) + timedelta(hours=h)
            r_s = api_client.post(
                f"{base_url}/api/shift-alarm/schedule",
                json={
                    "shift_start": _iso(shift),
                    "shift_type": "day",
                    "client_action_id": str(uuid.uuid4()),
                },
                headers=auth["headers"],
            ).json()
            api_client.post(
                f"{base_url}/api/shift-alarm/response",
                json={
                    "schedule_id": r_s["id"],
                    "response": "awake",
                    "fired_at": _iso(datetime.now(timezone.utc)),
                    "responded_at": _iso(datetime.now(timezone.utc) - timedelta(minutes=(5 - h))),
                    "client_action_id": str(uuid.uuid4()),
                },
                headers=auth["headers"],
            )
        r = api_client.get(
            f"{base_url}/api/shift-alarm/responses", headers=auth["headers"]
        )
        assert r.status_code == 200
        items = r.json().get("items", [])
        assert len(items) >= 2
        ts = [it["responded_at"] for it in items]
        assert ts == sorted(ts, reverse=True), f"not newest-first: {ts}"
