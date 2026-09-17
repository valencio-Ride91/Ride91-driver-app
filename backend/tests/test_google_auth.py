"""Ride91 backend — Google (Emergent OAuth) sign-in tests (iteration 8).

Covers /api/auth/session, /api/auth/session/link/start, /api/auth/session/link/verify
and /api/auth/logout, plus get_driver invariants (OTP no-expiry, Google TTL,
session_expired path) and OTP-flow regression.

We cannot server-side-monkeypatch httpx here since tests run out-of-process
against the live backend. To exercise the "successful Emergent exchange"
branches we directly seed the `pending_google_links` collection (that's the
row the endpoint would have written after a real 200 exchange). For the
`/auth/session` endpoint we cover the two 401 branches that don't require
OAuth mocking:
  - session_id_already_used (via a seeded `consumed_google_sessions` row)
  - session_id_invalid       (via letting the real Emergent call return non-200)
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest


pytestmark = pytest.mark.xdist_group("ride91_core")


DEMO_PHONE = "+919900000001"
DEMO_OTP = "123456"


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _seed_pending_link(mongo_db, *, email: str, minutes_to_expire: int = 10, picture: str = "http://p/x.png", name: str = "Test User") -> str:
    token = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    mongo_db.pending_google_links.insert_one(
        {
            "link_token": token,
            "email": email.strip().lower(),
            "name": name,
            "picture": picture,
            "created_at": _iso(now),
            "expires_at": _iso(now + timedelta(minutes=minutes_to_expire)),
        }
    )
    return token


@pytest.fixture(autouse=True)
def _reset_driver_google_state(auth, mongo_db):
    """Ensure the demo driver starts each test with no google_email bound,
    and that no stray pending_google_links / consumed_google_sessions rows
    leak between tests. We only touch demo-owned rows so parallel tests on
    other drivers are unaffected."""
    did = auth["driver"]["id"]
    mongo_db.drivers.update_one(
        {"id": did},
        {"$unset": {"google_email": "", "google_picture_url": "", "google_linked_at": ""}},
    )
    mongo_db.pending_google_links.delete_many({})
    mongo_db.consumed_google_sessions.delete_many({})
    # Wipe stray "TEST_" drivers left by prior interrupted runs.
    mongo_db.drivers.delete_many({"phone": "+919000000099"})
    yield
    mongo_db.drivers.update_one(
        {"id": did},
        {"$unset": {"google_email": "", "google_picture_url": "", "google_linked_at": ""}},
    )
    mongo_db.pending_google_links.delete_many({})
    mongo_db.consumed_google_sessions.delete_many({})
    mongo_db.drivers.delete_many({"phone": "+919000000099"})


class TestGoogleAuth:
    # ------------------------------------------------------------------
    # /auth/session — 401 paths
    # ------------------------------------------------------------------
    def test_session_bad_session_id_returns_401(self, api_client, base_url):
        """Random session_id lets the real Emergent call 401 → session_id_invalid."""
        r = api_client.post(
            f"{base_url}/api/auth/session",
            json={"session_id": f"bogus-{uuid.uuid4()}"},
        )
        assert r.status_code == 401, r.text
        # Either 'session_id_invalid' (Emergent said non-200) or
        # 'oauth_exchange_failed' (Emergent connect error). Both are 401.
        detail = r.json().get("detail")
        assert detail in {"session_id_invalid", "oauth_exchange_failed"}, detail

    def test_session_id_already_used_returns_401(
        self, api_client, base_url, mongo_db
    ):
        sid = f"consumed-{uuid.uuid4()}"
        mongo_db.consumed_google_sessions.insert_one(
            {"session_id": sid, "consumed_at": _iso(datetime.now(timezone.utc))}
        )
        r = api_client.post(
            f"{base_url}/api/auth/session", json={"session_id": sid}
        )
        assert r.status_code == 401
        assert r.json().get("detail") == "session_id_already_used"

    # ------------------------------------------------------------------
    # /auth/session/link/start — validation branches
    # ------------------------------------------------------------------
    def test_link_start_invalid_link_token(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/auth/session/link/start",
            json={"link_token": f"nope-{uuid.uuid4()}", "phone": DEMO_PHONE},
        )
        assert r.status_code == 401
        assert r.json().get("detail") == "link_token_invalid"

    def test_link_start_expired_link_token(self, api_client, base_url, mongo_db):
        token = str(uuid.uuid4())
        past = datetime.now(timezone.utc) - timedelta(minutes=1)
        mongo_db.pending_google_links.insert_one(
            {
                "link_token": token,
                "email": "expired@test.local",
                "name": "T",
                "picture": None,
                "created_at": _iso(past - timedelta(minutes=10)),
                "expires_at": _iso(past),
            }
        )
        r = api_client.post(
            f"{base_url}/api/auth/session/link/start",
            json={"link_token": token, "phone": DEMO_PHONE},
        )
        assert r.status_code == 401
        assert r.json().get("detail") == "link_token_expired"
        # Endpoint should have deleted the expired row.
        assert mongo_db.pending_google_links.find_one({"link_token": token}) is None

    def test_link_start_phone_not_registered(
        self, api_client, base_url, mongo_db
    ):
        token = _seed_pending_link(mongo_db, email="new@test.local")
        r = api_client.post(
            f"{base_url}/api/auth/session/link/start",
            json={"link_token": token, "phone": "+919000000099"},
        )
        assert r.status_code == 404
        assert r.json().get("detail") == "driver_not_registered"

    def test_link_start_phone_linked_to_different_google(
        self, api_client, base_url, auth, mongo_db
    ):
        # Force a different google_email on the demo driver
        mongo_db.drivers.update_one(
            {"id": auth["driver"]["id"]},
            {"$set": {"google_email": "someone.else@test.local"}},
        )
        token = _seed_pending_link(mongo_db, email="new@test.local")
        r = api_client.post(
            f"{base_url}/api/auth/session/link/start",
            json={"link_token": token, "phone": DEMO_PHONE},
        )
        assert r.status_code == 409
        assert r.json().get("detail") == "phone_linked_to_different_google"

    def test_link_start_happy_path_writes_otp(
        self, api_client, base_url, mongo_db
    ):
        token = _seed_pending_link(mongo_db, email="happy@test.local")
        r = api_client.post(
            f"{base_url}/api/auth/session/link/start",
            json={"link_token": token, "phone": DEMO_PHONE},
        )
        assert r.status_code == 200, r.text
        assert r.json() == {"otp_sent": True}
        otp_row = mongo_db.otp_codes.find_one({"phone": DEMO_PHONE})
        assert otp_row is not None
        assert otp_row.get("code")  # any non-empty code (demo returns 123456)

    # ------------------------------------------------------------------
    # /auth/session/link/verify — validation branches + happy path
    # ------------------------------------------------------------------
    def test_link_verify_bad_otp(self, api_client, base_url, mongo_db):
        token = _seed_pending_link(mongo_db, email="v1@test.local")
        # Force the stored OTP to something other than DEMO_OTP so the
        # DEMO_OTP fallback ("any 123456 works") doesn't mask this.
        mongo_db.otp_codes.update_one(
            {"phone": DEMO_PHONE},
            {"$set": {"phone": DEMO_PHONE, "code": "999999"}},
            upsert=True,
        )
        r = api_client.post(
            f"{base_url}/api/auth/session/link/verify",
            json={
                "link_token": token,
                "phone": DEMO_PHONE,
                "code": "000000",
                "client_action_id": str(uuid.uuid4()),
            },
        )
        assert r.status_code == 400
        assert r.json().get("detail") == "bad_otp"

    def test_link_verify_google_bound_to_other_driver(
        self, api_client, base_url, auth, mongo_db
    ):
        # Create a second driver that already owns the target google_email
        other_email = "taken@test.local"
        mongo_db.drivers.insert_one(
            {
                "id": str(uuid.uuid4()),
                "name": "TEST Other",
                "phone": "+919000000099",
                "vehicle_id": auth["driver"]["vehicle_id"],
                "qr_code": "TEST_QR",
                "google_email": other_email,
            }
        )
        token = _seed_pending_link(mongo_db, email=other_email)
        r = api_client.post(
            f"{base_url}/api/auth/session/link/verify",
            json={
                "link_token": token,
                "phone": DEMO_PHONE,
                "code": DEMO_OTP,
                "client_action_id": str(uuid.uuid4()),
            },
        )
        assert r.status_code == 409
        assert r.json().get("detail") == "google_linked_to_other_driver"

    def test_link_verify_happy_path_and_idempotent(
        self, api_client, base_url, auth, mongo_db
    ):
        email = "linked@test.local"
        token = _seed_pending_link(mongo_db, email=email, picture="http://p/pic.png", name="Linked Person")
        cid = str(uuid.uuid4())
        payload = {
            "link_token": token,
            "phone": DEMO_PHONE,
            "code": DEMO_OTP,
            "client_action_id": cid,
        }
        before = datetime.now(timezone.utc)
        r1 = api_client.post(
            f"{base_url}/api/auth/session/link/verify", json=payload
        )
        assert r1.status_code == 200, r1.text
        j1 = r1.json()
        assert j1["needs_link"] is False
        assert j1["token"]
        assert j1["driver"]["google_email"] == email
        assert j1["driver"]["google_picture_url"] == "http://p/pic.png"

        # DB: driver.google_email set
        drv = mongo_db.drivers.find_one({"id": auth["driver"]["id"]}, {"_id": 0})
        assert drv["google_email"] == email
        # DB: sessions row present with source='google' and expires_at ~ now+7d
        sess = mongo_db.sessions.find_one({"token": j1["token"]}, {"_id": 0})
        assert sess is not None
        assert sess.get("source") == "google"
        assert sess.get("expires_at")
        exp = datetime.fromisoformat(sess["expires_at"].replace("Z", "+00:00"))
        target = before + timedelta(days=7)
        drift = abs((exp - target).total_seconds())
        assert drift < 120, f"expires_at drift too large: {drift}s"
        # DB: pending_google_links row deleted on success
        assert mongo_db.pending_google_links.find_one({"link_token": token}) is None

        # Idempotent replay with SAME client_action_id → same token, even
        # though the pending_google_links row was consumed by the first call.
        # (This is the stronger contract than a raw link_token replay: the
        # client_action_id lookup runs before we touch the link_token.)
        r2 = api_client.post(
            f"{base_url}/api/auth/session/link/verify", json=payload
        )
        assert r2.status_code == 200, r2.text
        assert r2.json()["token"] == j1["token"], "client_action_id should short-circuit"

        # A DIFFERENT client_action_id with the (now-consumed) link_token
        # correctly 401s — link tokens are single-use across clients.
        r_diff = api_client.post(
            f"{base_url}/api/auth/session/link/verify",
            json={**payload, "client_action_id": str(uuid.uuid4())},
        )
        assert r_diff.status_code == 401
        assert r_diff.json().get("detail") == "link_token_invalid"

        # A FRESH link_token for the same email + same client_action_id also
        # short-circuits on client_action_id → same session token.
        token2 = _seed_pending_link(mongo_db, email=email)
        r3 = api_client.post(
            f"{base_url}/api/auth/session/link/verify",
            json={**payload, "link_token": token2},
        )
        assert r3.status_code == 200, r3.text
        assert r3.json()["token"] == j1["token"], "client_action_id should return same token"

    # ------------------------------------------------------------------
    # /auth/logout
    # ------------------------------------------------------------------
    def test_logout_deletes_session_row(self, api_client, base_url, mongo_db):
        # Fresh OTP login (don't nuke the module-scoped `auth` fixture token).
        api_client.post(
            f"{base_url}/api/auth/otp/request", json={"phone": DEMO_PHONE}
        )
        r = api_client.post(
            f"{base_url}/api/auth/otp/verify",
            json={"phone": DEMO_PHONE, "code": DEMO_OTP, "client_action_id": str(uuid.uuid4())},
        )
        tok = r.json()["token"]
        assert mongo_db.sessions.find_one({"token": tok}) is not None
        lr = api_client.post(
            f"{base_url}/api/auth/logout",
            headers={"Authorization": f"Bearer {tok}"},
        )
        assert lr.status_code == 200, lr.text
        assert lr.json() == {"ok": True}
        assert mongo_db.sessions.find_one({"token": tok}) is None
        # Follow-up authed call must 401
        me = api_client.get(
            f"{base_url}/api/auth/me",
            headers={"Authorization": f"Bearer {tok}"},
        )
        assert me.status_code == 401

    # ------------------------------------------------------------------
    # get_driver invariants
    # ------------------------------------------------------------------
    def test_me_accepts_otp_token_without_expires_at(
        self, api_client, base_url, auth, mongo_db
    ):
        # `auth` fixture logged in via OTP; that session row must have NO expires_at.
        sess = mongo_db.sessions.find_one({"token": auth["token"]}, {"_id": 0})
        assert sess is not None
        assert "expires_at" not in sess or sess.get("expires_at") in (None, "")
        r = api_client.get(f"{base_url}/api/auth/me", headers=auth["headers"])
        assert r.status_code == 200, r.text
        assert r.json()["driver"]["phone"] == DEMO_PHONE

    def test_me_rejects_expired_google_session(
        self, api_client, base_url, auth, mongo_db
    ):
        # Insert a fake Google session that expired 1 minute ago.
        tok = str(uuid.uuid4())
        past = datetime.now(timezone.utc) - timedelta(minutes=1)
        mongo_db.sessions.insert_one(
            {
                "token": tok,
                "driver_id": auth["driver"]["id"],
                "source": "google",
                "created_at": _iso(past - timedelta(days=7)),
                "expires_at": _iso(past),
            }
        )
        r = api_client.get(
            f"{base_url}/api/auth/me", headers={"Authorization": f"Bearer {tok}"}
        )
        assert r.status_code == 401
        assert r.json().get("detail") == "session_expired"
        # Expired session row must have been deleted by get_driver.
        assert mongo_db.sessions.find_one({"token": tok}) is None

    # ------------------------------------------------------------------
    # OTP flow regression
    # ------------------------------------------------------------------
    def test_otp_flow_still_works(self, api_client, base_url, mongo_db):
        r1 = api_client.post(
            f"{base_url}/api/auth/otp/request", json={"phone": DEMO_PHONE}
        )
        assert r1.status_code == 200
        assert r1.json().get("sent") is True

        cid = str(uuid.uuid4())
        r2 = api_client.post(
            f"{base_url}/api/auth/otp/verify",
            json={"phone": DEMO_PHONE, "code": DEMO_OTP, "client_action_id": cid},
        )
        assert r2.status_code == 200, r2.text
        j = r2.json()
        assert j["token"]
        assert j["driver"]["phone"] == DEMO_PHONE
        # OTP-minted session must NOT carry expires_at (offline drivers).
        sess = mongo_db.sessions.find_one({"token": j["token"]}, {"_id": 0})
        assert sess is not None
        assert not sess.get("expires_at"), "OTP session should not expire"

        # Idempotent replay of verify with same client_action_id → same token.
        r3 = api_client.post(
            f"{base_url}/api/auth/otp/verify",
            json={"phone": DEMO_PHONE, "code": DEMO_OTP, "client_action_id": cid},
        )
        assert r3.status_code == 200
        assert r3.json()["token"] == j["token"]
