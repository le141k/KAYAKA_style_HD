#!/usr/bin/env bash
# Derive the immutable web-image suffix from the NEXT_PUBLIC_* inputs that Next.js
# embeds at build time. The env file is parsed as data and is never sourced.
set -euo pipefail

MODE=id
if [[ "${1:-}" == --full ]]; then
  MODE=full
  shift
fi
[[ $# -eq 1 ]] || { echo "Usage: $0 [--full] <env-file>" >&2; exit 1; }
ENV_FILE="$1"
[[ -f "$ENV_FILE" ]] || { echo 'ERROR: production env file not found' >&2; exit 1; }

env_value() {
  local key="$1" line value
  line="$(grep -E "^${key}[[:space:]]*=" "$ENV_FILE" 2>/dev/null | head -1 || true)"
  value="${line#*=}"
  printf '%s' "$value" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^['"'"'"]//; s/['"'"'"]$//'
}

if command -v sha256sum >/dev/null 2>&1; then
  CHECKSUM_CMD=(sha256sum)
else
  command -v shasum >/dev/null 2>&1 || { echo 'ERROR: sha256sum or shasum is required' >&2; exit 1; }
  CHECKSUM_CMD=(shasum -a 256)
fi

CHECKSUM="$({
  printf 'NEXT_PUBLIC_API_URL=%s\n' "$(env_value NEXT_PUBLIC_API_URL)"
  printf 'NEXT_PUBLIC_TURNSTILE_SITE_KEY=%s\n' "$(env_value NEXT_PUBLIC_TURNSTILE_SITE_KEY)"
} | "${CHECKSUM_CMD[@]}" | awk '{print $1}')"

if [[ "$MODE" == full ]]; then
  printf '%s\n' "$CHECKSUM"
else
  printf '%s\n' "${CHECKSUM:0:16}"
fi
