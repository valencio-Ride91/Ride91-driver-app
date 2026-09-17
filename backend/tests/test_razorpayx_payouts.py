"""RazorpayX Payouts (Part B) — backend tests.

Covers:
- Driver GET/POST /api/payouts/bank-account (validation + persistence + masking).
- Driver GET /api/payouts/history.
- Admin POST /api/admin/payouts/create (validation branches + happy path).
- Admin GET /api/admin/payouts, /admin/payouts/{id}/refresh.
- POST /api/webhooks/razorpayx (bad sig, valid sig, dedup).

Uses TEST_-prefixed drivers/sessions/bank_accounts/payouts that are cleaned
up in fixture teardown. RazorpayX test-mode is hit AT MOST ONCE per test run
(via the single happy-path test), which is safe because the API mode is
`test` and no money moves.
"""
import hashlib
import hmac
import json
import os
import uuid
from datetime import datetime, timezone

import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
RAZORPAYX_WEBHOOK_SECRET = os.environ.get("RAZORPAYX_WEBHOOK_SECRET", "")
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "ride91-admin-2026")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@pytest.fixture(scope="module")
def admin_headers(api_client):
    r = api_client.post(
        f"{BASE_URL}/api/admin/login",
        json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD},
    )
    assert r.status_code == 200, r.text
    tok = r.json()["token"]
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


