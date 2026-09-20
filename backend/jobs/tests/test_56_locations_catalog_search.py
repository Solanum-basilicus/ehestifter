import requests


def test_locations_search_disambiguates_london_ontario(base_url, auth_headers):
    response = requests.get(
        f"{base_url}/api/jobs/locations/search",
        headers=auth_headers,
        params={"q": "London Ontario", "limit": 8},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["catalogVersion"]
    assert any(
        item["kind"] == "city"
        and item["locationId"] == "geonames:6058560"
        and item["countryName"] == "Canada"
        for item in body["items"]
    )


def test_locations_lookup_returns_canonical_presentation(base_url, auth_headers):
    response = requests.post(
        f"{base_url}/api/jobs/locations/lookup",
        headers=auth_headers,
        json={
            "locations": [
                {"kind": "country", "locationId": "iso3166:GB"},
                {"kind": "city", "locationId": "geonames:6058560"},
            ]
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["missing"] == []
    by_id = {item["locationId"]: item for item in body["items"]}
    assert by_id["iso3166:GB"]["displayName"] == "United Kingdom"
    assert by_id["geonames:6058560"]["label"] == "London, Ontario, Canada"
