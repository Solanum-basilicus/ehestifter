from __future__ import annotations

import sys
from pathlib import Path

# The Enrichers service is deployed as a flat Azure Functions app where modules
# import service-local packages such as ``helpers``. When pytest is launched via
# the ``pytest`` console script, the service root is not guaranteed to be on
# sys.path. Keep this adjustment local to unit tests so production imports and
# the existing deployed integration suite remain unchanged.
ENRICHERS_ROOT = Path(__file__).resolve().parents[1]
root = str(ENRICHERS_ROOT)
if root not in sys.path:
    sys.path.insert(0, root)
    