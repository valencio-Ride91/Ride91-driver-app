"""Part 7 — Go-Online Capture tests."""
import uuid
from datetime import datetime, timedelta, timezone

import pytest

pytestmark = pytest.mark.xdist_group("ride91_core")


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _today_day_key():
    ist = timezone(timedelta(hours=5, minutes=30))
    shifted = datetime.now(timezone.utc).astimezone(ist) - timedelta(hours=4)
    return shifted.strftime("%Y-%m-%d")


# Hub location per seed: Koramangala Hub (12.9352, 77.6245).
HUB_LAT = 12.9352
HUB_LNG = 77.6245

VIDEO_B64 = "data:video/mp4;base64," + ("A" * 128)
SELFIE_B64 = "data:image/jpeg;base64," + ("B" * 128)


def _valid_body(cid: str, start_lat=HUB_LAT, start_lng=HUB_LNG,
                end_lat=HUB_LAT, end_lng=HUB_LNG, duration_s=20):
    now = datetime.now(timezone.utc)
    return {
        "walkaround_video_b64": VIDEO_B64,
        "walkaround_video_mime": "video/mp4",
        "selfie_photo_b64": SELFIE_B64,
        "walkaround_started_at": _iso(now - timedelta(seconds=duration_s)),
        "walkaround_ended_at": _iso(now),
        "start_lat": start_lat,
        "start_lng": start_lng,
        "end_lat": end_lat,
        "end_lng": end_lng,
        "client_action_id": cid,
    }


class TestGoOnlineCapture:

    @pytest.fixture(autouse=True)
    def _wipe_today(self, mongo_db, auth):
        did = auth["driver"]["id"]
        dk = _today_day_key()
        mongo_db.go_online_captures.delete_many(
            {"driver_id": did, "day_key": dk}
        )
        yield
        mongo_db.go_online_captures.delete_many(
            {"driver_id": did, "day_key": dk}
        )

    def test_today_before_capture(self, api_client, base_url, auth):
        r = api_client.get(
            f"{base_url}/api/go-online-capture/today", headers=auth["headers"]
        )
        assert r.status_code == 200
        body = r.json()
        assert body["completed"] is False
        assert body["day_key"] == _today_day_key()

    def test_valid_capture_success(self, api_client, base_url, auth):
        r = api_client.post(
            f"{base_url}/api/go-online-capture",
            json=_valid_body(str(uuid.uuid4())),
            headers=auth["headers"],
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["completed"] is True
        assert body["hub_warn"] is False
        assert body["review_flag_movement"] is False
        assert body["distance_from_hub_km"] is not None
        assert body["distance_from_hub_km"] < 0.1  # essentially at hub
        assert "walkaround_video_b64" not in body
        assert "selfie_photo_b64" not in body

    def test_duration_out_of_range(self, api_client, base_url, auth):
        r = api_client.post(
            f"{base_url}/api/go-online-capture",
            json=_valid_body(str(uuid.uuid4()), duration_s=5),
            headers=auth["headers"],
        )
        assert r.status_code == 400
        assert r.json().get("detail") == "duration_out_of_range"

    def test_too_far_from_hub_403(self, api_client, base_url, auth):
        # Mumbai coords — ~840 km from Bengaluru hub → hard block.
        r = api_client.post(
            f"{base_url}/api/go-online-capture",
            json=_valid_body(
                str(uuid.uuid4()),
                start_lat=19.076, start_lng=72.877,
                end_lat=19.076, end_lng=72.877,
            ),
            headers=auth["headers"],
        )
        assert r.status_code == 403
        detail = r.json().get("detail")
        assert isinstance(detail, dict)
        assert detail.get("code") == "too_far_from_hub"
        assert "hub_km" in detail and "limit_km" in detail
        assert detail["hub_km"] > detail["limit_km"]

    def test_idempotent_by_client_action_id(
        self, api_client, base_url, auth, mongo_db
    ):
        did = auth["driver"]["id"]
        cid = str(uuid.uuid4())
        body = _valid_body(cid)
        r1 = api_client.post(
            f"{base_url}/api/go-online-capture", json=body, headers=auth["headers"]
        )
        r2 = api_client.post(
            f"{base_url}/api/go-online-capture", json=body, headers=auth["headers"]
        )
        assert r1.status_code == 200 and r2.status_code == 200
        assert r1.json()["id"] == r2.json()["id"]
        count = mongo_db.go_online_captures.count_documents(
            {"driver_id": did, "client_action_id": cid}
        )
        assert count == 1

    def test_same_day_different_action_id_returns_existing(
        self, api_client, base_url, auth
    ):
        r1 = api_client.post(
            f"{base_url}/api/go-online-capture",
            json=_valid_body(str(uuid.uuid4())),
            headers=auth["headers"],
        )
        assert r1.status_code == 200, r1.text
        r2 = api_client.post(
            f"{base_url}/api/go-online-capture",
            json=_valid_body(str(uuid.uuid4())),
            headers=auth["headers"],
        )
        assert r2.status_code == 200, r2.text
        body = r2.json()
        assert body.get("already_done_today") is True
        assert body["id"] == r1.json()["id"]

    def test_today_after_capture_returns_meta(self, api_client, base_url, auth):
        # capture
        api_client.post(
            f"{base_url}/api/go-online-capture",
            json=_valid_body(str(uuid.uuid4())),
            headers=auth["headers"],
        )
        r = api_client.get(
            f"{base_url}/api/go-online-capture/today", headers=auth["headers"]
        )
        assert r.status_code == 200
        body = r.json()
        assert body["completed"] is True
        assert body["day_key"] == _today_day_key()
        assert "walkaround_video_b64" not in body
        assert "selfie_photo_b64" not in body
        # meta present
        assert "duration_s" in body
        assert "distance_from_hub_km" in body
