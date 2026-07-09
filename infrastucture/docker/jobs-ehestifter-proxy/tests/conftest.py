from __future__ import annotations

from uuid import UUID

import pytest
from httpx import ASGITransport, AsyncClient

from ehjobs_proxy.main import create_app
from ehjobs_proxy.settings import Settings

TOKEN = "test-local-token"
JOB_ID = UUID("11111111-1111-1111-1111-111111111111")


class FakeJobsClient:
    def __init__(self) -> None:
        self.exists_result = (False, None, None)
        self.create_result = ("created", JOB_ID, None)
        self.search_result = []
        self.get_result = {"jobId": str(JOB_ID), "description": "hello"}
        self.exists_calls = []
        self.create_calls = []
        self.mark_applied_calls = []

    async def exists(self, identity):
        self.exists_calls.append(identity)
        return self.exists_result

    async def create_job(self, job):
        self.create_calls.append(job)
        return self.create_result

    async def search(self, query: str, *, limit: int):
        return self.search_result

    async def get_job(self, job_id):
        return self.get_result

    async def mark_applied(self, job_id):
        self.mark_applied_calls.append(job_id)


@pytest.fixture
def settings() -> Settings:
    return Settings.model_validate(
        {
            "server": {"tls": {"enabled": False}},
            "agentAuth": {"bearerToken": TOKEN},
            "ehestifter": {
                "jobsBaseUrl": "https://ehestifter-jobs.azurewebsites.net/api",
                "jobsFunctionKey": "upstream-secret",
                "userId": "00000000-0000-0000-0000-000000000001",
            },
            "features": {
                "allowCreate": True,
                "allowMarkApplied": False,
                "allowUrlIdentityGuess": True,
            },
        }
    )


@pytest.fixture
def fake_jobs() -> FakeJobsClient:
    return FakeJobsClient()


@pytest.fixture
async def client(settings: Settings, fake_jobs: FakeJobsClient):
    app = create_app(settings, jobs_client=fake_jobs)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac


@pytest.fixture
def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


def create_payload() -> dict:
    return {
        "url": "https://boards.greenhouse.io/example/jobs/123456",
        "applyUrl": "https://boards.greenhouse.io/example/jobs/123456",
        "foundOn": "career-ops",
        "provider": "greenhouse",
        "providerTenant": "example",
        "externalId": "123456",
        "title": "Senior Product Manager",
        "hiringCompanyName": "Example GmbH",
        "postingCompanyName": None,
        "remoteType": "Hybrid",
        "description": "Full description",
        "locations": [
            {
                "countryName": "Germany",
                "countryCode": "DE",
                "cityName": "Berlin",
                "region": None,
            }
        ],
    }
