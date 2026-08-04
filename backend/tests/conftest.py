import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import requests
from dotenv import load_dotenv
from pymongo import MongoClient

# Load public backend URL from frontend .env (Expo convention)
load_dotenv(Path(__file__).resolve().parents[1].parent / "frontend" / ".env")
# Load Mongo URL / DB name from backend .env
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL missing"

MONGO_URL = os.environ.get("MONGO_URL")
DB_NAME = os.environ.get("DB_NAME")
assert MONGO_URL and DB_NAME, "MONGO_URL / DB_NAME missing"

DEMO_PHONE = "+919900000001"
DEMO_OTP = "123456"


def _ist_day_key() -> str:
    ist = timezone(timedelta(hours=5, minutes=30))
    return datetime.now(timezone.utc).astimezone(ist).strftime("%Y-%m-%d")


@pytest.fixture(scope="session")
def base_url() -> str:
    return BASE_URL


@pytest.fixture(scope="session")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def mongo_db():
    c = MongoClient(MONGO_URL)
    try:
        yield c[DB_NAME]
    finally:
        c.close()


@pytest.fixture(scope="session")
def today_key() -> str:
    return _ist_day_key()


@pytest.fixture(scope="session")
def auth(api_client):
    """Login demo driver and return (token, driver, headers)."""
    api_client.post(f"{BASE_URL}/api/auth/otp/request", json={"phone": DEMO_PHONE})
    r = api_client.post(
        f"{BASE_URL}/api/auth/otp/verify",
        json={"phone": DEMO_PHONE, "code": DEMO_OTP, "client_action_id": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    return {
        "token": data["token"],
        "driver": data["driver"],
        "headers": {"Authorization": f"Bearer {data['token']}", "Content-Type": "application/json"},
    }


# All tests live in a single module (test_ride91_backend.py) so pytest-xdist
# loadscope pins them to one worker and runs them sequentially — no cross-worker
# races on the shared demo driver's inspection row.
