"""Part 9 — Documents + Consents tests."""
import uuid
from datetime import datetime, timedelta, timezone

import pytest

pytestmark = pytest.mark.xdist_group("ride91_core")

DOCUMENT_TYPES = {
    "driving_licence", "vehicle_rc", "insurance", "puc",
    "permit", "aadhaar", "pan",
}


def _today_ist():
    ist = timezone(timedelta(hours=5, minutes=30))
    return datetime.now(timezone.utc).astimezone(ist).date()


class TestDocuments:
    @pytest.fixture(autouse=True, scope="class")
    def _wipe(self, mongo_db, auth):
        """Start each test class run from a clean documents state."""
        did = auth["driver"]["id"]
        mongo_db.documents.delete_many({"driver_id": did})
        yield
        mongo_db.documents.delete_many({"driver_id": did})

    def test_get_seeds_7_rows(self, api_client, base_url, auth):
        r = api_client.get(f"{base_url}/api/documents", headers=auth["headers"])
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) == 7
        types = {i["type"] for i in items}
        assert types == DOCUMENT_TYPES
        for i in items:
            assert i["status"] == "missing"
            assert i["verified"] is False
            assert "image_b64" not in i
            assert i.get("expires_on") in (None,)

    def test_get_idempotent(self, api_client, base_url, auth):
        r = api_client.get(f"{base_url}/api/documents", headers=auth["headers"])
        assert len(r.json()["items"]) == 7

    def test_upsert_expiring_soon_and_persistence(
        self, api_client, base_url, auth
    ):
        exp = (_today_ist() + timedelta(days=15)).strftime("%Y-%m-%d")
        r = api_client.post(
            f"{base_url}/api/documents",
            json={
                "type": "driving_licence",
                "number": "KA0120200001234",
                "expires_on": exp,
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r.status_code == 200, r.text
        row = r.json()
        assert row["status"] == "expiring_soon"
        assert row["number"] == "KA0120200001234"
        assert row["expires_on"] == exp
        # Verify GET reflects update AND still returns 7 rows (upsert).
        g = api_client.get(f"{base_url}/api/documents", headers=auth["headers"])
        items = g.json()["items"]
        assert len(items) == 7
        dl = next(i for i in items if i["type"] == "driving_licence")
        assert dl["status"] == "expiring_soon"
        assert dl["expires_on"] == exp

    def test_upsert_expired_status(self, api_client, base_url, auth):
        exp = (_today_ist() - timedelta(days=5)).strftime("%Y-%m-%d")
        r = api_client.post(
            f"{base_url}/api/documents",
            json={"type": "insurance", "expires_on": exp,
                  "client_action_id": str(uuid.uuid4())},
            headers=auth["headers"],
        )
        assert r.status_code == 200
        assert r.json()["status"] == "expired"

    def test_upsert_ok_status(self, api_client, base_url, auth):
        exp = (_today_ist() + timedelta(days=120)).strftime("%Y-%m-%d")
        r = api_client.post(
            f"{base_url}/api/documents",
            json={"type": "puc", "expires_on": exp,
                  "client_action_id": str(uuid.uuid4())},
            headers=auth["headers"],
        )
        assert r.status_code == 200
        assert r.json()["status"] == "ok"

    def test_upsert_idempotent_client_action_id(
        self, api_client, base_url, auth, mongo_db
    ):
        did = auth["driver"]["id"]
        cid = str(uuid.uuid4())
        exp = (_today_ist() + timedelta(days=60)).strftime("%Y-%m-%d")
        payload = {
            "type": "aadhaar",
            "number": "1111-2222-3333",
            "expires_on": exp,
            "client_action_id": cid,
        }
        r1 = api_client.post(
            f"{base_url}/api/documents", json=payload, headers=auth["headers"]
        )
        r2 = api_client.post(
            f"{base_url}/api/documents", json=payload, headers=auth["headers"]
        )
        assert r1.status_code == 200 and r2.status_code == 200
        assert r1.json()["id"] == r2.json()["id"]
        assert r1.json()["number"] == r2.json()["number"]
        # No duplicate insert
        assert mongo_db.documents.count_documents(
            {"driver_id": did, "type": "aadhaar"}
        ) == 1

    def test_upsert_invalid_expires_on_400(self, api_client, base_url, auth):
        r = api_client.post(
            f"{base_url}/api/documents",
            json={
                "type": "pan",
                "expires_on": "invalid",
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r.status_code == 400
        assert r.json().get("detail") == "expires_on_must_be_yyyy_mm_dd"

    def test_expiring_summary_counts(self, api_client, base_url, auth):
        r = api_client.get(
            f"{base_url}/api/documents/expiring/summary", headers=auth["headers"]
        )
        assert r.status_code == 200
        body = r.json()
        for k in ("expired", "expiring_soon", "ok", "missing", "needs_attention"):
            assert k in body
        assert body["needs_attention"] == (
            body["expired"] + body["expiring_soon"] + body["missing"]
        )
        # After earlier tests: expiring_soon>=1 (DL), expired>=1 (insurance), ok>=1 (puc)
        assert body["expiring_soon"] >= 1
        assert body["expired"] >= 1
        assert body["ok"] >= 1

    def test_get_document_own_and_stranger(
        self, api_client, base_url, auth, mongo_db
    ):
        # Own doc
        items = api_client.get(
            f"{base_url}/api/documents", headers=auth["headers"]
        ).json()["items"]
        my_id = items[0]["id"]
        r = api_client.get(
            f"{base_url}/api/documents/{my_id}", headers=auth["headers"]
        )
        assert r.status_code == 200
        assert r.json()["id"] == my_id
        # Someone else's doc
        stranger_id = str(uuid.uuid4())
        mongo_db.documents.insert_one({
            "id": stranger_id,
            "driver_id": "not-me",
            "type": "aadhaar",
            "number": "X", "expires_on": None, "image_b64": None,
            "verified": False,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })
        r2 = api_client.get(
            f"{base_url}/api/documents/{stranger_id}", headers=auth["headers"]
        )
        assert r2.status_code == 404
        mongo_db.documents.delete_one({"id": stranger_id})


class TestConsents:
    @pytest.fixture(autouse=True, scope="class")
    def _wipe(self, mongo_db, auth):
        did = auth["driver"]["id"]
        mongo_db.consent_events.delete_many({"driver_id": did})
        yield
        mongo_db.consent_events.delete_many({"driver_id": did})

    def test_get_5_ungranted(self, api_client, base_url, auth):
        r = api_client.get(f"{base_url}/api/consents", headers=auth["headers"])
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) == 5
        for i in items:
            assert i["granted"] is False
            assert i["last_change_at"] is None

    def test_grant_and_withdraw(self, api_client, base_url, auth):
        # Grant
        r1 = api_client.post(
            f"{base_url}/api/consents",
            json={
                "kind": "location_tracking",
                "granted": True,
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r1.status_code == 200
        loc = next(i for i in r1.json()["items"] if i["kind"] == "location_tracking")
        assert loc["granted"] is True
        assert loc["last_change_at"] is not None

        # GET reflects it
        g = api_client.get(f"{base_url}/api/consents", headers=auth["headers"]).json()
        loc_g = next(i for i in g["items"] if i["kind"] == "location_tracking")
        assert loc_g["granted"] is True

        # Withdraw
        r2 = api_client.post(
            f"{base_url}/api/consents",
            json={
                "kind": "location_tracking",
                "granted": False,
                "client_action_id": str(uuid.uuid4()),
            },
            headers=auth["headers"],
        )
        assert r2.status_code == 200
        loc2 = next(i for i in r2.json()["items"] if i["kind"] == "location_tracking")
        assert loc2["granted"] is False

        # History newest-first
        h = api_client.get(
            f"{base_url}/api/consents/history", headers=auth["headers"]
        )
        assert h.status_code == 200
        events = h.json()["items"]
        loc_events = [e for e in events if e["kind"] == "location_tracking"]
        assert len(loc_events) >= 2
        assert loc_events[0]["granted"] is False
        assert loc_events[1]["granted"] is True
        # newest-first ordering
        assert loc_events[0]["occurred_at"] >= loc_events[1]["occurred_at"]

    def test_consents_idempotent(self, api_client, base_url, auth, mongo_db):
        did = auth["driver"]["id"]
        cid = str(uuid.uuid4())
        payload = {
            "kind": "communications",
            "granted": True,
            "client_action_id": cid,
        }
        before = mongo_db.consent_events.count_documents(
            {"driver_id": did, "client_action_id": cid}
        )
        assert before == 0
        api_client.post(
            f"{base_url}/api/consents", json=payload, headers=auth["headers"]
        )
        api_client.post(
            f"{base_url}/api/consents", json=payload, headers=auth["headers"]
        )
        after = mongo_db.consent_events.count_documents(
            {"driver_id": did, "client_action_id": cid}
        )
        assert after == 1
