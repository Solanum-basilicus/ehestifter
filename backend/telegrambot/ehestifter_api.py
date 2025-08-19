import os, httpx
from dataclasses import dataclass
from typing import Optional, Tuple, List

API_BASE = os.getenv("EHESTIFTER_API_BASE")
USERS_BASE = os.getenv("EHESTIFTER_USERS_API_BASE_URL")
FUNC_KEY  = os.getenv("EHESTIFTER_USERS_FUNCTION_KEY")  

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

    async def is_linked(self, telegram_user_id: int) -> bool:
        # GET /users/by-telegram/{id} or 404 if not linked
        r = await self.client.get(f"{USERS_BASE}/api/users/by-telegram/{telegram_user_id}")
        return r.status_code == 200

    async def link_telegram(self, code: str, telegram_user_id: int) -> tuple[bool, str]:
        r = await self.client.post(f"{USERS_BASE}/api/users/link-telegram",
            json={"code": code, "telegram_user_id": telegram_user_id})
        if r.status_code == 200:
            return True, "ok"
        return False, r.text

    async def mark_applied_by_url(self, telegram_user_id: int, url: str) -> tuple[Optional[ApiJob], Optional[str]]:
        # POST /user-statuses/applied-by-url
        r = await self.client.post(f"{API_BASE}/user-statuses/applied-by-url",
            json={"telegram_user_id": telegram_user_id, "url": url})
        if r.status_code != 200:
            return None, None
        data = r.json()
        job = ApiJob(id=data["jobId"], title=data["title"], company=data["company"])
        return job, data["link"]

    async def search_jobs_for_user(self, telegram_user_id: int, q: str, limit: int) -> list[ApiJob]:
        # GET /jobs?q=...&user_id=...&limit=...
        r = await self.client.get(f"{API_BASE}/jobs", params={
            "q": q, "user_id": telegram_user_id, "limit": limit
        })
        r.raise_for_status()
        items = r.json().get("items", r.json())
        return [ApiJob(id=i["id"], title=i["title"], company=i["company"]) for i in items]

    async def update_user_status(self, telegram_user_id: int, job_id: int, new_status: str) -> tuple[bool, Optional[str]]:
        r = await self.client.post(f"{API_BASE}/user-statuses",
            json={"telegram_user_id": telegram_user_id, "job_id": job_id, "status": new_status})
        if r.status_code == 200:
            return True, r.json().get("link")
        return False, None

    async def list_user_active_jobs(self, telegram_user_id: int, q: str | None, limit: int, offset: int):
        r = await self.client.get(f"{API_BASE}/jobs", params={
            "user_id": telegram_user_id,
            "exclude_final": True,
            "q": q or "",
            "limit": limit,
            "offset": offset,
            "sort": "-first_seen_at",
        })
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
