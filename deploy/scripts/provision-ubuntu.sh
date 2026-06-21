#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "run this script as root" >&2
  exit 1
fi

DEPLOY_USER="${DEPLOY_USER:-deploy}"
APP_DIR="${TASKQUEUE_APP_DIR:-/opt/taskqueue}"

if ! id "${DEPLOY_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "${DEPLOY_USER}"
fi

apt-get update
apt-get install -y ca-certificates curl gnupg rsync ufw unattended-upgrades

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

# shellcheck disable=SC1091
. /etc/os-release
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

usermod -aG docker "${DEPLOY_USER}"
install -d -m 0750 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${APP_DIR}"
install -d -m 0700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" /var/backups/taskqueue

ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

dpkg-reconfigure -f noninteractive unattended-upgrades

echo "provisioning complete"
echo "log out and back in before ${DEPLOY_USER} uses Docker"
