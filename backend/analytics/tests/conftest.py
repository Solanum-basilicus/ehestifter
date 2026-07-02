from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from dotenv import load_dotenv


ANALYTICS_ROOT = Path(__file__).resolve().parents[1]

# Load local test env first, then .env.local as fallback.
# Existing shell environment wins over both files.
load_dotenv(ANALYTICS_ROOT / ".env.test", override=False)
load_dotenv(ANALYTICS_ROOT / ".env.local", override=False)


class RedactedDict(dict):
    def __repr__(self):
        safe = {}
        for key, value in self.items():
            if key.lower() == "x-functions-key":
                safe[key] = "<redacted>"
            else:
                safe[key] = value
        return repr(safe)


def pytest_addoption(parser):
    parser.addoption(
        "--analytics-target",
        action="store",
        default=os.getenv("ANALYTICS_TEST_TARGET", "local"),
        choices=("local", "prod"),
        help="Run Analytics smoke tests against local or prod service.",
    )
    parser.addoption(
        "--analytics-base-url",
        action="store",
        default=None,
        help="Override Analytics service base URL.",
    )


@pytest.fixture(autouse=True)
def delay_between_tests():
    time.sleep(0.05)
    yield


@pytest.fixture(scope="session")
def analytics_target(pytestconfig):
    return pytestconfig.getoption("--analytics-target")


@pytest.fixture(scope="session")
def base_url(pytestconfig, analytics_target):
    override = pytestconfig.getoption("--analytics-base-url")
    if override:
        return override.rstrip("/")

    if analytics_target == "prod":
        value = os.getenv("ANALYTICS_PROD_BASE_URL")
        if not value:
            pytest.fail("ANALYTICS_PROD_BASE_URL is required for --analytics-target=prod")
        return value.rstrip("/")

    return os.getenv("ANALYTICS_LOCAL_BASE_URL", "http://localhost:8080").rstrip("/")


def _required_key(name: str, analytics_target: str, local_default: str | None = None) -> str:
    value = os.getenv(name)
    if value:
        return value

    if analytics_target == "local" and local_default:
        return local_default

    pytest.fail(f"{name} is required for Analytics {analytics_target} tests")


@pytest.fixture(scope="session")
def jobs_key(analytics_target):
    return _required_key("ANALYTICS_FUNCTION_KEY_JOBS", analytics_target, "jobs-key")


@pytest.fixture(scope="session")
def users_key(analytics_target):
    return _required_key("ANALYTICS_FUNCTION_KEY_USERS", analytics_target, "users-key")


@pytest.fixture(scope="session")
def scheduler_key(analytics_target):
    return _required_key("ANALYTICS_FUNCTION_KEY_SCHEDULER", analytics_target, "scheduler-key")


@pytest.fixture(scope="session")
def operator_key(analytics_target):
    return _required_key("ANALYTICS_FUNCTION_KEY_OPERATOR", analytics_target, "operator-key")


@pytest.fixture(scope="session")
def jobs_headers(jobs_key):
    return RedactedDict({"x-functions-key": jobs_key})


@pytest.fixture(scope="session")
def users_headers(users_key):
    return RedactedDict({"x-functions-key": users_key})


@pytest.fixture(scope="session")
def scheduler_headers(scheduler_key):
    return RedactedDict({"x-functions-key": scheduler_key})


@pytest.fixture(scope="session")
def operator_headers(operator_key):
    return RedactedDict({"x-functions-key": operator_key})


@pytest.fixture(scope="session")
def db_asserts_enabled():
    return os.getenv("ANALYTICS_TEST_ENABLE_DB_ASSERTS", "0").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


@pytest.fixture(scope="session")
def test_sql_connection_string(db_asserts_enabled):
    if not db_asserts_enabled:
        return None

    value = os.getenv("ANALYTICS_TEST_SQL_CONNECTION_STRING")
    if not value:
        pytest.fail(
            "ANALYTICS_TEST_SQL_CONNECTION_STRING is required when "
            "ANALYTICS_TEST_ENABLE_DB_ASSERTS=1"
        )
    return value
    