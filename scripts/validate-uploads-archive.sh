#!/usr/bin/env bash
# Validate the exact archive policy shared by restore rehearsal and real restore.
set -euo pipefail

[[ $# -eq 1 ]] || { echo "Usage: $0 <uploads.tar.gz>" >&2; exit 1; }
ARCHIVE_FILE="$1"
[[ -f "$ARCHIVE_FILE" ]] || { echo 'ERROR: uploads archive not found' >&2; exit 1; }
command -v gzip >/dev/null 2>&1 || { echo 'ERROR: gzip not found' >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo 'ERROR: tar not found' >&2; exit 1; }

gzip -t "$ARCHIVE_FILE"
tar tzf "$ARCHIVE_FILE" >/dev/null

# Archives produced by uploads-backup.sh contain only regular files and
# directories under a relative root. Reject traversal and extraction side
# effects before a disposable or production volume is touched.
while IFS= read -r member; do
  case "$member" in
    ..|/*|../*|*/../*|*/..)
      echo 'ERROR: uploads archive contains an unsafe path' >&2
      exit 1
      ;;
  esac
done < <(tar tzf "$ARCHIVE_FILE")

if ! tar tvzf "$ARCHIVE_FILE" | awk '
  substr($1, 1, 1) != "-" && substr($1, 1, 1) != "d" { exit 1 }
'; then
  echo 'ERROR: uploads archive contains a special file or symbolic link' >&2
  exit 1
fi