@pytest.fixture()
def test_driver(mongo_db):
    """Create a fresh TEST_-prefixed driver + session and yield {id, token, headers}.
    Tears down driver/session/bank_account/payouts on exit."""
    driver_id = f"TEST_drv_{uuid.uuid4().hex[:10]}"
    vehicle_id = f"TEST_veh_{uuid.uuid4().hex[:10]}"
    token = f"TEST_tok_{uuid.uuid4().hex}"

    mongo_db.drivers.insert_one(
        {
            "id": driver_id,
            "name": "TEST_Payout_Driver",
            "phone": f"+91990000{uuid.uuid4().int % 10000:04d}",
            "email": "test.driver@ride91.test",
            "vehicle_id": vehicle_id,
            "hub_id": "TEST_hub_1",
            "created_at": _iso_now(),
        }
    )
    mongo_db.vehicles.insert_one(
        {"id": vehicle_id, "reg_no": f"TESTKA{uuid.uuid4().int % 10000:04d}", "hub_id": "TEST_hub_1"}
    )
    mongo_db.sessions.insert_one(
        {
            "token": token,
            "driver_id": driver_id,
            "client_action_id": f"TEST_{uuid.uuid4().hex}",
            "created_at": _iso_now(),
        }
    )

    yield {
        "id": driver_id,
        "token": token,
        "headers": {"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    }

    # Teardown
    mongo_db.drivers.delete_many({"id": driver_id})
    mongo_db.vehicles.delete_many({"id": vehicle_id})
    mongo_db.sessions.delete_many({"token": token})
    mongo_db.driver_bank_accounts.delete_many({"driver_id": driver_id})
    mongo_db.payouts.delete_many({"driver_id": driver_id})


# ---------------------------------------------------------------------------
# Driver GET /payouts/bank-account — empty state
# ---------------------------------------------------------------------------
class TestBankAccountRead:
    def test_get_returns_saved_false_when_empty(self, api_client, test_driver):
        r = api_client.get(
            f"{BASE_URL}/api/payouts/bank-account", headers=test_driver["headers"]
        )
        assert r.status_code == 200, r.text
        assert r.json() == {"saved": False}

    def test_get_returns_masked_view_when_present(
        self, api_client, test_driver, mongo_db
    ):
        # Save a bank account first
        save = api_client.post(
            f"{BASE_URL}/api/payouts/bank-account",
            headers=test_driver["headers"],
            json={
                "kind": "bank_account",
                "account_holder": "Test Driver",
                "account_number": "123456789012",
                "ifsc": "HDFC0001234",
            },
        )
        assert save.status_code == 200, save.text

        r = api_client.get(
            f"{BASE_URL}/api/payouts/bank-account", headers=test_driver["headers"]
        )
        assert r.status_code == 200
        body = r.json()
        assert body["saved"] is True
        assert body["kind"] == "bank_account"
        assert body["account_holder"] == "Test Driver"
        assert body["ifsc"] == "HDFC0001234"
        assert body["verified"] is False  # RazorpayX not called yet
        # Masked should end in last 4 digits
        assert body["masked"].endswith("9012")
        assert "1234" not in body["masked"]  # first digits hidden


# ---------------------------------------------------------------------------
# Driver POST /payouts/bank-account — validation branches
# ---------------------------------------------------------------------------
class TestBankAccountValidation:
    def test_bank_missing_fields(self, api_client, test_driver):
        r = api_client.post(
            f"{BASE_URL}/api/payouts/bank-account",
            headers=test_driver["headers"],
            json={"kind": "bank_account", "account_holder": "X"},
        )
        assert r.status_code == 400
        assert r.json()["detail"] == "missing_bank_fields"

    def test_invalid_ifsc(self, api_client, test_driver):
        r = api_client.post(
            f"{BASE_URL}/api/payouts/bank-account",
            headers=test_driver["headers"],
            json={
                "kind": "bank_account",
                "account_holder": "X",
                "account_number": "123456789012",
                "ifsc": "ABCDE1234",
            },
        )
        assert r.status_code == 400
        assert r.json()["detail"] == "invalid_ifsc"

    def test_invalid_account_number(self, api_client, test_driver):
        r = api_client.post(
            f"{BASE_URL}/api/payouts/bank-account",
            headers=test_driver["headers"],
            json={
                "kind": "bank_account",
                "account_holder": "X",
                "account_number": "12",
                "ifsc": "HDFC0001234",
            },
        )
        assert r.status_code == 400
        assert r.json()["detail"] == "invalid_account_number"

    def test_valid_bank_account_saved(self, api_client, test_driver, mongo_db):
        r = api_client.post(
            f"{BASE_URL}/api/payouts/bank-account",
            headers=test_driver["headers"],
            json={
                "kind": "bank_account",
                "account_holder": "Test Driver",
                "account_number": "123456789012",
                "ifsc": "HDFC0001234",
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["saved"] is True
        assert body["kind"] == "bank_account"
        # DB check
        row = mongo_db.driver_bank_accounts.find_one({"driver_id": test_driver["id"]})
        assert row is not None
        assert row["kind"] == "bank_account"
        assert row["account_number"] == "123456789012"
        assert row["ifsc"] == "HDFC0001234"

    def test_vpa_missing_at(self, api_client, test_driver):
        r = api_client.post(
            f"{BASE_URL}/api/payouts/bank-account",
            headers=test_driver["headers"],
            json={"kind": "vpa", "vpa": "notavpa"},
        )
        assert r.status_code == 400
        assert r.json()["detail"] == "invalid_vpa"

    def test_valid_vpa_saved(self, api_client, test_driver, mongo_db):
        r = api_client.post(
            f"{BASE_URL}/api/payouts/bank-account",
            headers=test_driver["headers"],
            json={"kind": "vpa", "vpa": "test@ybl"},
        )
        assert r.status_code == 200, r.text
        row = mongo_db.driver_bank_accounts.find_one({"driver_id": test_driver["id"]})
        assert row["kind"] == "vpa"
        assert row["vpa"] == "test@ybl"

    def test_switching_to_vpa_clears_fund_account_id(
        self, api_client, test_driver, mongo_db
    ):
        # 1. Save bank account
        api_client.post(
            f"{BASE_URL}/api/payouts/bank-account",
            headers=test_driver["headers"],
            json={
                "kind": "bank_account",
                "account_holder": "Test Driver",
                "account_number": "123456789012",
                "ifsc": "HDFC0001234",
            },
        )
        # 2. Manually mark it as verified (simulate a prior RazorpayX fund account
        #    creation) to check the switch actually clears the field.
        mongo_db.driver_bank_accounts.update_one(
            {"driver_id": test_driver["id"]},
            {"$set": {
                "razorpayx_contact_id": "cont_TEST_stale",
                "razorpayx_fund_account_id": "fa_TEST_stale",
            }},
        )
        pre = mongo_db.driver_bank_accounts.find_one({"driver_id": test_driver["id"]})
        assert pre["razorpayx_fund_account_id"] == "fa_TEST_stale"

        # 3. Switch to VPA
        r = api_client.post(
            f"{BASE_URL}/api/payouts/bank-account",
            headers=test_driver["headers"],
            json={"kind": "vpa", "vpa": "test@ybl"},
        )
        assert r.status_code == 200, r.text

        # 4. Fund account id must be cleared
        post = mongo_db.driver_bank_accounts.find_one({"driver_id": test_driver["id"]})
        assert post["razorpayx_fund_account_id"] is None
        assert post["razorpayx_contact_id"] is None
        assert post["kind"] == "vpa"


# ---------------------------------------------------------------------------
# Driver GET /payouts/history
# ---------------------------------------------------------------------------
class TestPayoutsHistory:
    def test_history_empty(self, api_client, test_driver):
        r = api_client.get(
            f"{BASE_URL}/api/payouts/history", headers=test_driver["headers"]
        )
        assert r.status_code == 200, r.text
        assert r.json() == {"items": []}

    def test_history_returns_inserted_row(self, api_client, test_driver, mongo_db):
        payout_id = f"TEST_pout_{uuid.uuid4().hex[:10]}"
        rzpx_id = f"pout_TEST_{uuid.uuid4().hex[:10]}"
        mongo_db.payouts.insert_one(
            {
                "id": payout_id,
                "driver_id": test_driver["id"],
                "razorpayx_payout_id": rzpx_id,
                "razorpayx_fund_account_id": "fa_TEST_secret",
                "razorpayx_contact_id": "cont_TEST_secret",
                "amount_paise": 10000,
                "amount_rupees": 100.0,
                "mode": "IMPS",
                "status": "processed",
                "utr": "TEST_UTR_123",
                "client_action_id": f"TEST_cid_{uuid.uuid4().hex}",
                "created_by": "admin",
                "created_at": _iso_now(),
                "updated_at": _iso_now(),
            }
        )
        r = api_client.get(
            f"{BASE_URL}/api/payouts/history", headers=test_driver["headers"]
        )
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) == 1
        item = items[0]
        assert item["id"] == payout_id
        assert item["amount_paise"] == 10000
        assert item["mode"] == "IMPS"
        assert item["status"] == "processed"
        assert item["utr"] == "TEST_UTR_123"
        # Sensitive fields must be stripped
        assert "razorpayx_fund_account_id" not in item
        assert "razorpayx_contact_id" not in item
        # razorpayx_payout_id is fine to expose (opaque id)


# ---------------------------------------------------------------------------
# Admin POST /admin/payouts/create — validation
# ---------------------------------------------------------------------------
class TestAdminCreateValidation:
    def test_missing_admin_auth_is_401(self, api_client, test_driver):
        r = api_client.post(
            f"{BASE_URL}/api/admin/payouts/create",
            json={"driver_id": test_driver["id"], "amount_rupees": 100},
        )
        assert r.status_code == 401

    def test_amount_below_minimum(self, api_client, admin_headers, test_driver):
        r = api_client.post(
            f"{BASE_URL}/api/admin/payouts/create",
            headers=admin_headers,
            json={
                "driver_id": test_driver["id"],
                "amount_rupees": 0.5,  # < ₹1 → < 100 paise
                "mode": "IMPS",
                "client_action_id": f"TEST_cid_{uuid.uuid4().hex}",
            },
        )
        assert r.status_code == 400
        assert r.json()["detail"] == "amount_below_minimum"

    def test_unknown_driver_bank_account_not_saved(self, api_client, admin_headers):
        r = api_client.post(
            f"{BASE_URL}/api/admin/payouts/create",
            headers=admin_headers,
            json={
                "driver_id": f"TEST_nonexistent_{uuid.uuid4().hex}",
                "amount_rupees": 100,
                "mode": "IMPS",
                "client_action_id": f"TEST_cid_{uuid.uuid4().hex}",
            },
        )
        assert r.status_code == 400
        assert r.json()["detail"] == "bank_account_not_saved"

    def test_imps_requires_bank_account(
        self, api_client, admin_headers, test_driver, mongo_db
    ):
        # Save a VPA
        api_client.post(
            f"{BASE_URL}/api/payouts/bank-account",
            headers=test_driver["headers"],
            json={"kind": "vpa", "vpa": "test@ybl"},
        )
        r = api_client.post(
            f"{BASE_URL}/api/admin/payouts/create",
            headers=admin_headers,
            json={
                "driver_id": test_driver["id"],
                "amount_rupees": 100,
                "mode": "IMPS",
                "client_action_id": f"TEST_cid_{uuid.uuid4().hex}",
            },
        )
        assert r.status_code == 400
        assert r.json()["detail"] == "imps_requires_bank_account"

    def test_upi_requires_vpa(
        self, api_client, admin_headers, test_driver, mongo_db
    ):
        # Save a bank_account
        api_client.post(
            f"{BASE_URL}/api/payouts/bank-account",
            headers=test_driver["headers"],
            json={
                "kind": "bank_account",
                "account_holder": "Test Driver",
                "account_number": "123456789012",
                "ifsc": "HDFC0001234",
            },
        )
        r = api_client.post(
            f"{BASE_URL}/api/admin/payouts/create",
            headers=admin_headers,
            json={
                "driver_id": test_driver["id"],
                "amount_rupees": 100,
                "mode": "UPI",
                "client_action_id": f"TEST_cid_{uuid.uuid4().hex}",
            },
        )
        assert r.status_code == 400
        assert r.json()["detail"] == "upi_requires_vpa"


# ---------------------------------------------------------------------------
# Admin happy path — ACTUALLY HITS RazorpayX (test-mode). Single test.
# ---------------------------------------------------------------------------
class TestAdminCreateHappyPath:
    def test_happy_path_imps(
        self, api_client, admin_headers, test_driver, mongo_db
    ):
        # Save a bank account
        save = api_client.post(
            f"{BASE_URL}/api/payouts/bank-account",
            headers=test_driver["headers"],
            json={
                "kind": "bank_account",
                "account_holder": "Test Driver",
                "account_number": "123456789012",
                "ifsc": "HDFC0001234",
            },
        )
        assert save.status_code == 200, save.text

        cid = f"TEST_cid_{uuid.uuid4().hex}"
        create_body = {
            "driver_id": test_driver["id"],
            "amount_rupees": 1.0,  # ₹1 = 100 paise (minimum)
            "mode": "IMPS",
            "narration": "TEST payout",
            "client_action_id": cid,
        }
        r = api_client.post(
            f"{BASE_URL}/api/admin/payouts/create",
            headers=admin_headers,
            json=create_body,
        )
        if r.status_code == 502:
            pytest.skip(
                f"RazorpayX API unreachable / rejected keys: {r.text}. "
                "Skipping happy path but 502 path validated (bubbles up cleanly)."
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert "payout_id" in body
        assert "razorpayx_id" in body
        assert body["razorpayx_id"].startswith("pout_")
        payout_id = body["payout_id"]
        razorpayx_id = body["razorpayx_id"]

        # DB check — payouts row
        row = mongo_db.payouts.find_one({"id": payout_id})
        assert row is not None
        assert row["driver_id"] == test_driver["id"]
        assert row["razorpayx_payout_id"] == razorpayx_id
        assert row["amount_paise"] == 100
        assert row["mode"] == "IMPS"
        assert row["client_action_id"] == cid
        assert row["created_by"] == "admin"
        assert row["status"]  # non-empty

        # DB check — driver_bank_accounts got contact_id + fund_account_id
        ba = mongo_db.driver_bank_accounts.find_one({"driver_id": test_driver["id"]})
        assert ba["razorpayx_contact_id"], "contact_id should be populated"
        assert ba["razorpayx_fund_account_id"], "fund_account_id should be populated"

        # Idempotent replay
        r2 = api_client.post(
            f"{BASE_URL}/api/admin/payouts/create",
            headers=admin_headers,
            json=create_body,
        )
        assert r2.status_code == 200, r2.text
        b2 = r2.json()
        assert b2["payout_id"] == payout_id
        assert b2.get("dedup") is True

        # GET /admin/payouts?driver_id=<id> lists it
        list_r = api_client.get(
            f"{BASE_URL}/api/admin/payouts",
            headers=admin_headers,
            params={"driver_id": test_driver["id"]},
        )
        assert list_r.status_code == 200, list_r.text
        items = list_r.json()["items"]
        assert any(it["id"] == payout_id for it in items)

        # GET /admin/payouts/{id}/refresh returns 200 with status/utr
        ref = api_client.get(
            f"{BASE_URL}/api/admin/payouts/{payout_id}/refresh",
            headers=admin_headers,
        )
        assert ref.status_code == 200, ref.text
        refb = ref.json()
        assert "status" in refb
        assert "utr" in refb  # may be None but key must exist

        # Stash razorpayx_id on the module for webhook test
        pytest.razorpayx_id_for_webhook = razorpayx_id
        pytest.payout_id_for_webhook = payout_id
        pytest.driver_id_for_webhook = test_driver["id"]


# ---------------------------------------------------------------------------
# Webhook POST /webhooks/razorpayx
# ---------------------------------------------------------------------------
class TestRazorpayxWebhook:
    def test_missing_signature_returns_400(self, api_client):
        r = api_client.post(
            f"{BASE_URL}/api/webhooks/razorpayx",
            data=json.dumps({"event": "payout.processed"}),
            headers={"Content-Type": "application/json"},
        )
        assert r.status_code == 400
        assert r.json()["detail"] == "bad_signature"

    def test_wrong_signature_returns_400(self, api_client):
        r = api_client.post(
            f"{BASE_URL}/api/webhooks/razorpayx",
            data=json.dumps({"event": "payout.processed"}),
            headers={
                "Content-Type": "application/json",
                "X-Razorpay-Signature": "deadbeef",
            },
        )
        assert r.status_code == 400
        assert r.json()["detail"] == "bad_signature"

    def test_valid_signature_updates_payout(self, api_client, mongo_db):
        # Always seed a fresh synthetic payout row so this test is independent
        # of the happy-path fixture teardown (function-scoped test_driver
        # cleans up its payouts row after its test finishes).
        rzpx_id = f"pout_TEST_wh_{uuid.uuid4().hex[:10]}"
        payout_id = f"TEST_pout_{uuid.uuid4().hex[:10]}"
        drv_id = f"TEST_drv_wh_{uuid.uuid4().hex[:10]}"
        mongo_db.payouts.insert_one(
            {
                "id": payout_id,
                "driver_id": drv_id,
                "razorpayx_payout_id": rzpx_id,
                "amount_paise": 100,
                "amount_rupees": 1.0,
                "mode": "IMPS",
                "status": "processing",
                "client_action_id": f"TEST_wh_{uuid.uuid4().hex}",
                "created_by": "admin",
                "created_at": _iso_now(),
                "updated_at": _iso_now(),
            }
        )
        pytest.driver_id_for_webhook = drv_id

        event_id = f"evt_TEST_{uuid.uuid4().hex[:14]}"
        payload = {
            "id": event_id,
            "event": "payout.processed",
            "payload": {
                "payout": {
                    "entity": {
                        "id": rzpx_id,
                        "status": "processed",
                        "utr": "TEST_UTR_WEBHOOK_999",
                    }
                }
            },
        }
        raw = json.dumps(payload).encode()
        sig = hmac.new(
            RAZORPAYX_WEBHOOK_SECRET.encode(), raw, hashlib.sha256
        ).hexdigest()

        r = api_client.post(
            f"{BASE_URL}/api/webhooks/razorpayx",
            data=raw,
            headers={
                "Content-Type": "application/json",
                "X-Razorpay-Signature": sig,
                "X-Razorpay-Event-Id": event_id,
            },
        )
        assert r.status_code == 200, r.text
        assert r.json().get("ok") is True

        # DB check — status updated
        row = mongo_db.payouts.find_one({"razorpayx_payout_id": rzpx_id})
        assert row is not None
        assert row["status"] == "processed"
        assert row["utr"] == "TEST_UTR_WEBHOOK_999"
        assert row.get("last_event") == "payout.processed"

        # Stash event_id + raw for dedup test
        pytest.webhook_event_id = event_id
        pytest.webhook_raw = raw
        pytest.webhook_sig = sig

        # Cleanup synthetic driver payouts if we seeded them
        drv_id = getattr(pytest, "driver_id_for_webhook", None)
        if drv_id and drv_id.startswith("TEST_drv_wh_"):
            # keep the row for dedup test; will clean at end
            pass

    def test_same_event_id_dedup(self, api_client):
        event_id = getattr(pytest, "webhook_event_id", None)
        raw = getattr(pytest, "webhook_raw", None)
        sig = getattr(pytest, "webhook_sig", None)
        if not (event_id and raw and sig):
            pytest.skip("prior webhook test did not run")
        r = api_client.post(
            f"{BASE_URL}/api/webhooks/razorpayx",
            data=raw,
            headers={
                "Content-Type": "application/json",
                "X-Razorpay-Signature": sig,
                "X-Razorpay-Event-Id": event_id,
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("ok") is True
        assert body.get("dedup") is True

    @pytest.fixture(autouse=True, scope="class")
    def _cleanup_webhook_state(self, mongo_db):
        yield
        # Clean up webhook_events + any TEST_ synthetic payouts
        drv_id = getattr(pytest, "driver_id_for_webhook", None)
        if drv_id and drv_id.startswith("TEST_drv_wh_"):
            mongo_db.payouts.delete_many({"driver_id": drv_id})
        ev_id = getattr(pytest, "webhook_event_id", None)
        if ev_id:
            mongo_db.webhook_events.delete_many({"event_id": ev_id})
