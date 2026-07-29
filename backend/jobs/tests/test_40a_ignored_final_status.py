import uuid
import warnings

import pytest
import requests


def _job_ids_from_list_response(response: requests.Response) -> list[str]:
    assert response.status_code == 200, response.text
    payload = response.json()
    assert isinstance(payload, dict), "Jobs list response is not an envelope object"
    items = payload.get("items")
    assert isinstance(items, list), "Jobs list envelope has no items array"
    return [item.get("Id") for item in items if isinstance(item, dict)]


def _jobs_with_statuses(
    base_url: str,
    user_headers: dict,
    test_user_id: str,
    query: str,
) -> list[dict]:
    response = requests.get(
        f"{base_url}/api/jobs/with-statuses",
        headers=user_headers,
        params={
            "userId": test_user_id,
            "q": query,
            "limit": 10,
            "offset": 0,
        },
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert isinstance(payload, list), "Jobs-with-statuses response is not an array"
    return payload


def _set_status(
    base_url: str,
    user_headers: dict,
    job_id: str,
    status: str,
) -> dict:
    response = requests.put(
        f"{base_url}/api/jobs/{job_id}/status",
        headers=user_headers,
        json={"status": status},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload.get("jobId") == job_id
    assert payload.get("status") == status
    return payload


@pytest.fixture
def ignored_final_job(base_url, user_headers, system_headers, request):
    token = f"issue-9-ignored-{uuid.uuid4().hex}"
    response = requests.post(
        f"{base_url}/api/jobs",
        headers=user_headers,
        json={
            "url": f"https://example.com/jobs/{token}",
            "foundOn": "integration-test",
            "provider": "integration-test",
            "providerTenant": "issue-9",
            "externalId": token,
            "hiringCompanyName": "Ehestifter Integration Test",
            "title": token,
        },
    )
    assert response.status_code in (200, 201), response.text
    payload = response.json()
    job_id = payload.get("id")
    assert job_id, "Create response is missing job id"

    def cleanup() -> None:
        cleanup_response = requests.delete(
            f"{base_url}/api/jobs/{job_id}",
            headers=system_headers,
        )
        if cleanup_response.status_code not in (200, 404):
            warnings.warn(
                f"Could not clean up issue #9 regression job {job_id}: "
                f"HTTP {cleanup_response.status_code}: {cleanup_response.text}",
                stacklevel=1,
            )

    request.addfinalizer(cleanup)
    return {"id": job_id, "token": token}


def test_ignored_is_excluded_from_active_job_lists(
    base_url,
    user_headers,
    test_user_id,
    ignored_final_job,
):
    job_id = ignored_final_job["id"]
    token = ignored_final_job["token"]

    _set_status(base_url, user_headers, job_id, "Applied")

    my_before = requests.get(
        f"{base_url}/api/jobs",
        headers=user_headers,
        params={
            "category": "my",
            "q": token,
            "search_field": "title",
            "sort": "created_desc",
            "limit": 10,
            "offset": 0,
        },
    )
    assert job_id in _job_ids_from_list_response(my_before)

    active_before = _jobs_with_statuses(
        base_url,
        user_headers,
        test_user_id,
        token,
    )
    assert job_id in [item.get("Id") for item in active_before]

    _set_status(base_url, user_headers, job_id, "Ignored")

    my_after = requests.get(
        f"{base_url}/api/jobs",
        headers=user_headers,
        params={
            "category": "my",
            "q": token,
            "search_field": "title",
            "sort": "created_desc",
            "limit": 10,
            "offset": 0,
        },
    )
    assert job_id not in _job_ids_from_list_response(my_after)

    active_after = _jobs_with_statuses(
        base_url,
        user_headers,
        test_user_id,
        token,
    )
    assert job_id not in [item.get("Id") for item in active_after]

    all_after = requests.get(
        f"{base_url}/api/jobs",
        headers=user_headers,
        params={
            "category": "all",
            "q": token,
            "search_field": "title",
            "sort": "created_desc",
            "limit": 10,
            "offset": 0,
        },
    )
    assert all_after.status_code == 200, all_after.text
    all_items = all_after.json().get("items", [])
    ignored_job = next((item for item in all_items if item.get("Id") == job_id), None)
    assert ignored_job is not None, "Ignored job should remain available in category=all"
    assert ignored_job.get("UserStatus") == "Ignored"
