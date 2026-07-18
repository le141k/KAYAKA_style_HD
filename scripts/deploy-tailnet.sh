#!/usr/bin/env bash
# Retained as a fail-closed compatibility shim. Production uses Secure cookies,
# which browsers will not send to the legacy plain-HTTP tailnet origin.
set -euo pipefail

echo '[deploy-tailnet] ERROR: plain HTTP is incompatible with production Secure auth cookies.' >&2
echo '[deploy-tailnet] Use scripts/deploy-prod.sh with an approved HTTPS origin.' >&2
exit 1
