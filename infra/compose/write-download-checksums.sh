#!/usr/bin/env bash
# Recompute the digests the installer verifies. Run after changing any file listed
# here, and commit the result: the installer refuses a download that does not match.
#
#   infra/compose/write-download-checksums.sh
#
# The paths are relative to this directory, and the output uses the same format
# `sha256sum -c` reads, so an operator can verify a checkout by hand.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

files=(docker-compose.images.yml .env.images.example restrict-computer-egress.sh)
for file in "${files[@]}"; do
  [[ -f "$file" ]] || { echo "missing ${file}" >&2; exit 1; }
done

sha256sum "${files[@]}" > SHA256SUMS
echo "Wrote SHA256SUMS for ${#files[@]} files."
