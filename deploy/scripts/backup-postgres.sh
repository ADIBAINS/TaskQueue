#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${TASKQUEUE_APP_DIR:-/opt/taskqueue}"
ENV_FILE="${TASKQUEUE_ENV_FILE:-${APP_DIR}/.env.production}"
COMPOSE_FILE="${APP_DIR}/docker-compose.production.yml"
BACKUP_DIR="${TASKQUEUE_BACKUP_DIR:-/var/backups/taskqueue}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
destination="${BACKUP_DIR}/taskqueue-${timestamp}.sql.gz"

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" \
  exec -T postgres pg_dump --username taskqueue --dbname taskqueue \
  | gzip -9 > "${destination}"

chmod 600 "${destination}"
find "${BACKUP_DIR}" -type f -name 'taskqueue-*.sql.gz' \
  -mtime "+${RETENTION_DAYS}" -delete

echo "created ${destination}"
