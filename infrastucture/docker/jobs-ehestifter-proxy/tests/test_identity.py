from __future__ import annotations


async def test_greenhouse_identity(client, auth_headers):
    response = await client.post(
        "/v1/jobs/identity",
        headers=auth_headers,
        json={"url": "https://boards.greenhouse.io/example/jobs/123456"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["identity"] == {
        "provider": "greenhouse",
        "providerTenant": "example",
        "externalId": "123456",
    }
    assert body["confidence"] == "high"


async def test_unknown_identity_is_inconclusive_not_fake(client, auth_headers):
    response = await client.post(
        "/v1/jobs/identity",
        headers=auth_headers,
        json={"url": "https://example.com/jobs/senior-product-manager"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["identity"] is None
    assert body["confidence"] == "none"


async def test_rejects_private_literal_url(client, auth_headers):
    response = await client.post(
        "/v1/jobs/identity",
        headers=auth_headers,
        json={"url": "http://127.0.0.1/jobs/1"},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "bad_url_ip"
