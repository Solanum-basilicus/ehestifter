# helpers/status_normalize.py
# Server-side status normalization that mirrors the frontend (static/js/status-utils.js)

STATUS_OPTIONS = [
    "Applied","Screening Booked","Screening Done","HM interview Booked","HM interview Done",
    "More interviews Booked","More interviews Done","Rejected with Filled",
    "Rejected with Unfortunately", "Withdrew Applications",
    "Got Offer","Accepted Offer","Turned down Offer", "Ignored"
]

def status_key(label: str) -> str:
    """Map a human label (any case/spacing) to a compact key used for filtering."""
    if not label:
        return "unset"
    s = str(label).strip().lower()
    if s == "unset": return "unset"
    if s == "applied": return "applied"
    if s == "screening booked":       return "booked-screen"
    if s == "hm interview booked":    return "booked-hm"
    if s == "more interviews booked": return "booked-more"
    if s == "screening done":         return "done-screen"
    if s == "hm interview done":      return "done-hm"
    if s == "more interviews done":   return "done-more"
    if s == "got offer":              return "offer"
    if s == "accepted offer":         return "accepted"
    if s in {
        "rejected with filled",
        "rejected with unfortunately",
        "turned down offer",
        "withdrew applications",
        "ignored",
    }:
        return "finished"
    return "default"

def status_key_case_sql(col_sql: str) -> str:
    """
    Return a T-SQL CASE expression that maps LOWER(col_sql) -> status key.
    Example usage:
        key_sql = status_key_case_sql("us.Status")
        ... WHERE NOT ( {key_sql} IN (?, ?, ...) )
    """
    # Note: keep labels LOWER()ed to match comparisons
    base = f"LOWER(LTRIM(RTRIM({col_sql})))"
    return f"""
    CASE
      WHEN {base} = 'applied' THEN 'applied'
      WHEN {base} = 'screening booked' THEN 'booked-screen'
      WHEN {base} = 'hm interview booked' THEN 'booked-hm'
      WHEN {base} IN ('more interviews booked','more interview booked') THEN 'booked-more'
      WHEN {base} = 'screening done' THEN 'done-screen'
      WHEN {base} = 'hm interview done' THEN 'done-hm'
      WHEN {base} IN ('more interviews done','more interview done') THEN 'done-more'
      WHEN {base} = 'got offer' THEN 'offer'
      WHEN {base} = 'accepted offer' THEN 'accepted'
      WHEN {base} IN (
        'rejected with filled',
        'rejected with unfortunately',
        'turned down offer',
        'withdrew applications',
        'ignored'
      ) THEN 'finished'
      WHEN {col_sql} IS NULL THEN 'unset'
      ELSE 'default'
    END
    """.strip()


# Higher values appear first in the status progression sort.
# Final outcomes other than Accepted Offer follow active interview stages.
# Unknown and unset statuses appear before Applied.
STATUS_PROGRESSION_RANKS = {
    "accepted offer": 110,
    "got offer": 100,
    "more interviews done": 90,
    "more interview done": 90,  # Legacy spelling.
    "more interviews booked": 80,
    "more interview booked": 80,  # Legacy spelling.
    "hm interview done": 70,
    "hm interview booked": 60,
    "screening done": 50,
    "screening booked": 40,
    "rejected with filled": 30,
    "rejected with unfortunately": 30,
    "withdrew applications": 30,
    "turned down offer": 30,
    "ignored": 30,
    "applied": 0,
}


def status_progression_order_sql(col_sql: str) -> str:
    """Return the rank for a user status in a SQL ORDER BY expression."""
    normalized = f"LOWER(LTRIM(RTRIM(COALESCE({col_sql}, ''))))"
    cases = "\n".join(
        f"WHEN '{status}' THEN {rank}"
        for status, rank in STATUS_PROGRESSION_RANKS.items()
    )
    return f"CASE {normalized}\n{cases}\nELSE 20 END"
