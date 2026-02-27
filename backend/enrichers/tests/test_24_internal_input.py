# tests/test_24_internal_input.py

def test_internal_input(base_url, auth_headers, get_json, shared_state):
    run_id = shared_state["run_id"]
    url = f"{base_url}/api/internal/enrichment/runs/{run_id}/input"
    r = get_json(url, auth_headers)

    # If snapshot upload is now fixed, expect 200; otherwise expect snapshot missing.
    assert r.status_code in (200, 404, 409)

    if r.status_code == 200:
        data = r.json()
        assert isinstance(data, dict)

        # required shape
        assert "job" in data and isinstance(data["job"], dict)
        assert "cv" in data and isinstance(data["cv"], dict)

        # required content (non-empty)
        title = data["job"].get("title")
        desc = data["job"].get("description")
        cv_text = data["cv"].get("text")

        assert isinstance(title, str) and title.strip(), "job.title is missing/empty"
        assert isinstance(desc, str) and desc.strip(), "job.description is missing/empty"
        assert isinstance(cv_text, str) and cv_text.strip(), "cv.text is missing/empty"