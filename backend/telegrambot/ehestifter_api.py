import os, httpx
from httpx import HTTPError
import logging
from dataclasses import dataclass
from dotenv import load_dotenv
from typing import Optional, Tuple, List
import urllib.parse
from types import SimpleNamespace


def _require_url(name: str) -> str:
    v = os.getenv(name)
    if not v or not v.startswith(("http://", "https://")):
        raise ValueError(f"{name} is missing or does not start with http(s):// (got: {v!r})")
    return v.rstrip("/")

load_dotenv()

JOBS_BASE = _require_url("EHESTIFTER_JOBS_BASE_URL") 
JOBS_BOT_KEY = os.getenv("EHESTIFTER_JOBS_BOT_FUNCTION_KEY") 
USERS_BASE = _require_url("EHESTIFTER_USERS_BASE_URL")
USERS_BOT_KEY  = os.getenv("EHESTIFTER_USERS_BOT_FUNCTION_KEY")


@dataclass
class ApiJob:
    id: str
    title: str
    company: str

@dataclass
class ApiListedJob(ApiJob):
    user_status: str
    first_seen_at: str
    link: str

class ApiError(Exception):
    """Raised when backend API returns non-success or network fails."""
    def __init__(self, endpoint: str, status: Optional[int] = None, body: Optional[str] = None, detail: Optional[str] = None):
        self.endpoint = endpoint
        self.status = status
        self.body = body
        self.detail = detail
        msg = f"API error at {endpoint} (status={status})"
        if detail:
            msg += f": {detail}"
        super().__init__(msg)

    def to_dict(self):
        return {
            "endpoint": self.endpoint,
            "status": self.status,
            "body": (self.body[:500] + "…") if self.body and len(self.body) > 500 else self.body,
            "detail": self.detail,
        }

