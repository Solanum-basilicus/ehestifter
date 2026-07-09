from __future__ import annotations

from conftest import JOB_ID, create_payload


async def test_create_preflights_and_returns_existing_without_create(client, auth_headers, fake_jobs):
    fake_jobs.exists_result = (True, JOB_ID, None)
    response = await client.post("/v1/jobs", headers=auth_headers, json=create_payload())
    assert response.status_code == 200
    body = response.json()
    assert body["outcome"] == "existing"
    assert body["jobId"] == str(JOB_ID)
    assert "statusChanged" not in body
    assert len(fake_jobs.exists_calls) == 1
    assert fake_jobs.create_calls == []


async def test_create_calls_upstream_when_missing(client, auth_headers, fake_jobs):
    fake_jobs.exists_result = (False, None, None)
    fake_jobs.create_result = ("created", JOB_ID, None)
    response = await client.post("/v1/jobs", headers=auth_headers, json=create_payload())
    assert response.status_code == 200
    body = response.json()
    assert body["outcome"] == "created"
    assert body["jobId"] == str(JOB_ID)
    assert len(fake_jobs.exists_calls) == 1
    assert len(fake_jobs.create_calls) == 1


async def test_duplicate_create_is_existing_success(client, auth_headers, fake_jobs):
    fake_jobs.exists_result = (False, None, None)
    fake_jobs.create_result = ("existing", JOB_ID, None)
    response = await client.post("/v1/jobs", headers=auth_headers, json=create_payload())
    assert response.status_code == 200
    body = response.json()
    assert body["outcome"] == "existing"
    assert body["jobId"] == str(JOB_ID)


async def test_create_rejects_unknown_fields(client, auth_headers):
    payload = create_payload()
    payload["surprise"] = "nope"
    response = await client.post("/v1/jobs", headers=auth_headers, json=payload)
    assert response.status_code == 422
