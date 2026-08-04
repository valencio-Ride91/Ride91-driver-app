import os
import pytest
import requests
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1].parent / "frontend" / ".env")

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL missing"

DEMO_PHONE = "+919900000001"
DEMO_OTP = "123456"


@pytest.fixture(scope="session")
def base_url() -> str:
    return BASE_URL


@pytest.fixture(scope="session")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def auth(api_client):
    """Login demo driver and return (token, driver, headers)."""
    import uuid
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
