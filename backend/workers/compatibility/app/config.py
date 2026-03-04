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

    system_prompt: str
    rubric: str


def load_settings(config_path: str = "/app/config.yaml") -> Settings:
    with open(config_path, "r", encoding="utf-8") as f:
        cfg: dict[str, Any] = yaml.safe_load(f) or {}

    c = (cfg.get("compatibility") or {})

    # Support both correct and typo key for presence penalty
    presence_penalty_val = c.get("presence_penalty")
    if presence_penalty_val is None:
        presence_penalty_val = c.get("resence_penalty")  # typo fallback

    return Settings(
        enricher_type=os.getenv("ENRICHER_TYPE", "compatibility.v1"),
        sb_conn_str=_req_env("SERVICEBUS_CONNECTION_STRING"),
        sb_queue=_req_env("SERVICEBUS_QUEUE_NAME"),
        gateway_base_url=_req_env("GATEWAY_BASE_URL").rstrip("/"),
        gateway_api_key=_req_env("GATEWAY_API_KEY"),
        llama_cpp_base_url=(os.getenv("LLAMA_CPP_BASE_URL")).rstrip("/"),
        poll_wait_seconds=int(os.getenv("WORKER_POLL_WAIT_SECONDS", "10")),
        backoff_seconds=int(os.getenv("WORKER_BACKOFF_SECONDS", "5")),
        lease_ttl_seconds=int(os.getenv("LEASE_TTL_SECONDS", "3600")),

        model=str(c.get("model", "llama3.1:8b")),
        temperature=float(c.get("temperature", 0.2)),
        top_p=float(c.get("top_p", 0.9)),

        # If config.yaml.template removed max_tokens, keep None; otherwise parse int
        max_tokens=_opt_int(c.get("max_tokens")),

        top_k=_opt_int(c.get("top_k")),
        min_p=_opt_float(c.get("min_p")),
        presence_penalty=_opt_float(presence_penalty_val),
        repetition_penalty=_opt_float(c.get("repetition_penalty")),

        system_prompt=str(c.get("system_prompt", "")),
        rubric=str(c.get("rubric", "")),
    )