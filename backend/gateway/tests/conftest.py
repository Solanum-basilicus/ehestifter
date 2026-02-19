import os
import json
import time
import uuid
import pytest
import requests
from dotenv import load_dotenv

load_dotenv()


class RedactedDict(dict):
    def __repr__(self):
        # Don't leak function keys in stdout
        return "{'x-functions-key': '<redacted>'}"


@pytest.fixture(scope="session")
def gateway_base_url():
    v = os.getenv("EHESTIFTER_GATEWAY_BASE_URL")
    assert v, "Missing EHESTIFTER_GATEWAY_BASE_URL"
    return v.rstrip("/")


@pytest.fixture(scope="session")
def gateway_function_key():
    v = os.getenv("EHESTIFTER_GATEWAY_FUNCTION_KEY")
    assert v, "Missing EHESTIFTER_GATEWAY_FUNCTION_KEY"
    return v


@pytest.fixture(scope="session")
def gateway_auth_headers(gateway_function_key):
    return RedactedDict({"x-functions-key": gateway_function_key})


@pytest.fixture(scope="session")
def core_base_url():
    v = os.getenv("EHESTIFTER_ENRICHERS_BASE_URL")
    assert v, "Missing EHESTIFTER_ENRICHERS_BASE_URL"
    return v.rstrip("/")


@pytest.fixture(scope="session")
def core_function_key():
    v = os.getenv("EHESTIFTER_ENRICHERS_FUNCTION_KEY")
    assert v, "Missing EHESTIFTER_ENRICHERS_FUNCTION_KEY"
    return v


@pytest.fixture(scope="session")
def core_auth_headers(core_function_key):
    return RedactedDict({"x-functions-key": core_function_key})


@pytest.fixture(scope="session")
def default_user_id():
    v = os.getenv("EHESTIFTER_ENRICHERS_DEFAULT_USER_ID")
    assert v, "Missing EHESTIFTER_ENRICHERS_DEFAULT_USER_ID"
    return v


@pytest.fixture(scope="session")
def default_job_id():
    v = os.getenv("EHESTIFTER_ENRICHERS_DEFAULT_JOB_ID")
    assert v, "Missing EHESTIFTER_ENRICHERS_DEFAULT_JOB_ID"
    return v


@pytest.fixture(scope="session")
def sb_conn_str_tests():
    v = os.getenv("EHESTIFTER_SB_CONNECTION_STRING_TESTS")
    assert v, "Missing EHESTIFTER_SB_CONNECTION_STRING_TESTS"
    return v


@pytest.fixture(scope="session")
def sb_queue_name():
    return os.getenv("EHESTIFTER_SB_QUEUE_NAME", "enrichment-requests")


@pytest.fixture(scope="session")
def enricher_type():
    return os.getenv("EHESTIFTER_ENRICHER_TYPE", "compatibility.v1")


@pytest.fixture(scope="session")
def shared_state():
    """
    Session-wide shared context across tests.
    We'll also store a per-suite correlation id for SB filtering.
    """
    return {"suite_id": str(uuid.uuid4())}


@pytest.fixture(scope="session")
def http():
    """
    Shared requests session (keeps TLS warm, etc.)
    """
    s = requests.Session()
    yield s
    s.close()


def _safe_print_response(label: str, resp: requests.Response):
    # Avoid printing headers; response body is fine (should not contain keys)
    print(f"({label}: {resp.status_code} {resp.text[:500]})", end="")


@pytest.fixture(scope="session")
def post_json(http):
    def _post(url: str, headers: dict, payload: dict, label: str = "POST"):
        resp = http.post(url, headers=headers, json=payload, timeout=60)
        _safe_print_response(label, resp)
        return resp
    return _post


@pytest.fixture(scope="session")
def get_json(http):
    def _get(url: str, headers: dict, label: str = "GET"):
        resp = http.get(url, headers=headers, timeout=60)
        _safe_print_response(label, resp)
        return resp
    return _get


def _decode_sb_message_body(msg) -> dict | None:
    """
    azure-servicebus returns msg.body as an iterable of bytes for received messages.
    """
    try:
        raw = b"".join(b for b in msg.body)
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


@pytest.fixture(scope="session")
def sb_helpers(sb_conn_str_tests, sb_queue_name):
    """
    Service Bus helper functions for tests.
    """
    from azure.servicebus import ServiceBusClient

    def drain_messages(max_total: int = 50, wait_seconds: int = 10) -> int:
        """
        Best-effort drain (receive+complete) up to max_total messages.
        Useful for final cleanup only.
        """
        drained = 0
        deadline = time.time() + wait_seconds
        with ServiceBusClient.from_connection_string(sb_conn_str_tests) as client:
            with client.get_queue_receiver(queue_name=sb_queue_name, max_wait_time=5) as receiver:
                while drained < max_total and time.time() < deadline:
                    msgs = receiver.receive_messages(max_message_count=10, max_wait_time=5)
                    if not msgs:
                        continue
                    for m in msgs:
                        receiver.complete_message(m)
                        drained += 1
                        if drained >= max_total:
                            break
        return drained

    def receive_matching(predicate, wait_seconds: int = 20) -> dict | None:
        """
        Receive messages until predicate(payload) is True.
        Non-matching messages are abandoned (put back) so we don't steal from real workers.
        Matching message is completed and returned as payload dict.
        """
        deadline = time.time() + wait_seconds
        with ServiceBusClient.from_connection_string(sb_conn_str_tests) as client:
            with client.get_queue_receiver(queue_name=sb_queue_name, max_wait_time=5) as receiver:
                while time.time() < deadline:
                    msgs = receiver.receive_messages(max_message_count=10, max_wait_time=5)
                    if not msgs:
                        continue
                    for m in msgs:
                        payload = _decode_sb_message_body(m)
                        if payload and predicate(payload):
                            receiver.complete_message(m)
                            return payload
                        receiver.abandon_message(m)
        return None

    return {"drain_messages": drain_messages, "receive_matching": receive_matching}
