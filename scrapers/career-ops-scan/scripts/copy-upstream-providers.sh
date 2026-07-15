#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_DIR="${1:-/tmp/career-ops-upstream}"
TARGET_DIR="${2:-src/providers}"

required=(
  providers/_http.mjs
  providers/_registry.mjs
  providers/_types.js
  providers/greenhouse.mjs
  providers/lever.mjs
  providers/ashby.mjs
  providers/workday.mjs
)

for rel in "${required[@]}"; do
  if [[ ! -f "$UPSTREAM_DIR/$rel" ]]; then
    echo "Missing upstream file: $UPSTREAM_DIR/$rel" >&2
    exit 1
  fi
done

mkdir -p "$TARGET_DIR"
for rel in "${required[@]}"; do
  cp "$UPSTREAM_DIR/$rel" "$TARGET_DIR/$(basename "$rel")"
done

UPSTREAM_SHA="$(git -C "$UPSTREAM_DIR" rev-parse HEAD)"
UPSTREAM_TAG="$(git -C "$UPSTREAM_DIR" describe --tags --exact-match 2>/dev/null || true)"

python3 - "$TARGET_DIR" "$UPSTREAM_SHA" <<'PY2'
from pathlib import Path
import sys

target = Path(sys.argv[1])
sha = sys.argv[2]
header = (
    f"// Portions derived from santifer/career-ops at {sha}.\n"
    "// Originally distributed under the MIT License.\n"
    "// Modified for Ehestifter. See THIRD_PARTY_NOTICES.md.\n\n"
)
for path in sorted(target.iterdir()):
    if path.suffix not in {'.mjs', '.js'}:
        continue
    text = path.read_text(encoding='utf-8')
    if 'Portions derived from santifer/career-ops' not in text:
        path.write_text(header + text, encoding='utf-8')
PY2

cat > UPSTREAM.md <<EOF
# Career-Ops upstream reference

- Repository: https://github.com/santifer/career-ops
- Tag: ${UPSTREAM_TAG:-unknown}
- Commit: ${UPSTREAM_SHA}
- Imported files:
  - providers/_http.mjs
  - providers/_registry.mjs
  - providers/_types.js
  - providers/greenhouse.mjs
  - providers/lever.mjs
  - providers/ashby.mjs
  - providers/workday.mjs

Ehestifter removes Career-Ops tracker, application, CV-generation, pipeline,
scan-history, plugin, and browser-verification integrations. The retained
provider layer is used only for public job discovery.
EOF

echo "Copied provider layer from ${UPSTREAM_TAG:-$UPSTREAM_SHA}."
