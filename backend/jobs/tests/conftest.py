import os
import pytest
from dotenv import load_dotenv
import uuid
import time
import copy

load_dotenv()

class RedactedDict(dict):
    def __repr__(self):
        return "{'x-functions-key': '<redacted>'}"

@pytest.fixture(autouse=True)
def delay_between_tests():
    # run before each test
    time.sleep(0.5)
    yield
    # could also sleep after test if needed

@pytest.fixture(scope="session")
def base_url():
    return os.getenv("EHESTIFTER_JOBS_BASE_URL")

@pytest.fixture(scope="session")
def test_job_url():
    return os.getenv("TEST_JOB_LINK")

@pytest.fixture(scope="session")
def test_job_url2():
    # this one is botched, with tow "?" in url
    return os.getenv("TEST_JOB_LINK2")    

@pytest.fixture(scope="session")
def function_key():
    return os.getenv("AZURE_FUNCTION_KEY")

@pytest.fixture(scope="session")
def auth_headers(function_key):
    return RedactedDict({"x-functions-key": function_key})

# Shared state across tests
@pytest.fixture(scope="session")
def shared_state():
    return {}

@pytest.fixture(scope="session")
def system_headers(auth_headers):
    #h = copy.deepcopy(auth_headers)
    h = RedactedDict(auth_headers)
    h.update({"X-Actor-Type": "system"})
    return h

@pytest.fixture(scope="session")
def test_user_id():
    # fixed GUID for deterministic tests
    return os.getenv("TEST_USER_GUID")

@pytest.fixture(scope="session")
def user_headers(auth_headers, test_user_id):
    h = RedactedDict(auth_headers)
    h.update({"X-User-Id": test_user_id})
    return h