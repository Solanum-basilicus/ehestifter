import os
import yaml
from dataclasses import dataclass
from typing import Any

def _req_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v

@dataclass
class Settings:
    enricher_type: str
    sb_conn_str: str
    sb_queue: str
    gateway_base_url: str
    gateway_api_key: str
    ollama_base_url: str
    poll_wait_seconds: int
    backoff_seconds: int
    lease_ttl_seconds: int

    # yaml-configured
    model: str
    temperature: float
    top_p: float
    max_tokens: int
    system_prompt: str
    rubric: str

def load_settings(config_path: str = "/app/config.yaml") -> Settings:
    with open(config_path, "r", encoding="utf-8") as f:
        cfg: dict[str, Any] = yaml.safe_load(f) or {}
    c = (cfg.get("compatibility") or {})

    return Settings(
        enricher_type=os.getenv("ENRICHER_TYPE", "compatibility.v1"),
        sb_conn_str=_req_env("SERVICEBUS_CONNECTION_STRING"),
        sb_queue=_req_env("SERVICEBUS_QUEUE_NAME"),
        gateway_base_url=_req_env("GATEWAY_BASE_URL").rstrip("/"),
        gateway_api_key=_req_env("GATEWAY_API_KEY"),
        ollama_base_url=os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11434").rstrip("/"),
        poll_wait_seconds=int(os.getenv("WORKER_POLL_WAIT_SECONDS", "10")),
        backoff_seconds=int(os.getenv("WORKER_BACKOFF_SECONDS", "5")),
        lease_ttl_seconds=int(os.getenv("LEASE_TTL_SECONDS", "3600")),
        model=str(c.get("model", "llama3.1:8b")),
        temperature=float(c.get("temperature", 0.2)),
        top_p=float(c.get("top_p", 0.9)),
        max_tokens=int(c.get("max_tokens", 700)),
        system_prompt=str(c.get("system_prompt", "")),
        rubric=str(c.get("rubric", "")),
    )