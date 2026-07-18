#!/usr/bin/env bash
# Extract an uploads archive into a disposable Docker volume to prove restorability.
set -euo pipefail
umask 077

if [[ "${TELECOM_HD_OPS_LOCK_HELD:-0}" != 1 ]]; then
  command -v flock >/dev/null 2>&1 || { echo 'ERROR: flock is required' >&2; exit 1; }
  exec 9>"${TMPDIR:-/tmp}/telecom-hd-prod-ops.lock"
  flock -n 9 || { echo 'ERROR: another deploy/backup/restore operation is running' >&2; exit 1; }
fi

[[ $# -eq 1 ]] || { echo "Usage: $0 <uploads.tar.gz>" >&2; exit 1; }
ARCHIVE_FILE="$1"
[[ -f "$ARCHIVE_FILE" ]] || { echo 'ERROR: uploads archive not found' >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo 'ERROR: docker not found' >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${SCRIPT_DIR}/validate-uploads-archive.sh" "$ARCHIVE_FILE"

IMAGE="${UPLOADS_VERIFY_IMAGE:?set UPLOADS_VERIFY_IMAGE to the immutable API image}"
VOLUME="telecom-hd-uploads-restore-check-$$"
cleanup() { docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
docker volume create "$VOLUME" >/dev/null

echo '[uploads-verify] Restoring archive into a disposable volume'
gunzip -c "$ARCHIVE_FILE" | docker run --rm -i --user 0 \
  -v "$VOLUME:/restore" \
  "$IMAGE" \
  tar xf - -C /restore

INVENTORY="$(docker run --rm --user 0 -v "$VOLUME:/restore:ro" "$IMAGE" sh -ec \
  "find /restore -type f -exec stat -c %s {} + | awk '{ files += 1; bytes += \$1 } END { printf \"%d %d\", files, bytes }'")"
read -r FILE_COUNT FILE_BYTES <<< "$INVENTORY"
[[ "$FILE_COUNT" =~ ^[0-9]+$ && "$FILE_BYTES" =~ ^[0-9]+$ ]] || {
  echo 'ERROR: restored uploads inventory failed' >&2
  exit 1
}

if [[ -n "${UPLOADS_EXPECTED_FILES:-}" || -n "${UPLOADS_EXPECTED_BYTES:-}" ]]; then
  [[ "${UPLOADS_EXPECTED_FILES:-}" =~ ^[0-9]+$ && "${UPLOADS_EXPECTED_BYTES:-}" =~ ^[0-9]+$ ]] || {
    echo 'ERROR: both UPLOADS_EXPECTED_FILES and UPLOADS_EXPECTED_BYTES must be integers' >&2
    exit 1
  }
  [[ "$FILE_COUNT" == "$UPLOADS_EXPECTED_FILES" && "$FILE_BYTES" == "$UPLOADS_EXPECTED_BYTES" ]] || {
    echo 'ERROR: restored uploads inventory does not match the quiesced source volume' >&2
    exit 1
  }
fi

echo "[uploads-verify] Restore verified (${FILE_COUNT} files, ${FILE_BYTES} bytes)"
