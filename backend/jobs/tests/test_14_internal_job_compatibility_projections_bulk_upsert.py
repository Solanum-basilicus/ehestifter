# tests/test_14_internal_job_compatibility_projections_bulk_upsert.py
import uuid
import requests


def _url(base_url: str) -> str:
    return f"{base_url}/api/internal/jobs/compatibility-projections:bulk-upsert"


def _get_job(base_url: str, system_headers, job_id: str):
    url = f"{base_url}/api/jobs/{job_id}"
    r = requests.get(url, headers=system_headers)
    print("GET JOB:", r.status_code, r.text)
    return r


def _iso_z(s: str) -> str:
    # keep test payloads readable
    return s


def test_internal_compatibility_bulk_upsert_insert(base_url, system_headers, shared_state, test_user_id):
    assert "job_id" in shared_state, "Missing shared_state['job_id'] - ensure create test ran first"
    job_id = shared_state["job_id"]

    url = _url(base_url)
    payload = {
        "items": [
            {
                "jobId": job_id,
                "userId": test_user_id,
                "score": 7.4,
                "explanation": "Strong Python/Azure fit.",
                "calculatedAt": _iso_z("2026-03-17T10:00:00Z"),
            }
        ]
    }

    r = requests.post(url, headers=system_headers, json=payload)
    print("INSERT Response:", r.status_code, r.text)
    assert r.status_code == 200, r.text

    body = r.json()
    assert body["accepted"] == 1
    assert body["upserted"] == 1
    assert body["ignored"] == 0
    assert len(body["results"]) == 1
    assert body["results"][0]["jobId"].lower() == str(job_id).lower()
    assert body["results"][0]["userId"].lower() == str(test_user_id).lower()
    assert body["results"][0]["status"] in ("Inserted", "Updated")


def test_internal_compatibility_bulk_upsert_update_same_pair(base_url, system_headers, shared_state, test_user_id):
    assert "job_id" in shared_state, "Missing shared_state['job_id'] - ensure create test ran first"
    job_id = shared_state["job_id"]

    url = _url(base_url)
    payload = {
        "items": [
            {
                "jobId": job_id,
                "userId": test_user_id,
                "score": 8.1,
                "explanation": "Updated explanation after rerun.",
                "calculatedAt": _iso_z("2026-03-17T11:00:00Z"),
            }
        ]
    }

    r = requests.post(url, headers=system_headers, json=payload)
    print("UPDATE Response:", r.status_code, r.text)
    assert r.status_code == 200, r.text

    body = r.json()
    assert body["accepted"] == 1
    assert body["upserted"] == 1
    assert body["ignored"] == 0
    assert len(body["results"]) == 1
    assert body["results"][0]["jobId"].lower() == str(job_id).lower()
    assert body["results"][0]["userId"].lower() == str(test_user_id).lower()
    assert body["results"][0]["status"] == "Updated"


def test_internal_compatibility_bulk_upsert_ignores_stale(base_url, system_headers, shared_state, test_user_id):
    assert "job_id" in shared_state, "Missing shared_state['job_id'] - ensure create test ran first"
    job_id = shared_state["job_id"]

    url = _url(base_url)
    payload = {
        "items": [
            {
                "jobId": job_id,
                "userId": test_user_id,
                "score": 5.2,
                "explanation": "Older stale score that should be ignored.",
                "calculatedAt": _iso_z("2026-03-17T09:00:00Z"),
            }
        ]
    }

    r = requests.post(url, headers=system_headers, json=payload)
    print("STALE Response:", r.status_code, r.text)
    assert r.status_code == 200, r.text

    body = r.json()
    assert body["accepted"] == 1
    assert body["upserted"] == 0
    assert body["ignored"] == 1
    assert len(body["results"]) == 1
    assert body["results"][0]["status"] == "IgnoredStale"


