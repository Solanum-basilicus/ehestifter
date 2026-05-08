from pydantic import BaseModel, Field

class JobCard(BaseModel):
    ordinal: int
    title: str | None = None
    company: str | None = None
    location_text: str | None = None
    detail_url: str | None = None
    evidence: str
    open_instruction: str = Field(
        description="Concrete browser instruction for opening this specific job detail."
    )


class JobCardList(BaseModel):
    source: str
    cards: list[JobCard]
    warnings: list[str] = []


class RawJobCandidate(BaseModel):
    title: str | None = None
    company: str | None = None
    location_text: str | None = None
    listing_url: str | None = None
    origin_url: str | None = None
    visible_description: str | None = None
    evidence: str


class RawCapture(BaseModel):
    source: str
    captured_at_utc: str
    query: str
    candidates: list[RawJobCandidate]
    warnings: list[str] = []
    