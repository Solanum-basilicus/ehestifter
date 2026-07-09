from __future__ import annotations

import json
from pathlib import Path
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TlsSettings(StrictModel):
    enabled: bool = True
    certFile: str | None = None
    keyFile: str | None = None

    @field_validator("certFile", "keyFile")
    @classmethod
    def empty_string_to_none(cls, value: str | None) -> str | None:
        if value == "":
            return None
        return value


class ServerSettings(StrictModel):
    host: str = "0.0.0.0"
    port: int = Field(default=8787, ge=1024, le=65535)
    tls: TlsSettings = Field(default_factory=TlsSettings)


class AgentAuthSettings(StrictModel):
    bearerToken: SecretStr


class EhestifterSettings(StrictModel):
    jobsBaseUrl: str
    jobsFunctionKey: SecretStr
    userId: UUID | None = None
    actorMode: Literal["user", "system"] = "user"
    timeoutSeconds: float = Field(default=20.0, gt=0, le=120)

    @field_validator("jobsBaseUrl")
    @classmethod
    def strip_base_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        if not value.startswith("https://") and not value.startswith("http://"):
            raise ValueError("jobsBaseUrl must start with http:// or https://")
        return value


class LimitsSettings(StrictModel):
    maxSearchLength: int = Field(default=120, ge=1, le=500)
    maxPageSize: int = Field(default=20, ge=1, le=100)
    maxDescriptionCharsOnCreate: int = Field(default=80_000, ge=1, le=500_000)
    maxDescriptionCharsReturned: int = Field(default=20_000, ge=0, le=200_000)


class FeatureSettings(StrictModel):
    allowCreate: bool = True
    allowMarkApplied: bool = False
    allowUrlIdentityGuess: bool = True


class Settings(StrictModel):
    server: ServerSettings = Field(default_factory=ServerSettings)
    agentAuth: AgentAuthSettings
    ehestifter: EhestifterSettings
    limits: LimitsSettings = Field(default_factory=LimitsSettings)
    features: FeatureSettings = Field(default_factory=FeatureSettings)

    def validate_runtime_files(self) -> None:
        if not self.server.tls.enabled:
            return
        if not self.server.tls.certFile or not self.server.tls.keyFile:
            raise ValueError("TLS is enabled, but certFile/keyFile are not configured")
        for label, filename in [
            ("certFile", self.server.tls.certFile),
            ("keyFile", self.server.tls.keyFile),
        ]:
            if not Path(filename).is_file():
                raise ValueError(f"TLS {label} does not exist or is not a file: {filename}")


def load_settings(path: str | Path, *, validate_runtime_files: bool = True) -> Settings:
    config_path = Path(path)
    with config_path.open("r", encoding="utf-8") as f:
        raw = json.load(f)
    settings = Settings.model_validate(raw)
    if validate_runtime_files:
        settings.validate_runtime_files()
    return settings
