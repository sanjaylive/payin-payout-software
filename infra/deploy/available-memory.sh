#!/usr/bin/env bash
# Runs ON THE SERVER: prints MB available for Pay2All = MemAvailable + memory already used by the
# running pay2all-* containers (they are replaced by the deploy, so they don't count against it).
set -euo pipefail
avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
ours=$(docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' 2>/dev/null | awk '
  /^pay2all-/ { v=$2; if (v ~ /GiB/) { sub(/GiB/, "", v); t += v * 1024 } else if (v ~ /MiB/) { sub(/MiB/, "", v); t += v } }
  END { print int(t) }')
echo "$((avail + ${ours:-0})) $avail ${ours:-0}"
