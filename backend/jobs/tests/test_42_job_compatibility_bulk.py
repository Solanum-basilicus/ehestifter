import requests
import uuid


def test_post_job_compatibility_bulk_returns_seeded_score(base_url, user_headers, shared_state, test_user_id):
    assert "compatibility_job_id" in shared_state, (
        "Missing shared_state['compatibility_job_id'] - seed it in earlier internal compatibility write tests"
    )
    assert "compatibility_score" in shared_state, (
        "Missing shared_state['compatibility_score'] - seed it in earlier internal compatibility write tests"
    )

    job_id = shared_state["compatibility_job_id"]
    expected_score = float(shared_state["compatibility_score"])

    url = f"{base_url}/api/jobs/compatibility"
    r = requests.post(url, headers=user_headers, json={"jobIds": [job_id]})

    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 200, r.text

    data = r.json()
    assert "userId" in data
    assert data["userId"].lower() == test_user_id.lower()
    assert "compatibility" in data
    assert isinstance(data["compatibility"], dict)
    assert job_id in data["compatibility"]

    row = data["compatibility"][job_id]
    assert row is not None, "Expected seeded compatibility projection, got null"
    assert isinstance(row, dict), "Compatibility payload per job must be an object"
    assert "score" in row
    assert "calculatedAt" in row
    assert float(row["score"]) == expected_score
    assert row["calculatedAt"] is not None


def test_post_job_compatibility_bulk_returns_null_for_unknown_job(base_url, user_headers, test_user_id):
    unknown_job_id = str(uuid.uuid4())

    url = f"{base_url}/api/jobs/compatibility"
    r = requests.post(url, headers=user_headers, json={"jobIds": [unknown_job_id]})

    print("Response text:", r.text, " with status ", r.status_code, end=" ")
    assert r.status_code == 200, r.text

    data = r.json()
    assert "userId" in data
    assert data["userId"].lower() == test_user_id.lower()
    assert "compatibility" in data
    assert isinstance(data["compatibility"], dict)
    assert unknown_job_id.lower() in [k.lower() for k in data["compatibility"].keys()]

    # normalize lookup because API may canonicalize GUID casing
    returned = None
    for k, v in data["compatibility"].items():
        if k.lower() == unknown_job_id.lower():
            returned = v
            break

    assert returned is None