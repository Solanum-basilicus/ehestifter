import requests


def test_jobs_create_idempotent(
    base_url,
    system_headers,
    shared_state,
    test_job_url,
):
    assert "job_id" in shared_state, "Job not created"

    expected_job_id = shared_state["job_id"]
    jobs_url = f"{base_url}/api/jobs"

    # First duplicate create adds Berlin.
    first_payload = {
        "url": test_job_url,
        "locations": [
            {
                "countryName": "Germany",
                "countryCode": "DE",
                "cityName": "Berlin",
                "region": "Berlin",
            }
        ],
    }

    first_response = requests.post(
        jobs_url,
        headers=system_headers,
        json=first_payload,
    )

    print(
        "First duplicate response:",
        first_response.text,
        "with status",
        first_response.status_code,
    )

    assert first_response.status_code in (200, 201), first_response.text
    assert first_response.json()["id"] == expected_job_id

    # Second duplicate create repeats Berlin, adds Munich, and includes
    # Munich twice within the same request.
    second_payload = {
        "url": test_job_url,
        "locations": [
            {
                "countryName": "Germany",
                "countryCode": "DE",
                "cityName": "Berlin",
                "region": "Berlin",
            },
            {
                "countryName": "Germany",
                "countryCode": "DE",
                "cityName": "Munich",
                "region": "Bavaria",
            },
            {
                "countryName": " Germany ",
                "countryCode": "de",
                "cityName": " Munich ",
                "region": "Bavaria",
            },
        ],
    }

    second_response = requests.post(
        jobs_url,
        headers=system_headers,
        json=second_payload,
    )

    print(
        "Second duplicate response:",
        second_response.text,
        "with status",
        second_response.status_code,
    )

    assert second_response.status_code in (200, 201), second_response.text
    assert second_response.json()["id"] == expected_job_id

    detail_response = requests.get(
        f"{jobs_url}/{expected_job_id}",
        headers=system_headers,
    )

    assert detail_response.status_code == 200, detail_response.text

    locations = detail_response.json()["locations"]

    berlin = [
        loc
        for loc in locations
        if loc["countryName"] == "Germany"
        and loc["cityName"] == "Berlin"
    ]
    munich = [
        loc
        for loc in locations
        if loc["countryName"] == "Germany"
        and loc["cityName"] == "Munich"
    ]

    assert len(berlin) == 1, locations
    assert len(munich) == 1, locations
    