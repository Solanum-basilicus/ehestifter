# tests/test_13_internal_job_snapshot_get.py
import requests
import uuid


def _expected_company_name(hiring: str, posting: str | None) -> str:
    if posting is not None and str(posting).strip() != "":
        return f"{hiring} (through agency {posting})"
    return hiring


def test_internal_job_snapshot_get_matches_jobs_get(base_url, system_headers, shared_state):
    assert "job_id" in shared_state, "Missing shared_state['job_id'] - ensure create test ran first"
    job_id = shared_state["job_id"]

    # 1) Fetch full job
    full_url = f"{base_url}/api/jobs/{job_id}"
    r_full = requests.get(full_url, headers=system_headers)
    print("FULL Response:", r_full.status_code, r_full.text)
    assert r_full.status_code == 200, r_full.text
    full = r_full.json()

    # Schema in SQL: HiringCompanyName NOT NULL, PostingCompanyName NULL, Title NULL, Description NULL
    hiring = full.get("HiringCompanyName")
    posting = full.get("PostingCompanyName")
    title = full.get("Title")
    description = full.get("Description")

    assert hiring is not None and str(hiring).strip() != "", "HiringCompanyName missing/empty in /jobs/{id}"

    # 2) Fetch snapshot
    snap_url = f"{base_url}/api/internal/jobs/{job_id}/snapshot"
    r_snap = requests.get(snap_url, headers=system_headers)
    print("SNAP Response:", r_snap.status_code, r_snap.text)
    assert r_snap.status_code == 200, r_snap.text
    snap = r_snap.json()

    # 3) Validate snapshot shape
    for k in ("jobId", "jobName", "companyName", "jobDescription"):
        assert k in snap, f"Snapshot missing key '{k}': {snap}"

    # 4) Validate values vs full payload
    assert snap["jobId"].lower() == str(job_id).lower()
    assert snap["jobName"] == title
    assert snap["jobDescription"] == description
    assert snap["companyName"] == _expected_company_name(hiring, posting)


def test_internal_job_snapshot_get_404_for_unknown_job(base_url, system_headers):
    missing_id = str(uuid.uuid4()).upper()
    url = f"{base_url}/api/internal/jobs/{missing_id}/snapshot"
    r = requests.get(url, headers=system_headers)
    print("Missing snapshot:", r.status_code, r.text)
    assert r.status_code == 404