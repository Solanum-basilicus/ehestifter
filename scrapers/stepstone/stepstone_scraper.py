import requests
from bs4 import BeautifulSoup
import uuid
from datetime import datetime
from urllib.parse import urljoin

# TODO: Make it work.

BASE_URL = "https://www.stepstone.de"
SEARCH_URL = "https://www.stepstone.de/jobs/product-or-project/in-deutschland?radius=30&ag=age_1"

HEADERS = {
    "User-Agent": "Bitte ignorieren Sie mich, ich möchte nur einen Job finden"
}

def scrape_stepstone_page(url: str):
    r = requests.get(url, headers=HEADERS)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    container = soup.find(attrs={"data‑genesis‑element": "CARD_GROUP_CONTAINER"})
    if not container:
        print("❗ Could not find the job list container")
        return []

    jobs = []
    articles = container.find_all("article", id=lambda x: x and x.startswith("job-item-"))
    for card in articles:
        job_id = card["id"].split("-", 2)[2]

        title_el = card.select_one("h2 a")
        company_el = card.select_one("[data‑tn-element='company-name']")
        loc_el = card.select_one("[data‑tn-element='job-location']")

        if not title_el or not company_el or not loc_el:
            continue

        job_url = urljoin(BASE_URL, title_el["href"])
        hiring = company_el.get_text(strip=True)
        locality = loc_el.get_text(strip=True)
        title = title_el.get_text(strip=True)

        jobs.append({
            "Id": str(uuid.uuid4()),
            "Source": "StepStone",
            "ExternalId": job_id,
            "Url": job_url,
            "ApplyUrl": None,
            "HiringCompanyName": hiring,
            "PostingCompanyName": hiring,
            "Title": title,
            "Country": "Germany",
            "Locality": locality,
            "RemoteType": "on-site",
            "Description": "",
            "PostedDate": None,
            "FirstSeenAt": datetime.utcnow().isoformat(),
            "LastSeenAt": None,
            "RepostCount": 0,
            "CreatedAt": datetime.utcnow().isoformat(),
            "UpdatedAt": None
        })

    return jobs

if __name__ == "__main__":
    scraped = scrape_stepstone_page(SEARCH_URL)
    for j in scraped[:5]:
        print(f"{j['Title']} @ {j['HiringCompanyName']} in {j['Locality']}")
        print("  Link:", j["Url"])
        print("---")
