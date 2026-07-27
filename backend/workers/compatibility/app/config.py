# /app/config.py
import os
import yaml
from dataclasses import dataclass
from typing import Any, Optional


def _req_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v

def _env_flag(name: str, default: bool = False) -> bool:
    v = os.getenv(name)
    if v is None:
        return default

    return v.strip().lower() in {"1", "true", "yes", "y", "on"}



def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = os.getenv(name)
    value_s = str(default) if raw is None else raw.strip()
    try:
        value = int(value_s)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def _env_int_tuple(
    name: str,
    default: str,
    *,
    minimum: int,
    maximum: int,
    max_items: int,
) -> tuple[int, ...]:
    raw = (os.getenv(name, default) or "").strip()
    if not raw:
        return ()
    parts = [part.strip() for part in raw.split(",")]
    if len(parts) > max_items:
        raise RuntimeError(f"{name} accepts at most {max_items} comma-separated values")
    values: list[int] = []
    for part in parts:
        try:
            value = int(part)
        except ValueError as exc:
            raise RuntimeError(f"{name} contains a non-integer value: {part!r}") from exc
        if not minimum <= value <= maximum:
            raise RuntimeError(
                f"{name} values must be between {minimum} and {maximum} seconds"
            )
        values.append(value)
    return tuple(values)


def _load_gateway_config() -> tuple[str, str]:
    """
    Select the Gateway endpoint/key pair used by the worker.

    Normal mode uses the primary Gateway, currently Azure Function App.
    Alternative mode is intended for experiments such as GCP Cloud Run Gateway.

    This is an explicit switch, not fallback logic. If alternative mode is
    enabled, missing alternative config is a startup error.
    """
    use_alternative = _env_flag("USE_GATEWAY_ALTERNATIVE", default=False)

    if use_alternative:
        return (
            _req_env("GATEWAY_ALTERNATIVE_BASE_URL").rstrip("/"),
            _req_env("GATEWAY_ALTERNATIVE_API_KEY"),
        )

    return (
        _req_env("GATEWAY_BASE_URL").rstrip("/"),
        _req_env("GATEWAY_API_KEY"),
    )


def _opt_int(v: Any) -> Optional[int]:
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    try:
        return int(v)
    except Exception:
        return None


def _opt_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    try:
        return float(v)
    except Exception:
        return None

def _opt_bool(v: Any) -> Optional[bool]:
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        s = v.strip().lower()
        if s in {"1", "true", "yes", "y", "on"}:
            return True
        if s in {"0", "false", "no", "n", "off"}:
            return False
    return None


@dataclass
class Settings:
    enricher_type: str
    sb_conn_str: str
    sb_queue: str
    gateway_base_url: str
    gateway_api_key: str
    llama_cpp_base_url: str
    poll_wait_seconds: int
    backoff_seconds: int
    lease_ttl_seconds: int
    inference_retry_delays_seconds: tuple[int, ...]
    inference_outage_cooldown_seconds: int
    inference_timeout_seconds: int
    inference_health_timeout_seconds: int
    message_lock_renewal_seconds: int

    # yaml-configured
    model: str
    temperature: float
    top_p: float

    # backwards-compat: old config used max_tokens; maps to Ollama num_predict
    max_tokens: Optional[int]

    # new Ollama options
    top_k: Optional[int]
    min_p: Optional[float]
    presence_penalty: Optional[float]
    repetition_penalty: Optional[float]

    enable_thinking: Optional[bool]
    thinking_budget_tokens: Optional[int]
    reasoning_format: Optional[str]    

    system_prompt: str
    rubric: str


def load_settings(config_path: str = "/app/config.yaml") -> Settings:
    with open(config_path, "r", encoding="utf-8") as f:
        cfg: dict[str, Any] = yaml.safe_load(f) or {}

    c = (cfg.get("compatibility") or {})
    gateway_base_url, gateway_api_key = _load_gateway_config()

    # Support both correct and typo key for presence penalty
    presence_penalty_val = c.get("presence_penalty")
    if presence_penalty_val is None:
        presence_penalty_val = c.get("resence_penalty")  # typo fallback

    return Settings(
        enricher_type=os.getenv("ENRICHER_TYPE", "compatibility.v1"),
        sb_conn_str=_req_env("SERVICEBUS_CONNECTION_STRING"),
        sb_queue=_req_env("SERVICEBUS_QUEUE_NAME"),
        gateway_base_url=gateway_base_url,
        gateway_api_key=gateway_api_key,
        llama_cpp_base_url=_req_env("LLAMA_CPP_BASE_URL").rstrip("/"),
        poll_wait_seconds=int(os.getenv("WORKER_POLL_WAIT_SECONDS", "10")),
        backoff_seconds=int(os.getenv("WORKER_BACKOFF_SECONDS", "5")),
        lease_ttl_seconds=int(os.getenv("LEASE_TTL_SECONDS", "3600")),
        inference_retry_delays_seconds=_env_int_tuple(
            "WORKER_INFERENCE_RETRY_DELAYS_SECONDS",
            "10,30",
            minimum=0,
            maximum=300,
            max_items=4,
        ),
        inference_outage_cooldown_seconds=_env_int(
            "WORKER_INFERENCE_OUTAGE_COOLDOWN_SECONDS",
            600,
            minimum=30,
            maximum=3600,
        ),
        inference_timeout_seconds=_env_int(
            "WORKER_INFERENCE_TIMEOUT_SECONDS",
            180,
            minimum=10,
            maximum=1800,
        ),
        inference_health_timeout_seconds=_env_int(
            "WORKER_INFERENCE_HEALTH_TIMEOUT_SECONDS",
            5,
            minimum=1,
            maximum=60,
        ),
        message_lock_renewal_seconds=_env_int(
            "WORKER_MESSAGE_LOCK_RENEWAL_SECONDS",
            43200,
            minimum=900,
            maximum=86400,
        ),

        model=str(c.get("model", "llama3.1:8b")),
        temperature=float(c.get("temperature", 0.2)),
        top_p=float(c.get("top_p", 0.9)),

        # If config.yaml.template removed max_tokens, keep None; otherwise parse int
        max_tokens=_opt_int(c.get("max_tokens")),

        top_k=_opt_int(c.get("top_k")),
        min_p=_opt_float(c.get("min_p")),
        presence_penalty=_opt_float(presence_penalty_val),
        repetition_penalty=_opt_float(c.get("repetition_penalty")),

        # Thinking budget
        enable_thinking=_opt_bool(c.get("enable_thinking")),
        thinking_budget_tokens=_opt_int(c.get("thinking_budget_tokens")),
        reasoning_format=(
            str(c.get("reasoning_format")).strip()
            if c.get("reasoning_format") is not None
            else None
        ),

        system_prompt=str(c.get("system_prompt", "")),
        rubric=str(c.get("rubric", "")),
    )