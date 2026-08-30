#!/usr/bin/env bash
set -euo pipefail

JOB="depbot-triage-nightly"
LOCATION="europe-west3"
PROJECT="all-things-agentic-506113"

case "${1:-}" in
  pause)  gcloud scheduler jobs pause  "$JOB" --location="$LOCATION" --project="$PROJECT" ;;
  resume) gcloud scheduler jobs resume "$JOB" --location="$LOCATION" --project="$PROJECT" ;;
  status) gcloud scheduler jobs describe "$JOB" --location="$LOCATION" --project="$PROJECT" --format="value(state)" ;;
  *)      echo "Usage: $0 {pause|resume|status}" >&2; exit 1 ;;
esac
