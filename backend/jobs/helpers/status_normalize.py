# helpers/status_normalize.py
# Server-side status normalization that mirrors the frontend (static/js/status-utils.js)

STATUS_OPTIONS = [
    "Applied","Screening Booked","Screening Done","HM interview Booked","HM interview Done",
    "More interviews Booked","More interviews Done","Rejected with Filled",
    "Rejected with Unfortunately", "Withdrew Applications",
    "Got Offer","Accepted Offer","Turned down Offer"
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
    return f"""
    CASE
      WHEN LOWER({col_sql}) = 'applied' THEN 'applied'
      WHEN LOWER({col_sql}) = 'screening booked' THEN 'booked-screen'
      WHEN LOWER({col_sql}) = 'hm interview booked' THEN 'booked-hm'
      WHEN LOWER({col_sql}) = 'more interviews booked' THEN 'booked-more'
      WHEN LOWER({col_sql}) = 'screening done' THEN 'done-screen'
      WHEN LOWER({col_sql}) = 'hm interview done' THEN 'done-hm'
      WHEN LOWER({col_sql}) = 'more interviews done' THEN 'done-more'
      WHEN LOWER({col_sql}) = 'got offer' THEN 'offer'
      WHEN LOWER({col_sql}) = 'accepted offer' THEN 'accepted'
      WHEN LOWER({col_sql}) IN (
        'rejected with filled',
        'rejected with unfortunately',
        'turned down offer',
        'withdrew applications'
      ) THEN 'finished'
      WHEN {col_sql} IS NULL THEN 'unset'
      ELSE 'default'
    END
    """.strip()