def test_internal_compatibility_bulk_upsert_empty_list(base_url, system_headers):
    url = _url(base_url)
    payload = {"items": []}

    r = requests.post(url, headers=system_headers, json=payload)
    print("EMPTY Response:", r.status_code, r.text)
    assert r.status_code == 200, r.text

    body = r.json()
    assert body["accepted"] == 0
    assert body["upserted"] == 0
    assert body["ignored"] == 0
    assert body["results"] == []


def test_internal_compatibility_bulk_upsert_invalid_job_guid(base_url, system_headers, test_user_id):
    url = _url(base_url)
    payload = {
        "items": [
            {
                "jobId": "not-a-guid",
                "userId": test_user_id,
                "score": 7.4,
                "explanation": "Bad job id",
                "calculatedAt": _iso_z("2026-03-17T10:00:00Z"),
            }
        ]
    }

    r = requests.post(url, headers=system_headers, json=payload)
    print("INVALID JOB GUID Response:", r.status_code, r.text)
    assert r.status_code == 400, r.text

    body = r.json()
    assert body["message"] == "Validation failed"
    assert len(body["errors"]) >= 1
    assert any(err["error"] == "Invalid jobId GUID" for err in body["errors"])


def test_internal_compatibility_bulk_upsert_invalid_score(base_url, system_headers, shared_state, test_user_id):
    assert "job_id" in shared_state, "Missing shared_state['job_id'] - ensure create test ran first"
    job_id = shared_state["job_id"]

    url = _url(base_url)
    payload = {
        "items": [
            {
                "jobId": job_id,
                "userId": test_user_id,
                "score": 11.2,
                "explanation": "Out of range score",
                "calculatedAt": _iso_z("2026-03-17T10:00:00Z"),
            }
        ]
    }

    r = requests.post(url, headers=system_headers, json=payload)
    print("INVALID SCORE Response:", r.status_code, r.text)
    assert r.status_code == 400, r.text

    body = r.json()
    assert body["message"] == "Validation failed"
    assert len(body["errors"]) >= 1
    assert any("score must be between 0.0 and 10.0" in err["error"] for err in body["errors"])


def test_internal_compatibility_bulk_upsert_duplicate_same_pair_keeps_newest(base_url, system_headers, shared_state, test_user_id):
    assert "job_id" in shared_state, "Missing shared_state['job_id'] - ensure create test ran first"
    job_id = shared_state["job_id"]

    url = _url(base_url)
    payload = {
        "items": [
            {
                "jobId": job_id,
                "userId": test_user_id,
                "score": 6.3,
                "explanation": "Older duplicate within same request.",
                "calculatedAt": _iso_z("2026-03-17T12:00:00Z"),
            },
            {
                "jobId": job_id,
                "userId": test_user_id,
                "score": 8.7,
                "explanation": "Newest duplicate within same request.",
                "calculatedAt": _iso_z("2026-03-17T12:30:00Z"),
            },
        ]
    }

    r = requests.post(url, headers=system_headers, json=payload)
    print("DUPLICATE SAME PAIR Response:", r.status_code, r.text)
    assert r.status_code == 200, r.text

    body = r.json()
    assert body["accepted"] == 1
    assert body["upserted"] == 1
    assert body["ignored"] == 0
    assert len(body["results"]) == 1
    assert body["results"][0]["status"] == "Updated"


def test_internal_compatibility_bulk_upsert_invalid_datetime(base_url, system_headers, shared_state, test_user_id):
    assert "job_id" in shared_state, "Missing shared_state['job_id'] - ensure create test ran first"
    job_id = shared_state["job_id"]

    url = _url(base_url)
    payload = {
        "items": [
            {
                "jobId": job_id,
                "userId": test_user_id,
                "score": 7.0,
                "explanation": "Bad datetime",
                "calculatedAt": "2026-03-17 10:00:00",
            }
        ]
    }

    r = requests.post(url, headers=system_headers, json=payload)
    print("INVALID DATETIME Response:", r.status_code, r.text)
    assert r.status_code == 400, r.text

    body = r.json()
    assert body["message"] == "Validation failed"
    assert len(body["errors"]) >= 1
    assert any("calculatedAt must include timezone info" in err["error"] for err in body["errors"])

