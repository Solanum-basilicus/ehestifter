from __future__ import annotations

from typing import Any
from uuid import UUID

import httpx
from fastapi import HTTPException

from .models import CanonicalIdentityModel, JobCreateRequest, JobSearchItem
from .settings import Settings


class UpstreamJobsClient:
    def __init__(self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._settings = settings
        self._client = httpx.AsyncClient(
            base_url=settings.ehestifter.jobsBaseUrl,
            timeout=settings.ehestifter.timeoutSeconds,
            transport=transport,
            verify=True,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    def _headers(self) -> dict[str, str]:
        headers = {
            "x-functions-key": self._settings.ehestifter.jobsFunctionKey.get_secret_value(),
            "Accept": "application/json",
        }
        if self._settings.ehestifter.actorMode == "system":
            headers["X-Actor-Type"] = "system"
        elif self._settings.ehestifter.userId is not None:
            headers["X-User-Id"] = str(self._settings.ehestifter.userId)
        return headers

    async def exists_by_url(self, url: str) -> tuple[bool, UUID | None, dict[str, Any] | None]:
        response = await self._safe_request("GET", "/jobs/exists", params={"url": url})

        if response.status_code == 404:
            return False, None, None
        if response.status_code == 400:
            raise HTTPException(status_code=400, detail={"code": "upstream_exists_400"})
        if response.status_code >= 500:
            raise HTTPException(status_code=502, detail={"code": "upstream_exists_5xx"})
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail={"code": "upstream_exists_unexpected_status"})

        body = _json_or_empty(response)
        if body is None:
            return True, None, None

        exists = _read_bool(body, ["exists", "Exists", "found", "isDuplicate"])
        if exists is None:
            exists = True

        return exists, _extract_job_id(body), body if isinstance(body, dict) else None

    async def exists(self, identity: CanonicalIdentityModel) -> tuple[bool, UUID | None, dict[str, Any] | None]:
        params = {
            "provider": identity.provider,
            "providerTenant": identity.providerTenant,
            "externalId": identity.externalId,
        }
        response = await self._safe_request("GET", "/jobs/exists", params=params)

        if response.status_code == 404:
            return False, None, None
        if response.status_code == 204:
            return True, None, None
        if response.status_code == 400:
            raise HTTPException(status_code=400, detail={"code": "upstream_exists_400"})
        if response.status_code >= 500:
            raise HTTPException(status_code=502, detail={"code": "upstream_exists_5xx"})
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail={"code": "upstream_exists_unexpected_status"})

        body = _json_or_empty(response)
        if body is None:
            # A 200 without a body is interpreted as existing, because the upstream accepted the identity.
            return True, None, None

        exists = _read_bool(body, ["exists", "Exists", "found", "isDuplicate"])
        if exists is None:
            # Conservative interpretation: a JSON object from /exists with 200 likely means found.
            exists = True
        job_id = _extract_job_id(body)
        return exists, job_id, body

    async def search(self, query: str, *, limit: int) -> list[JobSearchItem]:
        params = {"search": query, "pageSize": str(limit), "limit": str(limit)}
        response = await self._safe_request("GET", "/jobs", params=params)
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail={"code": "upstream_search_failed"})
        body = _json_or_empty(response)
        rows = _extract_list(body)
        return [_to_search_item(row) for row in rows[:limit] if isinstance(row, dict)]

    async def get_job(self, job_id: UUID) -> dict[str, Any]:
        response = await self._safe_request("GET", f"/jobs/{job_id}")
        if response.status_code == 404:
            raise HTTPException(status_code=404, detail={"code": "job_not_found"})
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail={"code": "upstream_get_failed"})
        body = _json_or_empty(response)
        if not isinstance(body, dict):
            raise HTTPException(status_code=502, detail={"code": "upstream_get_bad_body"})
        return body

    async def create_job(self, job: JobCreateRequest) -> tuple[str, UUID | None, dict[str, Any] | None]:
        payload = job.model_dump(mode="json", exclude_none=True)
        response = await self._safe_request("POST", "/jobs", json=payload)

        if response.status_code in (409, 208):
            body = _json_or_empty(response)
            return "existing", _extract_job_id(body), body if isinstance(body, dict) else None
        if response.status_code == 400:
            raise HTTPException(status_code=400, detail={"code": "upstream_create_400"})
        if response.status_code >= 500:
            raise HTTPException(status_code=502, detail={"code": "upstream_create_5xx"})
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail={"code": "upstream_create_unexpected_status"})

        body = _json_or_empty(response)
        job_id = _extract_job_id(body)
        outcome = "created"
        if isinstance(body, dict):
            body_outcome = str(body.get("outcome") or body.get("result") or "").lower()
            if body_outcome in {"existing", "duplicate", "already_exists"}:
                outcome = "existing"
            elif _read_bool(body, ["existing", "duplicate", "alreadyExists", "isDuplicate"]):
                outcome = "existing"
            elif response.status_code == 200 and _read_bool(body, ["created", "wasCreated", "isNew"]) is False:
                outcome = "existing"
        return outcome, job_id, body if isinstance(body, dict) else None

    async def mark_applied(self, job_id: UUID) -> None:
        response = await self._safe_request("PUT", f"/jobs/{job_id}/status", json={"status": "Applied"})
        if response.status_code == 404:
            raise HTTPException(status_code=404, detail={"code": "job_not_found"})
        if response.status_code == 400:
            raise HTTPException(status_code=400, detail={"code": "upstream_status_400"})
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail={"code": "upstream_status_failed"})

    async def _safe_request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        try:
            return await self._client.request(method, url, headers=self._headers(), **kwargs)
        except httpx.TimeoutException as exc:
            raise HTTPException(status_code=504, detail={"code": "upstream_timeout"}) from exc
        except httpx.TransportError as exc:
            raise HTTPException(status_code=502, detail={"code": "upstream_transport_error"}) from exc


