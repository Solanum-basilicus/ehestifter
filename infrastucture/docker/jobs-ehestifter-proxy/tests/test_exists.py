from __future__ import annotations

from conftest import JOB_ID


async def test_exists_uses_explicit_identity(client, auth_headers, fake_jobs):
    fake_jobs.exists_result = (True, JOB_ID, None)
    response = await client.post(
        "/v1/jobs/exists",
        headers=auth_headers,
        json={"provider": "greenhouse", "providerTenant": "example", "externalId": "123456"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["exists"] is True
    assert body["jobId"] == str(JOB_ID)
    assert len(fake_jobs.exists_calls) == 1


async def test_exists_can_derive_identity_from_url(client, auth_headers, fake_jobs):
    fake_jobs.exists_result = (False, None, None)
    response = await client.post(
        "/v1/jobs/exists",
        headers=auth_headers,
        json={"url": "https://jobs.lever.co/example/abcdef"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["exists"] is False
    assert body["canonicalIdentity"]["provider"] == "lever"
    assert body["canonicalIdentity"]["providerTenant"] == "example"
    assert body["canonicalIdentity"]["externalId"] == "abcdef"


async def test_exists_rejects_missing_identity(client, auth_headers):
    response = await client.post("/v1/jobs/exists", headers=auth_headers, json={})
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "bad_identity"
