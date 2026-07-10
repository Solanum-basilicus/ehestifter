from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CanonicalIdentityModel(StrictModel):
    provider: str = Field(min_length=1, max_length=80)
    providerTenant: str = Field(default="", max_length=160)
    externalId: str = Field(min_length=1, max_length=240)

    @field_validator("provider", "providerTenant", "externalId")
    @classmethod
    def trim(cls, value: str) -> str:
        return value.strip()

    @field_validator("provider", "externalId")
    @classmethod
    def required_after_trim(cls, value: str) -> str:
        if not value:
            raise ValueError("must not be empty")
        return value


class IdentityRequest(StrictModel):
    url: str = Field(min_length=1, max_length=4096)
    providerHint: str | None = Field(default=None, max_length=80)


class IdentityResponse(StrictModel):
    ok: bool
    identity: CanonicalIdentityModel | None
    confidence: Literal["high", "medium", "none"]
    warnings: list[str] = Field(default_factory=list)


class ExistsRequest(StrictModel):
    url: str = Field(min_length=1, max_length=4096)

    @field_validator("url")
    @classmethod
    def trim_url(cls, value: str) -> str:
        return value.strip()


class ExistsResponse(StrictModel):
    exists: bool
    jobId: UUID | None = None
    canonicalIdentity: CanonicalIdentityModel
    source: Literal["jobs-api"] = "jobs-api"
    warnings: list[str] = Field(default_factory=list)


class JobLocation(StrictModel):
    countryName: str | None = Field(default=None, max_length=120)
    countryCode: str | None = Field(default=None, max_length=2)
    cityName: str | None = Field(default=None, max_length=160)
    region: str | None = Field(default=None, max_length=160)

    @field_validator("countryName", "countryCode", "cityName", "region")
    @classmethod
    def trim_optional(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @field_validator("countryCode")
    @classmethod
    def normalize_country_code(cls, value: str | None) -> str | None:
        return value.upper() if value else value

    @model_validator(mode="after")
    def reject_fully_empty_location(self) -> "JobLocation":
        if not any([self.countryName, self.countryCode, self.cityName, self.region]):
            raise ValueError("location must not be fully empty")
        return self


class JobCreateRequest(StrictModel):
    url: str = Field(min_length=1, max_length=4096)
    applyUrl: str | None = Field(default=None, max_length=4096)
    foundOn: str = Field(default="career-ops", min_length=1, max_length=120)
    provider: str = Field(min_length=1, max_length=80)
    providerTenant: str = Field(default="", max_length=160)
    externalId: str = Field(min_length=1, max_length=240)
    title: str = Field(min_length=1, max_length=500)
    hiringCompanyName: str = Field(min_length=1, max_length=500)
    postingCompanyName: str | None = Field(default=None, max_length=500)
    remoteType: str | None = Field(default=None, max_length=80)
    description: str | None = None
    locations: list[JobLocation] = Field(default_factory=list, max_length=20)

    @field_validator(
        "url",
        "applyUrl",
        "foundOn",
        "provider",
        "providerTenant",
        "externalId",
        "title",
        "hiringCompanyName",
        "postingCompanyName",
        "remoteType",
        "description",
    )
    @classmethod
    def trim_strings(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @model_validator(mode="after")
    def required_after_trim(self) -> "JobCreateRequest":
        for field_name in ["url", "foundOn", "provider", "externalId", "title", "hiringCompanyName"]:
            if not getattr(self, field_name):
                raise ValueError(f"{field_name} must not be empty")
        return self

    def canonical_identity(self) -> CanonicalIdentityModel:
        return CanonicalIdentityModel(
            provider=self.provider,
            providerTenant=self.providerTenant,
            externalId=self.externalId,
        )


class JobCreateResponse(StrictModel):
    outcome: Literal["created", "existing", "rejected", "transient_failure"]
    jobId: UUID | None
    canonicalIdentity: CanonicalIdentityModel
    warnings: list[str] = Field(default_factory=list)


class JobSearchItem(StrictModel):
    jobId: UUID | None = None
    title: str | None = None
    company: str | None = None
    status: str | None = None
    provider: str | None = None
    providerTenant: str | None = None
    externalId: str | None = None
    url: str | None = None


class JobSearchResponse(StrictModel):
    items: list[JobSearchItem]


class JobDetailResponse(StrictModel):
    job: dict[str, Any]
    descriptionTruncated: bool = False


class MarkAppliedRequest(StrictModel):
    confirm: Literal["mark-applied"]


class MarkAppliedResponse(StrictModel):
    outcome: Literal["status_updated"]
    jobId: UUID
    status: Literal["Applied"] = "Applied"