class EhestifterApi:
    def __init__(self):
        self.client = httpx.AsyncClient(timeout=10.0)
        self._uid_cache: dict[int, str] = {}  # telegram_user_id -> user_id cache

    def _user_hdr(self):
        return {"x-functions-key": USERS_BOT_KEY} if USERS_BOT_KEY else {}

    def _jobs_hdr(self):
        return {"x-functions-key": JOBS_BOT_KEY} if JOBS_BOT_KEY else {}

    def _get_any(self, d, *keys, default=None):
        """Direct key chain (fast, deterministic), then case-insensitive fallback. Safe on non-dicts."""
        if not isinstance(d, dict):
            return default
        for k in keys:
            if k in d and d[k] is not None:
                return d[k]
        # Case-insensitive fallback
        lower_map = { (dk.lower() if isinstance(dk, str) else dk): dv for dk, dv in d.items() }
        for k in keys:
            v = lower_map.get(k.lower())
            if v is not None:
                return v
        return default

    def _normalize_job_basic(self, item) -> tuple[str | None, str | None, str | None]:
        """
        Returns (id, title, company) from a possibly-nested/renamed shape, case-insensitive.
        If id is missing, returns (None, title, company). Title/company may be None.
        Supports:
          - bare fields: id/title/company
          - alt names: jobId/job_id/Id, jobTitle/name/Title, company/HiringCompanyName/company_name/employer
          - nested under 'job': { job: { id/title/company, ... }, user_status: ... }
        """
        if not isinstance(item, dict):
            return None, None, None
        base = item.get("job") if isinstance(item.get("job"), dict) else item
        # Your current API shape prefers: Id, Title, HiringCompanyName
        job_id = self._get_any(base, "Id", "id", "jobId", "job_id")
        title = self._get_any(base, "Title", "title", "jobTitle", "name")
        company = self._get_any(base, "HiringCompanyName", "Company", "company",
                                "company_name", "employer", "employerName")
        return job_id, title, company

    def _normalize_user_fields(self, item: dict) -> tuple[str, str]:
        """Extract user-specific fields with fallbacks."""
        user_status = self._get_any(item, "user_status", "status", "userStatus", default="?")
        first_seen = self._get_any(item, "first_seen_at", "FirstSeenAt", "firstSeenAt",
                                   "applied_at", "appliedAt", default="")
        return user_status, first_seen

    async def _safe_get(self, url: str, headers: dict, params: dict | None = None):
        try:
            r = await self.client.get(url, headers=headers, params=params)
        except HTTPError as e:
            raise ApiError(url, detail=str(e)) from e
        if r.status_code >= 400:
            raise ApiError(url, status=r.status_code, body=r.text)
        return r

    async def _safe_post(self, url: str, headers: dict, json: dict):
        try:
            r = await self.client.post(url, headers=headers, json=json)
        except HTTPError as e:
            raise ApiError(url, detail=str(e)) from e
        if r.status_code >= 400:
            raise ApiError(url, status=r.status_code, body=r.text)
        return r

    async def _safe_put(self, url: str, headers: dict, json: dict):
        try:
            r = await self.client.put(url, headers=headers, json=json)
        except HTTPError as e:
            raise ApiError(url, detail=str(e)) from e
        if r.status_code >= 400:
            raise ApiError(url, status=r.status_code, body=r.text)
        return r

    async def _resolve_user_id(self, telegram_user_id: int) -> str:
        """Resolve and cache internal user_id from telegram_user_id via Users API."""
        if telegram_user_id in self._uid_cache:
            return self._uid_cache[telegram_user_id]
        url = f"{USERS_BASE}/users/by-telegram/{telegram_user_id}"
        r = await self._safe_get(url, headers=self._user_hdr())
        # Expecting JSON like {"userId": "<guid or int>"}
        try:
            data = r.json()
            user_id = data.get("userId") or data.get("id") or data.get("Id")
        except Exception:
            user_id = None
        if not user_id:
            # Treat as deviation: endpoint should return an id on 200
            raise ApiError(url, status=500, body="Users API did not return userId")
        self._uid_cache[telegram_user_id] = str(user_id)
        return str(user_id)

    async def is_linked(self, telegram_user_id: int) -> bool:
        url = f"{USERS_BASE}/users/by-telegram/{telegram_user_id}"
        try:
            r = await self.client.get(url, headers=self._user_hdr())
        except HTTPError as e:
            raise ApiError(url, detail=str(e)) from e
        if r.status_code == 200:
            return True
        if r.status_code == 404:
            return False  # not linked is a normal state
        # everything else is a deviation
        raise ApiError(url, status=r.status_code, body=r.text)

    async def link_telegram(self, code: str, telegram_user_id: int) -> tuple[bool, str]:
        url = f"{USERS_BASE}/users/link-telegram"
        r = await self._safe_post(url, headers=self._user_hdr(),
                                  json={"code": code, "telegram_user_id": telegram_user_id})
        # If we got here, it's 2xx
        return True, "ok"

    async def mark_applied_by_url(self, telegram_user_id: int, url: str):
        ep = f"{JOBS_BASE}/user-statuses/applied-by-url"
        r = await self._safe_post(ep, headers=self._jobs_hdr(),
                                  json={"telegram_user_id": telegram_user_id, "url": url})
        data = r.json()
        job = ApiJob(id=data["jobId"], title=data["title"], company=data["company"])
        return job, data["link"]

    async def search_jobs_for_user(self, telegram_user_id: int, q: str, limit: int):
        ep = f"{JOBS_BASE}/jobs"
        r = await self._safe_get(
            ep,
            headers=self._jobs_hdr(),
            params={"q": q, "user_id": telegram_user_id, "limit": limit},
        )
        payload = r.json()
        items = payload if isinstance(payload, list) else payload.get("items", payload)
        if not isinstance(items, list):
            items = []
        result: list[ApiJob] = []
        for raw in items:
            if not isinstance(raw, dict):
                continue
            job_id, title, company = self._normalize_job_basic(raw)
            if job_id is None:
                # Skip malformed entries quietly
                continue
            result.append(ApiJob(
                id=job_id,
                title=title or "?",
                company=company or "?"
            ))
        return result

    async def update_user_status(self, telegram_user_id: int, job_id: str, new_status: str):
        """Use existing Jobs endpoint that expects internal user_id."""
        user_id = await self._resolve_user_id(telegram_user_id)
        ep = f"{JOBS_BASE}/jobs/{job_id}/status"
        # Jobs API expects the user id in header X-User-Id (not the body).
        hdrs = self._jobs_hdr().copy()
        hdrs["X-User-Id"] = str(user_id)
        r = await self._safe_put(ep, headers=hdrs, json={"status": new_status})
        # Optional: backend may return {link: "..."}; tolerate absence
        try:
            return r.json().get("link")
        except Exception:
            return None

    async def unlink_telegram(
        self,
        telegram_user_id: int,
        b2c_object_id: str | None = None,
    ) -> tuple[bool, str]:
        """
        POST {USERS_BASE}/users/unlink-telegram
        Returns (True, "ok") on any 2xx; raises ApiError otherwise (via _safe_post).

        Notes:
        - If your API requires a bot key (Azure Function uses require_bot_key),
        this will use self._bot_hdr() when available; otherwise it falls back
        to self._user_hdr() to match link_telegram's style.
        """
        url = f"{USERS_BASE}/users/unlink-telegram"
        payload = {"telegram_user_id": telegram_user_id}
        if b2c_object_id:
            payload["b2c_object_id"] = b2c_object_id

        # Prefer bot headers if your client exposes them; else mirror link_telegram
        hdr_fn = getattr(self, "_bot_hdr", None) or getattr(self, "_user_hdr", None)
        headers = hdr_fn() if hdr_fn else None

        # _safe_post should raise ApiError on non-2xx, matching link_telegram behavior
        await self._safe_post(url, headers=headers, json=payload)
        return True, "ok"

    async def list_user_active_jobs(
        self,
        telegram_user_id: int,
        q: str | None = None,
        limit: int = 10,
        offset: int = 0,
    ) -> tuple[list[SimpleNamespace], int | None]:
        """
        Uses Jobs API: GET /jobs/with-statuses?userId=...&q=...&limit=...&offset=...
        Returns: ([items], next_offset or None)
        """
        user_id = await self._resolve_user_id(telegram_user_id)
        params = [
            ("userId", user_id),
            ("limit", str(limit)),
            ("offset", str(offset)),
        ]
        if q:
            params.append(("q", q))
        qs = "&".join(f"{k}={urllib.parse.quote_plus(v)}" for k, v in params)
        url = f"{JOBS_BASE}/jobs/with-statuses?{qs}"

        r = await self._safe_get(url, headers=self._jobs_hdr())
        data = r.json() or []
        if not isinstance(data, list):
            raise ApiError(url, status=r.status_code, body=f"Invalid payload: {data}")

        items: list[SimpleNamespace] = []
        for it in data:
            # Prefer HiringCompanyName, fall back to PostingCompanyName, then "?"
            company = it.get("HiringCompanyName") or it.get("PostingCompanyName") or "?"
            link = it.get("FoundOn") or it.get("ExternalId") or ""
            items.append(
                SimpleNamespace(
                    id=it.get("Id"),
                    title=it.get("Title"),
                    company=company,
                    user_status=it.get("userStatus"),
                    first_seen_at=it.get("FirstSeenAt"),
                    link=link,
                )
            )

        # Simple pagination heuristic: if we got a full page, offer next page
        next_offset: int | None = offset + len(items) if len(items) == limit else None
        return items, next_offset