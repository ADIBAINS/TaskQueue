#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${TASKQUEUE_APP_DIR:-/opt/taskqueue}"
ENV_FILE="${TASKQUEUE_ENV_FILE:-${APP_DIR}/.env.production}"
COMPOSE_FILE="${APP_DIR}/docker-compose.production.yml"
ROLLBACK_TAG="${1:-}"

if [[ -z "${ROLLBACK_TAG}" && -f "${APP_DIR}/.previous-image-tag" ]]; then
  ROLLBACK_TAG="$(tr -d '[:space:]' < "${APP_DIR}/.previous-image-tag")"
fi

if [[ -z "${ROLLBACK_TAG}" ]]; then
  echo "usage: $0 <image-tag>" >&2
  echo "no .previous-image-tag file is available" >&2
  exit 2
fi

temporary="$(mktemp "${ENV_FILE}.XXXXXX")"
awk -v value="${ROLLBACK_TAG}" '
  BEGIN { updated = 0 }
  index($0, "IMAGE_TAG=") == 1 {
    print "IMAGE_TAG=" value
    updated = 1
    next
  }
  { print }
  END {
    if (!updated) print "IMAGE_TAG=" value
  }
' "${ENV_FILE}" > "${temporary}"
chmod 600 "${temporary}"
mv "${temporary}" "${ENV_FILE}"

cd "${APP_DIR}"
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" pull
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up -d --remove-orphans

api_domain="$(sed -n 's/^API_DOMAIN=//p' "${ENV_FILE}" | tail -n 1)"
for attempt in {1..36}; do
  if curl --fail --silent --show-error --max-time 10 \
    "https://${api_domain}/health" >/dev/null; then
    echo "rollback to ${ROLLBACK_TAG} is healthy"
    exit 0
  fi
  echo "rollback health check ${attempt}/36 failed; retrying"
  sleep 5
done

echo "rollback did not become healthy" >&2
exit 1
