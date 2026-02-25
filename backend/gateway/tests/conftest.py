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
    return {"suite_id": str(uuid.uuid4()), "run_ids": []}


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
    print(f"({label}: {resp.status_code} {resp.text[:1000]})", end="")


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

def _sb_envelope(msg) -> dict:
    body = _decode_sb_message_body(msg)
    try:
        app_props = dict(msg.application_properties or {})
    except Exception:
        app_props = {}

    # azure-servicebus can return bytes keys/values in app props
    def _norm(v):
        if isinstance(v, bytes):
            try:
                return v.decode("utf-8")
            except Exception:
                return repr(v)
        return v

    app_props = { _norm(k): _norm(v) for k, v in app_props.items() }

    return {
        "message_id": getattr(msg, "message_id", None),
        "correlation_id": getattr(msg, "correlation_id", None),
        "subject": getattr(msg, "subject", None),
        "application_properties": app_props,
        "body": body,  # decoded JSON or None
    }

@pytest.fixture(scope="session")
def sb_helpers(sb_conn_str_tests, sb_queue_name):
    """
    Service Bus helper functions for tests.
    """
    from azure.servicebus import ServiceBusClient

    def drain_matching(predicate, max_total: int = 50, wait_seconds: int = 10) -> int:
        drained = 0
        deadline = time.time() + wait_seconds

        with ServiceBusClient.from_connection_string(sb_conn_str_tests) as client:
            with client.get_queue_receiver(queue_name=sb_queue_name, max_wait_time=5) as receiver:
                while drained < max_total and time.time() < deadline:
                    msgs = receiver.receive_messages(max_message_count=10, max_wait_time=5)
                    if not msgs:
                        continue
                    for m in msgs:
                        env = _sb_envelope(m)
                        if predicate(env):
                            receiver.complete_message(m)
                            drained += 1
                            if drained >= max_total:
                                break
                        else:
                            receiver.abandon_message(m)

        return drained

    def receive_matching(predicate, wait_seconds: int = 20) -> dict | None:
        deadline = time.time() + wait_seconds
        with ServiceBusClient.from_connection_string(sb_conn_str_tests) as client:
            with client.get_queue_receiver(queue_name=sb_queue_name, max_wait_time=5) as receiver:
                while time.time() < deadline:
                    msgs = receiver.receive_messages(max_message_count=10, max_wait_time=5)
                    if not msgs:
                        continue
                    for m in msgs:
                        env = _sb_envelope(m)
                        if predicate(env):
                            receiver.complete_message(m)
                            return env
                        receiver.abandon_message(m)
        return None

    def receive_by_run_id(run_id: str, wait_seconds: int = 20) -> dict | None:
        rid = run_id.lower()

        def _match(env: dict) -> bool:
            if str(env.get("message_id") or "").lower() == rid:
                return True
            if str(env.get("correlation_id") or "").lower() == rid:
                return True

            body = env.get("body") or {}
            if isinstance(body, dict) and str(body.get("runId") or "").lower() == rid:
                return True

            props = env.get("application_properties") or {}
            # common keys people use
            for k in ("runId", "run_id", "RunId", "messageId"):
                if str(props.get(k) or "").lower() == rid:
                    return True

            return False

        return receive_matching(_match, wait_seconds=wait_seconds)

    def drain_by_run_ids(run_ids: list[str], wait_seconds: int = 10, max_total: int = 50) -> int:
        wanted = {r.lower() for r in run_ids if r}
        if not wanted:
            return 0

        def _match(env: dict) -> bool:
            mid = str(env.get("message_id") or "").lower()
            if mid in wanted:
                return True
            body = env.get("body") or {}
            if isinstance(body, dict) and str(body.get("runId") or "").lower() in wanted:
                return True
            props = env.get("application_properties") or {}
            for k in ("runId", "run_id", "RunId", "messageId"):
                if str(props.get(k) or "").lower() in wanted:
                    return True
            return False

        return drain_matching(_match, wait_seconds=wait_seconds, max_total=max_total)

    def peek_matching(predicate, wait_seconds: int = 15) -> dict | None:
        deadline = time.time() + wait_seconds
        with ServiceBusClient.from_connection_string(sb_conn_str_tests) as client:
            with client.get_queue_receiver(queue_name=sb_queue_name, max_wait_time=5) as receiver:
                while time.time() < deadline:
                    batch = receiver.peek_messages(max_message_count=50)
                    for m in batch or []:
                        env = _sb_envelope(m)
                        if predicate(env):
                            return env
                    time.sleep(0.5)
        return None

    return {
        "drain_matching": drain_matching,
        "receive_matching": receive_matching,
        "receive_by_run_id": receive_by_run_id,
        "drain_by_run_ids": drain_by_run_ids,
        "peek_matching": peek_matching,
    }
    
