import os
import pytest
from dotenv import load_dotenv

load_dotenv()

class RedactedDict(dict):
    def __repr__(self):
        return "{'x-functions-key': '<redacted>'}"

@pytest.fixture(scope="session")
def base_url():
    return os.getenv("EHESTIFTER_USERS_BASE_URL")

@pytest.fixture(scope="session")
def function_key():
    return os.getenv("EHESTIFTER_USERS_FUNCTION_KEY")

@pytest.fixture(scope="session")
def auth_headers(function_key):
    return RedactedDict({"x-functions-key": function_key})

@pytest.fixture(scope="session")
def default_user():
    return os.getenv("EHESTIFTER_USERS_DEFAULT_USER")

# Shared state across tests
@pytest.fixture(scope="session")
def shared_state():
    return {}