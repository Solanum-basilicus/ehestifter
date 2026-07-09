from __future__ import annotations

from uuid import UUID

from conftest import JOB_ID


async def test_mark_applied_disabled_by_default(client, auth_headers, fake_jobs):
    response = await client.post(
        f"/v1/jobs/{JOB_ID}/mark-applied",
        headers=auth_headers,
        json={"confirm": "mark-applied"},
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "mark_applied_disabled"
    assert fake_jobs.mark_applied_calls == []


async def test_mark_applied_requires_exact_confirmation(client, auth_headers):
    response = await client.post(
        f"/v1/jobs/{JOB_ID}/mark-applied",
        headers=auth_headers,
        json={"confirm": "yes"},
    )
    assert response.status_code == 422


async def test_mark_applied_when_enabled(settings, fake_jobs, auth_headers):
    from httpx import ASGITransport, AsyncClient
    from ehjobs_proxy.main import create_app

    enabled_settings = settings.model_copy(
        update={"features": settings.features.model_copy(update={"allowMarkApplied": True})}
    )
    app = create_app(enabled_settings, jobs_client=fake_jobs)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as ac:
        response = await ac.post(
            f"/v1/jobs/{JOB_ID}/mark-applied",
            headers=auth_headers,
            json={"confirm": "mark-applied"},
        )
    assert response.status_code == 200
    body = response.json()
    assert body == {"outcome": "status_updated", "jobId": str(JOB_ID), "status": "Applied"}
    assert fake_jobs.mark_applied_calls == [UUID(str(JOB_ID))]
