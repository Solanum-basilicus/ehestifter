#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${1:-./secrets}"
mkdir -p "$OUT_DIR"

OPENSSL_CNF="$OUT_DIR/ehjobs-proxy-openssl.cnf"
cat > "$OPENSSL_CNF" <<'CNF'
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = ehjobs-proxy

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = ehjobs-proxy
DNS.2 = localhost
IP.1 = 127.0.0.1
CNF

openssl req \
  -x509 \
  -nodes \
  -newkey rsa:2048 \
  -days 365 \
  -keyout "$OUT_DIR/ehjobs-proxy.key" \
  -out "$OUT_DIR/ehjobs-proxy.crt" \
  -config "$OPENSSL_CNF"

chmod 644 "$OUT_DIR/ehjobs-proxy.key"
chmod 644 "$OUT_DIR/ehjobs-proxy.crt"

echo "Generated:"
echo "  $OUT_DIR/ehjobs-proxy.crt"
echo "  $OUT_DIR/ehjobs-proxy.key"
