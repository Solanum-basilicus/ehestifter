import os, httpx
from dataclasses import dataclass
from typing import Optional, Tuple, List


def _require_url(name: str) -> str:
    v = os.getenv(name)
    if not v or not v.startswith(("http://", "https://")):
        raise ValueError(f"{name} is missing or does not start with http(s):// (got: {v!r})")
    return v.rstrip("/")

API_BASE = _require_url("EHESTIFTER_JOBS_BASE_URL") 
USERS_BASE = _require_url("EHESTIFTER_USERS_BASE_URL")
USERS_BOT_KEY  = os.getenv("EHESTIFTER_USERS_BOT_FUNCTION_KEY")
JOBS_FUNC_KEY = os.getenv("EHESTIFTER_JOBS_BOT_FUNCTION_KEY") 

@dataclass
class ApiJob:
    id: int
    title: str
    company: str

@dataclass
class ApiListedJob(ApiJob):
    user_status: str
    first_seen_at: str
    link: str

class EhestifterApi:
    def __init__(self):
        self.client = httpx.AsyncClient(timeout=10.0)

    def _user_hdr(self):
        return {"x-functions-key": USERS_BOT_KEY} if USERS_BOT_KEY else {}

    def _jobs_hdr(self):
        return {"x-functions-key": JOBS_FUNC_KEY} if JOBS_FUNC_KEY else {}

    async def is_linked(self, telegram_user_id: int) -> bool:
        r = await self.client.get(f"{USERS_BASE}/users/by-telegram/{telegram_user_id}", headers=self._user_hdr())
        return r.status_code == 200

    async def link_telegram(self, code: str, telegram_user_id: int) -> tuple[bool, str]:
        r = await self.client.post(f"{USERS_BASE}/users/link-telegram",
                                   headers=self._user_hdr(),
                                   json={"code": code, "telegram_user_id": telegram_user_id})
        if r.status_code == 200:
            return True, "ok"
        return False, r.text

    async def mark_applied_by_url(self, telegram_user_id: int, url: str):
        r = await self.client.post(f"{API_BASE}/user-statuses/applied-by-url",
                                   headers=self._jobs_hdr(),
                                   json={"telegram_user_id": telegram_user_id, "url": url})
        if r.status_code != 200:
            return None, None
        data = r.json()
        job = ApiJob(id=data["jobId"], title=data["title"], company=data["company"])
        return job, data["link"]

    async def search_jobs_for_user(self, telegram_user_id: int, q: str, limit: int):
        r = await self.client.get(f"{API_BASE}/jobs",
                                  headers=self._jobs_hdr(),
                                  params={"q": q, "user_id": telegram_user_id, "limit": limit})
        r.raise_for_status()
        items = r.json().get("items", r.json())
        return [ApiJob(id=i["id"], title=i["title"], company=i["company"]) for i in items]

    async def update_user_status(self, telegram_user_id: int, job_id: int, new_status: str):
        r = await self.client.post(f"{API_BASE}/user-statuses",
                                   headers=self._jobs_hdr(),
                                   json={"telegram_user_id": telegram_user_id, "job_id": job_id, "status": new_status})
        if r.status_code == 200:
            return True, r.json().get("link")
        return False, None

    async def list_user_active_jobs(self, telegram_user_id: int, q: str | None, limit: int, offset: int):
        r = await self.client.get(f"{API_BASE}/jobs",
                                  headers=self._jobs_hdr(),
                                  params={"user_id": telegram_user_id, "exclude_final": True,
                                          "q": q or "", "limit": limit, "offset": offset, "sort": "-first_seen_at"})
        r.raise_for_status()
        payload = r.json()
        items = payload.get("items", payload)
        next_offset = offset + limit if len(items) == limit else None
        def link_of(i): return f"https://ehestifter.azurewebsites.net/jobs/{i['id']}"
        mapped = [ApiListedJob(
            id=i["id"], title=i["title"], company=i["company"],
            user_status=i.get("user_status","?"),
            first_seen_at=i.get("first_seen_at",""),
            link=link_of(i)
        ) for i in items]
        return mapped, next_offset