def _json_or_empty(response: httpx.Response) -> Any | None:
    if not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        return None


def _extract_list(body: Any | None) -> list[Any]:
    if isinstance(body, list):
        return body
    if not isinstance(body, dict):
        return []
    for key in ["items", "jobs", "data", "results"]:
        value = body.get(key)
        if isinstance(value, list):
            return value
    return []


def _extract_job_id(body: Any | None) -> UUID | None:
    if not isinstance(body, dict):
        return None
    candidates = [
        body.get("jobId"),
        body.get("JobId"),
        body.get("id"),
        body.get("Id"),
        body.get("jobOfferingId"),
        body.get("JobOfferingId"),
    ]
    for nested_key in ["job", "jobOffering", "item", "data"]:
        nested = body.get(nested_key)
        if isinstance(nested, dict):
            candidates.extend(
                [
                    nested.get("jobId"),
                    nested.get("JobId"),
                    nested.get("id"),
                    nested.get("Id"),
                    nested.get("jobOfferingId"),
                    nested.get("JobOfferingId"),
                ]
            )
    for candidate in candidates:
        if candidate is None:
            continue
        try:
            return UUID(str(candidate))
        except ValueError:
            continue
    return None


def _read_bool(body: dict[str, Any], keys: list[str]) -> bool | None:
    for key in keys:
        value = body.get(key)
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.lower() in {"true", "false"}:
            return value.lower() == "true"
    return None


def _pick(row: dict[str, Any], *keys: str) -> Any | None:
    for key in keys:
        value = row.get(key)
        if value is not None:
            return value
    return None


def _to_search_item(row: dict[str, Any]) -> JobSearchItem:
    try:
        job_id = _extract_job_id(row)
    except ValueError:
        job_id = None

    return JobSearchItem(
        jobId=job_id,
        title=_pick(row, "title", "Title", "jobName", "JobName", "jobTitle", "JobTitle", "name", "Name"),
        company=_pick(
            row,
            "company",
            "Company",
            "companyName",
            "CompanyName",
            "hiringCompanyName",
            "HiringCompanyName",
            "postingCompanyName",
            "PostingCompanyName",
        ),
        status=_pick(
            row,
            "status",
            "Status",
            "currentStatus",
            "CurrentStatus",
            "userStatus",
            "UserStatus",
            "currentUserStatus",
            "CurrentUserStatus",
        ),
        provider=_pick(row, "provider", "Provider"),
        providerTenant=_pick(row, "providerTenant", "ProviderTenant"),
        externalId=_pick(row, "externalId", "ExternalId"),
        url=_pick(row, "url", "Url", "applyUrl", "ApplyUrl"),
    )
