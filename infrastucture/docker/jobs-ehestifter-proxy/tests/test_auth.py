from __future__ import annotations


async def test_healthz_does_not_require_auth(client):
    response = await client.get("/healthz")
    assert response.status_code == 200
    assert response.json()["ok"] is True


async def test_v1_requires_auth(client):
    response = await client.get("/v1/jobs/search?q=test")
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "missing_authorization"


async def test_v1_rejects_wrong_auth(client):
    response = await client.get("/v1/jobs/search?q=test", headers={"Authorization": "Bearer wrong"})
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "bad_authorization"
