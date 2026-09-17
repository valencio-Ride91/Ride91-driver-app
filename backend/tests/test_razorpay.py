"""Razorpay Standard Checkout — Part A backend tests.

Notes on stubbing outbound Razorpay calls
-----------------------------------------
The review request asked us to stub httpx to Razorpay. The rest of the
suite already runs against the *live* out-of-process backend (supervisor
manages it) via HTTP, so we cannot monkeypatch inside the server process
from this test module. We handle each endpoint accordingly:

* /orders happy-path / caps / idempotent replay
  -> hits Razorpay's TEST mode (which is exactly what test keys are for
     — no money moves, no third-party side effects). The keys in
     backend/.env are `rzp_test_*`. This mirrors what the app will do
     in staging.
* /orders 400 branches (amount_below_minimum, no_dues)
  -> pure server-side validation, no outbound call.
* /verify, /status, /webhooks, /checkout
  -> pre-seed razorpay_orders rows directly in Mongo and compute HMAC
     locally with the same secrets the server uses. No network calls to
     Razorpay at all.

All test-created data is prefixed with `TEST_` and cleaned up after the
class runs. We use a dedicated seeded driver (id + session token) so we
never touch the demo driver's real cash-in-hand state.
"""
import hashlib
import hmac
import json as _json
import os
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import requests
from dotenv import load_dotenv

# Load env explicitly so we can pick up the Razorpay keys the server uses.
load_dotenv(Path(__file__).resolve().parents[1] / ".env")
load_dotenv(Path(__file__).resolve().parents[1].parent / "frontend" / ".env")

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
RAZORPAY_KEY_ID = os.environ.get("RAZORPAY_KEY_ID", "")
RAZORPAY_KEY_SECRET = os.environ.get("RAZORPAY_KEY_SECRET", "")
RAZORPAY_WEBHOOK_SECRET = os.environ.get("RAZORPAY_WEBHOOK_SECRET", "")

IST = timezone(timedelta(hours=5, minutes=30))


