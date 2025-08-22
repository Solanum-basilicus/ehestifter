# Domain-wide constants. Reuse anywhere you need status logic.

# Tuple (ordered, deterministic). Add more as you finalize taxonomy.
FINAL_STATUSES: tuple[str, ...] = (
    "Rejected with Filled",
    "Rejected with Unfortunately",
    "Accepted Offer",
    "Turned down Offer",
)