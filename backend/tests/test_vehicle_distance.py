"""Part 6 — Vehicle GPS distance calculation tests.

Endpoint: GET /api/vehicles/{vehicle_id}/distance
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest

pytestmark = pytest.mark.xdist_group("ride91_core")


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


class TestVehicleDistance:
    """Filtered driven-distance endpoint. Isolated by using a far-future window."""

    # Use a synthetic future window so we don't collide with seed data.
    WINDOW_START = datetime(2099, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

    @pytest.fixture(autouse=True)
    def _cleanup(self, mongo_db, auth):
        """Wipe any synthetic pings in the future window between tests."""
        vid = auth["driver"]["vehicle_id"]
        end = self.WINDOW_START + timedelta(days=1)
        mongo_db.vehicle_pings.delete_many(
            {
                "vehicle_id": vid,
                "recorded_at": {
                    "$gte": _iso(self.WINDOW_START),
                    "$lt": _iso(end),
                },
            }
        )
        yield
        mongo_db.vehicle_pings.delete_many(
            {
                "vehicle_id": vid,
                "recorded_at": {
                    "$gte": _iso(self.WINDOW_START),
                    "$lt": _iso(end),
                },
            }
        )

    def _ingest(self, api_client, base_url, vehicle_id, offset_s, lat, lng,
                accuracy_m=10.0, speed_kmph=20.0):
        ts = self.WINDOW_START + timedelta(seconds=offset_s)
        r = api_client.post(
            f"{base_url}/api/vehicles/pings/ingest",
            json={
                "vehicle_id": vehicle_id,
                "recorded_at": _iso(ts),
                "lat": lat,
                "lng": lng,
                "speed_kmph": speed_kmph,
                "ignition": True,
                "accuracy_m": accuracy_m,
            },
        )
        assert r.status_code == 200, r.text

    def _distance(self, api_client, base_url, auth, from_dt=None, to_dt=None):
        vid = auth["driver"]["vehicle_id"]
        params = {
            "from_iso": _iso(from_dt or self.WINDOW_START),
            "to_iso": _iso(to_dt or (self.WINDOW_START + timedelta(days=1))),
        }
        r = api_client.get(
            f"{base_url}/api/vehicles/{vid}/distance",
            params=params,
            headers=auth["headers"],
        )
        assert r.status_code == 200, r.text
        return r.json()

    # ~50m east step ≈ 0.00045 deg lng at Bengaluru latitude (~cos(13°)).
    LAT0 = 12.9716
    LNG0 = 77.5946
    STEP_LNG_50M = 0.000462  # ~50 m

    # 1) Three clean pings 60s apart, ~50m each → points_kept=3, distance≈0.1km.
    def test_three_clean_pings(self, api_client, base_url, auth):
        vid = auth["driver"]["vehicle_id"]
        for i in range(3):
            self._ingest(
                api_client, base_url, vid,
                offset_s=i * 60,
                lat=self.LAT0,
                lng=self.LNG0 + i * self.STEP_LNG_50M,
            )
        stats = self._distance(api_client, base_url, auth)
        assert stats["points_kept"] == 3
        assert stats["points_rejected_accuracy"] == 0
        assert stats["points_rejected_speed"] == 0
        assert stats["segments_rejected_teleport"] == 0
        assert stats["segments_rejected_gap"] == 0
        assert 0.07 <= stats["distance_km"] <= 0.13, stats

    # 2) One bad accuracy ping amidst 3 clean → points_rejected_accuracy=1, kept=3.
    def test_accuracy_reject(self, api_client, base_url, auth):
        vid = auth["driver"]["vehicle_id"]
        # 3 clean
        for i in range(3):
            self._ingest(
                api_client, base_url, vid,
                offset_s=i * 60,
                lat=self.LAT0,
                lng=self.LNG0 + i * self.STEP_LNG_50M,
            )
        # 1 bad accuracy in the middle window
        self._ingest(
            api_client, base_url, vid,
            offset_s=30,
            lat=self.LAT0 + 0.001,
            lng=self.LNG0,
            accuracy_m=45.0,
        )
        stats = self._distance(api_client, base_url, auth)
        assert stats["points_rejected_accuracy"] == 1
        assert stats["points_kept"] == 3

    # 3) One high-speed ping → points_rejected_speed=1.
    def test_speed_reject(self, api_client, base_url, auth):
        vid = auth["driver"]["vehicle_id"]
        for i in range(3):
            self._ingest(
                api_client, base_url, vid,
                offset_s=i * 60,
                lat=self.LAT0,
                lng=self.LNG0 + i * self.STEP_LNG_50M,
            )
        self._ingest(
            api_client, base_url, vid,
            offset_s=30,
            lat=self.LAT0,
            lng=self.LNG0 + 0.0002,
            speed_kmph=180.0,
        )
        stats = self._distance(api_client, base_url, auth)
        assert stats["points_rejected_speed"] == 1

    # 4) 2 pings 60s apart, ~3km apart → implied ~180 kmph → teleport reject.
    def test_teleport_reject(self, api_client, base_url, auth):
        vid = auth["driver"]["vehicle_id"]
        self._ingest(
            api_client, base_url, vid,
            offset_s=0, lat=self.LAT0, lng=self.LNG0,
        )
        # ~3km east: 3km / (111km * cos(13°)) ≈ 0.0277 deg lng
        self._ingest(
            api_client, base_url, vid,
            offset_s=60, lat=self.LAT0, lng=self.LNG0 + 0.0277,
        )
        stats = self._distance(api_client, base_url, auth)
        assert stats["segments_rejected_teleport"] == 1
        assert stats["distance_km"] == 0.0

    # 5) 2 pings 10 minutes apart → gap reject.
    def test_gap_reject(self, api_client, base_url, auth):
        vid = auth["driver"]["vehicle_id"]
        self._ingest(
            api_client, base_url, vid,
            offset_s=0, lat=self.LAT0, lng=self.LNG0,
        )
        self._ingest(
            api_client, base_url, vid,
            offset_s=600, lat=self.LAT0, lng=self.LNG0 + self.STEP_LNG_50M,
        )
        stats = self._distance(api_client, base_url, auth)
        assert stats["segments_rejected_gap"] == 1
        assert stats["distance_km"] == 0.0

    # 6) 403 for a different vehicle_id.
    def test_other_vehicle_forbidden(self, api_client, base_url, auth):
        r = api_client.get(
            f"{base_url}/api/vehicles/some-other-vehicle-id/distance",
            headers=auth["headers"],
        )
        assert r.status_code == 403
        assert r.json().get("detail") == "not_your_vehicle"

    # 7) Regression: seeded data at 2026-08-08 has non-zero distance.
    def test_seeded_2026_08_08_nonzero(self, api_client, base_url, auth):
        vid = auth["driver"]["vehicle_id"]
        r = api_client.get(
            f"{base_url}/api/vehicles/{vid}/distance",
            params={"business_date": "2026-08-08"},
            headers=auth["headers"],
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["distance_km"] > 0, body
        assert body["points_kept"] > 0