def _business_date_now() -> str:
    """Same 04:00 IST rollover as server.business_date_now()."""
    now_utc = datetime.now(timezone.utc)
    shifted = now_utc.astimezone(IST) - timedelta(hours=4)
    return shifted.strftime("%Y-%m-%d")


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Shared class-scoped fixtures — seed a dedicated TEST_ driver + token.
# ---------------------------------------------------------------------------
@pytest.fixture(scope="class")
def rzp_driver(mongo_db):
    """Create a fresh driver + session directly in Mongo so we can pin
    the dues to whatever we like without touching the shared demo driver.
    """
    driver_id = f"TEST_rzp_drv_{uuid.uuid4().hex[:8]}"
    token = f"TEST_rzp_tok_{secrets.token_hex(24)}"
    phone = "+919000099001"  # TEST_ range not seeded anywhere.
    mongo_db.drivers.insert_one({
        "id": driver_id,
        "phone": phone,
        "name": "TEST_ Razorpay Driver",
        "created_at": _iso(datetime.now(timezone.utc)),
    })
    mongo_db.sessions.insert_one({
        "token": token,
        "driver_id": driver_id,
        "client_action_id": f"TEST_rzp_login_{uuid.uuid4().hex[:8]}",
        "source": "otp",  # no expires_at → offline-driver contract
        "created_at": _iso(datetime.now(timezone.utc)),
    })
    yield {
        "id": driver_id,
        "phone": phone,
        "token": token,
        "headers": {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    }
    # Cleanup everything we created.
    mongo_db.drivers.delete_many({"id": driver_id})
    mongo_db.sessions.delete_many({"driver_id": driver_id})
    mongo_db.platform_cash.delete_many({"driver_id": driver_id})
    mongo_db.qr_payments.delete_many({"driver_id": driver_id})
    mongo_db.razorpay_orders.delete_many({"driver_id": driver_id})
    mongo_db.webhook_events.delete_many({"event_id": {"$regex": "^TEST_rzp_"}})


def _set_dues(mongo_db, driver_id: str, rupees: float):
    """Wipe today's cash rows and set cash_in_hand=rupees (via platform_cash)."""
    today = _business_date_now()
    mongo_db.platform_cash.delete_many({"driver_id": driver_id, "business_date": today})
    mongo_db.qr_payments.delete_many({"driver_id": driver_id, "business_date": today})
    if rupees > 0:
        mongo_db.platform_cash.insert_one({
            "id": f"TEST_pc_{uuid.uuid4().hex[:8]}",
            "driver_id": driver_id,
            "platform": "uber",
            "cash_amount": float(rupees),
            "gross_amount": float(rupees),
            "business_date": today,
            "window_start": _iso(datetime.now(timezone.utc) - timedelta(hours=1)),
            "window_end": _iso(datetime.now(timezone.utc)),
            "source": "ocr",
            "status": "provisional",
            "image_ref": None,
            "confidence": 0.9,
            "client_action_id": f"TEST_pc_cid_{uuid.uuid4().hex[:8]}",
            "created_at": _iso(datetime.now(timezone.utc)),
        })


@pytest.fixture(scope="class")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
class TestRazorpay:
    """Razorpay Standard Checkout — single class, pinned to one worker via
    pytest-xdist loadscope to serialize all state mutations."""

    # ----- /config -----------------------------------------------------
    def test_config_reflects_env_and_dues(self, api, rzp_driver, mongo_db):
        _set_dues(mongo_db, rzp_driver["id"], 123.45)
        r = api.get(f"{BASE_URL}/api/payments/razorpay/config", headers=rzp_driver["headers"])
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["enabled"] is True
        assert j["key_id"] == RAZORPAY_KEY_ID
        assert j["dues_paise"] == 12345
        assert j["dues_rupees"] == 123.45

        # And also mirrors money/today.cash_in_hand exactly.
        m = api.get(f"{BASE_URL}/api/money/today", headers=rzp_driver["headers"])
        assert m.status_code == 200
        assert round(m.json()["cash_in_hand"], 2) == 123.45

    # ----- /orders happy path ------------------------------------------
    def test_orders_happy_path_dues_zero_explicit_amount(self, api, rzp_driver, mongo_db):
        """dues=0 AND amount_rupees=150 → 15000 paise, real Razorpay order id."""
        _set_dues(mongo_db, rzp_driver["id"], 0.0)
        # Force dues to exactly 0 by inserting a matching deposit to zero out
        # any residual cash-in-hand from previous tests within the class.
        today = _business_date_now()
        mongo_db.qr_payments.delete_many({"driver_id": rzp_driver["id"], "business_date": today})
        mongo_db.platform_cash.delete_many({"driver_id": rzp_driver["id"], "business_date": today})

        cid = f"TEST_rzp_cid_{uuid.uuid4().hex[:8]}"
        r = api.post(
            f"{BASE_URL}/api/payments/razorpay/orders",
            headers=rzp_driver["headers"],
            json={"client_action_id": cid, "amount_rupees": 150},
        )
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["amount_paise"] == 15000
        assert j["currency"] == "INR"
        assert j["key_id"] == RAZORPAY_KEY_ID
        assert j["status"] == "created"
        assert j["order_id"].startswith("order_")

        # Row landed with correct amount_paise + order_id.
        row = mongo_db.razorpay_orders.find_one({"client_action_id": cid})
        assert row is not None
        assert row["amount_paise"] == 15000
        assert row["razorpay_order_id"] == j["order_id"]
        assert row["driver_id"] == rzp_driver["id"]

    # ----- /orders idempotency -----------------------------------------
    def test_orders_idempotent_replay(self, api, rzp_driver, mongo_db):
        _set_dues(mongo_db, rzp_driver["id"], 0.0)
        today = _business_date_now()
        mongo_db.platform_cash.delete_many({"driver_id": rzp_driver["id"], "business_date": today})
        mongo_db.qr_payments.delete_many({"driver_id": rzp_driver["id"], "business_date": today})

        cid = f"TEST_rzp_idem_{uuid.uuid4().hex[:8]}"
        r1 = api.post(
            f"{BASE_URL}/api/payments/razorpay/orders",
            headers=rzp_driver["headers"],
            json={"client_action_id": cid, "amount_rupees": 42},
        )
        assert r1.status_code == 200, r1.text
        order_id_1 = r1.json()["order_id"]

        r2 = api.post(
            f"{BASE_URL}/api/payments/razorpay/orders",
            headers=rzp_driver["headers"],
            json={"client_action_id": cid, "amount_rupees": 999},  # ignored
        )
        assert r2.status_code == 200, r2.text
        assert r2.json()["order_id"] == order_id_1
        assert r2.json()["amount_paise"] == 4200

        # Only ONE row in Mongo for this client_action_id.
        count = mongo_db.razorpay_orders.count_documents(
            {"driver_id": rzp_driver["id"], "client_action_id": cid}
        )
        assert count == 1

    # ----- /orders amount_below_minimum --------------------------------
    def test_orders_amount_below_minimum(self, api, rzp_driver, mongo_db):
        _set_dues(mongo_db, rzp_driver["id"], 0.0)
        cid = f"TEST_rzp_low_{uuid.uuid4().hex[:8]}"
        r = api.post(
            f"{BASE_URL}/api/payments/razorpay/orders",
            headers=rzp_driver["headers"],
            json={"client_action_id": cid, "amount_rupees": 0.5},
        )
        assert r.status_code == 400, r.text
        assert r.json().get("detail") == "amount_below_minimum"

    # ----- /orders no_dues ---------------------------------------------
    def test_orders_no_dues(self, api, rzp_driver, mongo_db):
        # Force dues to 0: wipe today's platform_cash + qr_payments.
        today = _business_date_now()
        mongo_db.platform_cash.delete_many({"driver_id": rzp_driver["id"], "business_date": today})
        mongo_db.qr_payments.delete_many({"driver_id": rzp_driver["id"], "business_date": today})

        cid = f"TEST_rzp_nd_{uuid.uuid4().hex[:8]}"
        r = api.post(
            f"{BASE_URL}/api/payments/razorpay/orders",
            headers=rzp_driver["headers"],
            json={"client_action_id": cid},
        )
        assert r.status_code == 400, r.text
        assert r.json().get("detail") == "no_dues"

    # ----- /orders caps at dues ----------------------------------------
    def test_orders_caps_at_dues(self, api, rzp_driver, mongo_db):
        _set_dues(mongo_db, rzp_driver["id"], 100.0)  # dues = ₹100
        cid = f"TEST_rzp_cap_{uuid.uuid4().hex[:8]}"
        r = api.post(
            f"{BASE_URL}/api/payments/razorpay/orders",
            headers=rzp_driver["headers"],
            json={"client_action_id": cid, "amount_rupees": 500},
        )
        assert r.status_code == 200, r.text
        assert r.json()["amount_paise"] == 10000

    # ----- /verify valid signature -------------------------------------
    def _seed_order(self, mongo_db, driver_id: str, amount_paise: int = 15000):
        cid = f"TEST_rzp_v_cid_{uuid.uuid4().hex[:8]}"
        rzp_order_id = f"order_TEST{uuid.uuid4().hex[:12]}"
        mongo_db.razorpay_orders.insert_one({
            "id": f"TEST_rzp_row_{uuid.uuid4().hex[:8]}",
            "driver_id": driver_id,
            "client_action_id": cid,
            "razorpay_order_id": rzp_order_id,
            "amount_paise": amount_paise,
            "note": None,
            "status": "created",
            "created_at": _iso(datetime.now(timezone.utc)),
        })
        return cid, rzp_order_id

    def _sign(self, secret: str, msg: str) -> str:
        return hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()

    def test_verify_valid_signature(self, api, rzp_driver, mongo_db):
        cid, order_id = self._seed_order(mongo_db, rzp_driver["id"], 15000)
        payment_id = f"pay_TEST{uuid.uuid4().hex[:12]}"
        sig = self._sign(RAZORPAY_KEY_SECRET, f"{order_id}|{payment_id}")
        r = api.post(
            f"{BASE_URL}/api/payments/razorpay/verify",
            json={
                "client_action_id": cid,
                "razorpay_order_id": order_id,
                "razorpay_payment_id": payment_id,
                "razorpay_signature": sig,
            },
        )
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "reconciled"
        assert r.json()["amount_paise"] == 15000

        # Order row flipped to reconciled + payment_id + reconciled_at.
        row = mongo_db.razorpay_orders.find_one({"razorpay_order_id": order_id})
        assert row["status"] == "reconciled"
        assert row["razorpay_payment_id"] == payment_id
        assert row.get("reconciled_at")

        # qr_payments row landed with source='razorpay', type='deposit'.
        qr = mongo_db.qr_payments.find_one(
            {"driver_id": rzp_driver["id"], "client_action_id": cid}
        )
        assert qr is not None
        assert qr["source"] == "razorpay"
        assert qr["type"] == "deposit"
        assert qr["amount"] == 150.0
        assert qr["razorpay_order_id"] == order_id
        assert qr["razorpay_payment_id"] == payment_id

    def test_verify_invalid_signature(self, api, rzp_driver, mongo_db):
        cid, order_id = self._seed_order(mongo_db, rzp_driver["id"], 5000)
        payment_id = f"pay_TEST{uuid.uuid4().hex[:12]}"
        r = api.post(
            f"{BASE_URL}/api/payments/razorpay/verify",
            json={
                "client_action_id": cid,
                "razorpay_order_id": order_id,
                "razorpay_payment_id": payment_id,
                "razorpay_signature": "deadbeef" * 8,
            },
        )
        assert r.status_code == 400, r.text
        assert r.json().get("detail") == "invalid_signature"

        # Order NOT reconciled.
        row = mongo_db.razorpay_orders.find_one({"razorpay_order_id": order_id})
        assert row["status"] == "created"

    def test_verify_unknown_order(self, api, rzp_driver):
        r = api.post(
            f"{BASE_URL}/api/payments/razorpay/verify",
            json={
                "client_action_id": f"TEST_rzp_unknown_{uuid.uuid4().hex[:6]}",
                "razorpay_order_id": f"order_TEST_does_not_exist_{uuid.uuid4().hex[:6]}",
                "razorpay_payment_id": "pay_TEST_x",
                "razorpay_signature": "x" * 64,
            },
        )
        assert r.status_code == 404, r.text
        assert r.json().get("detail") == "order_not_found"

    def test_verify_idempotent(self, api, rzp_driver, mongo_db):
        cid, order_id = self._seed_order(mongo_db, rzp_driver["id"], 7500)
        payment_id = f"pay_TEST{uuid.uuid4().hex[:12]}"
        sig = self._sign(RAZORPAY_KEY_SECRET, f"{order_id}|{payment_id}")
        body = {
            "client_action_id": cid,
            "razorpay_order_id": order_id,
            "razorpay_payment_id": payment_id,
            "razorpay_signature": sig,
        }
        r1 = api.post(f"{BASE_URL}/api/payments/razorpay/verify", json=body)
        assert r1.status_code == 200
        r2 = api.post(f"{BASE_URL}/api/payments/razorpay/verify", json=body)
        assert r2.status_code == 200

        # Order stays reconciled; only ONE qr_payments deposit for this cid.
        row = mongo_db.razorpay_orders.find_one({"razorpay_order_id": order_id})
        assert row["status"] == "reconciled"
        count = mongo_db.qr_payments.count_documents(
            {"driver_id": rzp_driver["id"], "client_action_id": cid}
        )
        assert count == 1

    # ----- /status/{cid} -----------------------------------------------
    def test_status_after_verify(self, api, rzp_driver, mongo_db):
        cid, order_id = self._seed_order(mongo_db, rzp_driver["id"], 12000)
        payment_id = f"pay_TEST{uuid.uuid4().hex[:12]}"
        sig = self._sign(RAZORPAY_KEY_SECRET, f"{order_id}|{payment_id}")
        api.post(
            f"{BASE_URL}/api/payments/razorpay/verify",
            json={
                "client_action_id": cid,
                "razorpay_order_id": order_id,
                "razorpay_payment_id": payment_id,
                "razorpay_signature": sig,
            },
        )
        r = api.get(
            f"{BASE_URL}/api/payments/razorpay/status/{cid}",
            headers=rzp_driver["headers"],
        )
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["status"] == "reconciled"
        assert j["order_id"] == order_id
        assert j["payment_id"] == payment_id
        assert j["amount_paise"] == 12000
        assert j.get("reconciled_at")

    def test_status_unknown_cid_404(self, api, rzp_driver):
        r = api.get(
            f"{BASE_URL}/api/payments/razorpay/status/TEST_does_not_exist_xyz",
            headers=rzp_driver["headers"],
        )
        assert r.status_code == 404

    # ----- /checkout HTML ----------------------------------------------
    def test_checkout_returns_html(self, api):
        order_id = f"order_TEST_html_{uuid.uuid4().hex[:6]}"
        r = api.get(
            f"{BASE_URL}/api/payments/razorpay/checkout",
            params={
                "order_id": order_id,
                "amount": 15000,
                "action": "TEST_action_html",
                "redirect": "ride91://money",
                "name": "Ride91 driver",
            },
        )
        assert r.status_code == 200, r.text
        assert "text/html" in r.headers.get("content-type", "")
        body = r.text
        assert "checkout.razorpay.com/v1/checkout.js" in body
        assert order_id in body
        assert RAZORPAY_KEY_ID in body

    # ----- /webhooks bad signature -------------------------------------
    def test_webhook_bad_signature(self, api):
        raw = _json.dumps({"event": "payment.captured", "id": "evt_TEST_x"}).encode()
        r = api.post(
            f"{BASE_URL}/api/webhooks/razorpay",
            data=raw,
            headers={"X-Razorpay-Signature": "00" * 32, "Content-Type": "application/json"},
        )
        assert r.status_code == 400
        assert r.json().get("detail") == "bad_signature"

    # ----- /webhooks valid signature payment.captured ------------------
    def test_webhook_payment_captured_reconciles(self, api, rzp_driver, mongo_db):
        cid, order_id = self._seed_order(mongo_db, rzp_driver["id"], 25000)
        payment_id = f"pay_TEST_wh_{uuid.uuid4().hex[:8]}"
        event_id = f"TEST_rzp_evt_{uuid.uuid4().hex[:10]}"
        event = {
            "id": event_id,
            "event": "payment.captured",
            "payload": {
                "payment": {
                    "entity": {
                        "id": payment_id,
                        "order_id": order_id,
                        "amount": 25000,
                        "notes": {
                            "driver_id": rzp_driver["id"],
                            "client_action_id": cid,
                        },
                    }
                }
            },
        }
        raw = _json.dumps(event).encode()
        sig = hmac.new(RAZORPAY_WEBHOOK_SECRET.encode(), raw, hashlib.sha256).hexdigest()
        r = api.post(
            f"{BASE_URL}/api/webhooks/razorpay",
            data=raw,
            headers={"X-Razorpay-Signature": sig, "Content-Type": "application/json"},
        )
        assert r.status_code == 200, r.text
        assert r.json().get("ok") is True

        row = mongo_db.razorpay_orders.find_one({"razorpay_order_id": order_id})
        assert row["status"] == "reconciled"
        assert row["razorpay_payment_id"] == payment_id

        qr = mongo_db.qr_payments.find_one(
            {"driver_id": rzp_driver["id"], "client_action_id": cid}
        )
        assert qr is not None
        assert qr["type"] == "deposit"
        assert qr["source"] == "razorpay"
        assert qr["amount"] == 250.0

    # ----- /webhooks dedup by event id ---------------------------------
    def test_webhook_dedup_by_event_id(self, api, rzp_driver, mongo_db):
        cid, order_id = self._seed_order(mongo_db, rzp_driver["id"], 8000)
        payment_id_1 = f"pay_TEST_wh1_{uuid.uuid4().hex[:6]}"
        payment_id_2 = f"pay_TEST_wh2_{uuid.uuid4().hex[:6]}"
        event_id = f"TEST_rzp_evt_dedup_{uuid.uuid4().hex[:8]}"

        def _event(pid):
            return {
                "id": event_id,
                "event": "payment.captured",
                "payload": {"payment": {"entity": {
                    "id": pid,
                    "order_id": order_id,
                    "amount": 8000,
                    "notes": {
                        "driver_id": rzp_driver["id"],
                        "client_action_id": cid,
                    },
                }}},
            }

        raw1 = _json.dumps(_event(payment_id_1)).encode()
        raw2 = _json.dumps(_event(payment_id_2)).encode()
        sig1 = hmac.new(RAZORPAY_WEBHOOK_SECRET.encode(), raw1, hashlib.sha256).hexdigest()
        sig2 = hmac.new(RAZORPAY_WEBHOOK_SECRET.encode(), raw2, hashlib.sha256).hexdigest()

        r1 = api.post(
            f"{BASE_URL}/api/webhooks/razorpay",
            data=raw1,
            headers={"X-Razorpay-Signature": sig1, "Content-Type": "application/json"},
        )
        assert r1.status_code == 200
        assert r1.json().get("ok") is True
        assert r1.json().get("dedup") in (None, False)

        r2 = api.post(
            f"{BASE_URL}/api/webhooks/razorpay",
            data=raw2,
            headers={"X-Razorpay-Signature": sig2, "Content-Type": "application/json"},
        )
        assert r2.status_code == 200
        assert r2.json().get("dedup") is True

        # Only the first reconciliation ran → order.payment_id is #1, not #2.
        row = mongo_db.razorpay_orders.find_one({"razorpay_order_id": order_id})
        assert row["status"] == "reconciled"
        assert row["razorpay_payment_id"] == payment_id_1

    # ----- /webhooks payment.failed ------------------------------------
    def test_webhook_payment_failed_marks_order(self, api, rzp_driver, mongo_db):
        cid, order_id = self._seed_order(mongo_db, rzp_driver["id"], 3000)
        event_id = f"TEST_rzp_evt_fail_{uuid.uuid4().hex[:8]}"
        event = {
            "id": event_id,
            "event": "payment.failed",
            "payload": {"payment": {"entity": {
                "id": f"pay_TEST_fail_{uuid.uuid4().hex[:6]}",
                "order_id": order_id,
                "amount": 3000,
            }}},
        }
        raw = _json.dumps(event).encode()
        sig = hmac.new(RAZORPAY_WEBHOOK_SECRET.encode(), raw, hashlib.sha256).hexdigest()
        r = api.post(
            f"{BASE_URL}/api/webhooks/razorpay",
            data=raw,
            headers={"X-Razorpay-Signature": sig, "Content-Type": "application/json"},
        )
        assert r.status_code == 200, r.text
        row = mongo_db.razorpay_orders.find_one({"razorpay_order_id": order_id})
        assert row["status"] == "failed"
        assert row.get("failed_at")
