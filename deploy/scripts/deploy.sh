#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${TASKQUEUE_APP_DIR:-/opt/taskqueue}"
ENV_FILE="${TASKQUEUE_ENV_FILE:-${APP_DIR}/.env.production}"
COMPOSE_FILE="${APP_DIR}/docker-compose.production.yml"
NEW_TAG="${1:-}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-36}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-5}"

if [[ -z "${NEW_TAG}" ]]; then
  echo "usage: $0 <image-tag>" >&2
  exit 2
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "missing production environment file: ${ENV_FILE}" >&2
  exit 1
fi

if [[ ! -f "${COMPOSE_FILE}" ]]; then
  echo "missing production compose file: ${COMPOSE_FILE}" >&2
  exit 1
fi

cd "${APP_DIR}"

compose() {
  docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

read_env() {
  local key="$1"
  sed -n "s/^${key}=//p" "${ENV_FILE}" | tail -n 1
}

write_env() {
  local key="$1"
  local value="$2"
  local temporary
  temporary="$(mktemp "${ENV_FILE}.XXXXXX")"
  awk -v key="${key}" -v value="${value}" '
    BEGIN { updated = 0 }
    index($0, key "=") == 1 {
      print key "=" value
      updated = 1
      next
    }
    { print }
    END {
      if (!updated) print key "=" value
    }
  ' "${ENV_FILE}" > "${temporary}"
  chmod 600 "${temporary}"
  mv "${temporary}" "${ENV_FILE}"
}

wait_for_health() {
  local api_domain
  api_domain="$(read_env API_DOMAIN)"
  if [[ -z "${api_domain}" ]]; then
    echo "API_DOMAIN is not configured" >&2
    return 1
  fi

  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
    if curl --fail --silent --show-error --max-time 10 \
      "https://${api_domain}/health" >/dev/null; then
      echo "deployment healthy at https://${api_domain}/health"
      return 0
    fi
    echo "health check ${attempt}/${HEALTH_ATTEMPTS} failed; retrying"
    sleep "${HEALTH_INTERVAL}"
  done

  return 1
}

previous_tag="$(read_env IMAGE_TAG)"
if [[ -n "${previous_tag}" && "${previous_tag}" != "${NEW_TAG}" ]]; then
  printf '%s\n' "${previous_tag}" > "${APP_DIR}/.previous-image-tag"
  chmod 600 "${APP_DIR}/.previous-image-tag"
fi

write_env IMAGE_TAG "${NEW_TAG}"

echo "pulling TaskQueue images for ${NEW_TAG}"
compose pull

echo "starting infrastructure dependencies"
compose up -d postgres redis zookeeper kafka kafka-init jaeger

echo "running database migrations"
compose --profile tools run --rm migrate

echo "starting application and observability services"
compose up -d --remove-orphans

if wait_for_health; then
  compose ps
  exit 0
fi

echo "deployment health check failed" >&2
if [[ -n "${previous_tag}" && "${previous_tag}" != "${NEW_TAG}" ]]; then
  echo "rolling back to ${previous_tag}" >&2
  write_env IMAGE_TAG "${previous_tag}"
  compose pull
  compose up -d --remove-orphans
  wait_for_health || true
fi
exit 1
