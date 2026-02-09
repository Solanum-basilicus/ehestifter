import os
import pytest
import requests
from dotenv import load_dotenv

load_dotenv()

class RedactedDict(dict):
    def __repr__(self):
        return "{'x-functions-key': '<redacted>'}"

@pytest.fixture(scope="session")
def base_url():
    v = os.getenv("EHESTIFTER_ENRICHERS_BASE_URL")
    assert v, "Missing EHESTIFTER_ENRICHERS_BASE_URL"
    return v.rstrip("/")


@pytest.fixture(scope="session")
def function_key():
    v = os.getenv("EHESTIFTER_ENRICHERS_FUNCTION_KEY")
    assert v, "Missing EHESTIFTER_ENRICHERS_FUNCTION_KEY"
    return v


@pytest.fixture(scope="session")
def default_user_id():
    v = os.getenv("EHESTIFTER_ENRICHERS_DEFAULT_USER_ID")
    assert v, "Missing EHESTIFTER_ENRICHERS_DEFAULT_USER_ID (should be a GUID user id)"
    return v


@pytest.fixture(scope="session")
def auth_headers(function_key):
    return RedactedDict({"x-functions-key": function_key})


@pytest.fixture(scope="session")
def shared_state():
    return {}


@pytest.fixture(scope="session")
def enricher_type():
    # Match your v1 design doc default
    return os.getenv("EHESTIFTER_ENRICHERS_TEST_ENRICHER_TYPE", "compatibility.v1")


def _safe_post(url: str, headers: dict, json_payload: dict):
    r = requests.post(url, headers=headers, json=json_payload, timeout=30)
    print(f"\nPOST {url}\nPayload: {json_payload}\nStatus: {r.status_code}\nBody: {r.text[:2000]}")
    return r


def _safe_get(url: str, headers: dict):
    r = requests.get(url, headers=headers, timeout=30)
    print(f"\nGET {url}\nStatus: {r.status_code}\nBody: {r.text[:2000]}")
    return r


@pytest.fixture(scope="session")
def get_json():
    return _safe_get


@pytest.fixture(scope="session")
def post_json():
    return _safe_post


@pytest.fixture(scope="session")
def job_id():
    """
    Prefer explicit job id for tests.
    Option A: set EHESTIFTER_ENRICHERS_TEST_JOB_ID
    Option B: provide Jobs API envs and we create one minimal job posting.
    """
    explicit = os.getenv("EHESTIFTER_ENRICHERS_TEST_JOB_ID")
    if explicit:
        return explicit
    
    # Ignoring option B