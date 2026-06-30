#!/usr/bin/env sh
set -eu

APP_NAME="nian-gallery"
INSTALL_DIR="${NIAN_GALLERY_DIR:-$HOME/$APP_NAME}"
INSTALL_MODE="${NIAN_GALLERY_INSTALL_MODE:-docker}"
ACTION="${NIAN_GALLERY_ACTION:-install}"
SOURCE_URL="${NIAN_GALLERY_SOURCE_URL:-${NIAN_GALLERY_SOURCE:-}}"
REPO_URL="${NIAN_GALLERY_REPO_URL:-${NIAN_GALLERY_REPO:-}}"
BRANCH="${NIAN_GALLERY_BRANCH:-main}"
HOSTNAME="${NIAN_GALLERY_HOSTNAME:-gallery.irop.one}"
IMAGE_MODE="${NIAN_GALLERY_IMAGE_MODE:-build}"

if [ "${NIAN_GALLERY_UPDATE:-}" = "1" ]; then
  ACTION="update"
fi

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'Install failed: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required. Please install it and run this command again."
}

is_project_dir() {
  [ -f "$1/package.json" ] && [ -f "$1/docker-compose.yml" ]
}

download_archive() {
  url="$1"
  target="$2"
  tmp_dir="$(mktemp -d 2>/dev/null || mktemp -d -t nian-gallery)"
  archive="$tmp_dir/source.tar.gz"
  mkdir -p "$target"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$archive"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$archive" "$url"
  else
    fail "curl or wget is required to download the gallery archive."
  fi

  tar -xzf "$archive" -C "$tmp_dir"
  package_file="$(find "$tmp_dir" -mindepth 1 -maxdepth 2 -name package.json -print | head -n 1)"
  [ -n "$package_file" ] || fail "Downloaded archive does not look like a Node project."
  extracted="$(dirname "$package_file")"
  copy_project "$extracted" "$target"
  rm -rf "$tmp_dir"
}

clone_repo() {
  repo="$1"
  target="$2"
  need_cmd git
  git clone --depth 1 --branch "$BRANCH" "$repo" "$target"
}

update_from_repo() {
  repo="$1"
  target="$2"
  need_cmd git
  if [ -d "$target/.git" ]; then
    (cd "$target" && git fetch --depth 1 origin "$BRANCH" && git checkout -B "$BRANCH" FETCH_HEAD)
    return 0
  fi
  tmp_dir="$(mktemp -d 2>/dev/null || mktemp -d -t nian-gallery)"
  git clone --depth 1 --branch "$BRANCH" "$repo" "$tmp_dir/source"
  copy_project "$tmp_dir/source" "$target"
  rm -rf "$tmp_dir"
}

copy_project() {
  from="$1"
  to="$2"
  mkdir -p "$to"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude .git \
      --exclude node_modules \
      --exclude .gallery \
      --exclude .uploads \
      --exclude .env \
      "$from"/ "$to"/
  else
    (cd "$from" && tar \
      --exclude .git \
      --exclude node_modules \
      --exclude .gallery \
      --exclude .uploads \
      --exclude .env \
      -cf - .) | (cd "$to" && tar -xf -)
  fi
}

prepare_env() {
  [ -f .env ] || cp .env.example .env
  mkdir -p .gallery .uploads public/data public/media
  HOSTNAME="${NIAN_GALLERY_HOSTNAME:-$(env_value NIAN_GALLERY_HOSTNAME "$HOSTNAME")}"
  IMAGE_MODE="${NIAN_GALLERY_IMAGE_MODE:-$(env_value NIAN_GALLERY_IMAGE_MODE "$IMAGE_MODE")}"
  NIAN_GALLERY_PORT="${NIAN_GALLERY_PORT:-$(env_value NIAN_GALLERY_PORT 5279)}"
  NIAN_GALLERY_COMPOSE_PROJECT="${NIAN_GALLERY_COMPOSE_PROJECT:-$(env_value NIAN_GALLERY_COMPOSE_PROJECT nian-gallery)}"
  NIAN_GALLERY_IMAGE="${NIAN_GALLERY_IMAGE:-$(env_value NIAN_GALLERY_IMAGE)}"
  set_env NIAN_GALLERY_COMPOSE_PROJECT "$NIAN_GALLERY_COMPOSE_PROJECT"
  set_env NIAN_GALLERY_HOSTNAME "$HOSTNAME"
  set_env NIAN_GALLERY_PORT "$NIAN_GALLERY_PORT"
  set_env NIAN_GALLERY_IMAGE_MODE "$IMAGE_MODE"
  set_env NIAN_GALLERY_IMAGE "$NIAN_GALLERY_IMAGE"
  set_env CLOUDFLARE_TUNNEL_TOKEN "${CLOUDFLARE_TUNNEL_TOKEN:-}"
}

env_value() {
  key="$1"
  default="${2:-}"
  if [ -f .env ]; then
    value="$(grep "^$key=" .env 2>/dev/null | tail -n 1 | sed "s/^$key=//")"
    if [ -n "$value" ]; then
      printf '%s\n' "$value"
      return 0
    fi
  fi
  printf '%s\n' "$default"
}

has_tunnel_token() {
  [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ] || [ -n "$(env_value CLOUDFLARE_TUNNEL_TOKEN)" ]
}

set_env() {
  key="$1"
  value="$2"
  [ -n "$value" ] || return 0
  if [ -f .env ]; then
    grep -v "^$key=" .env > .env.tmp 2>/dev/null || true
    mv .env.tmp .env
  fi
  printf '%s=%s\n' "$key" "$value" >> .env
}

start_docker() {
  need_cmd docker
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required. Please update Docker Desktop or Docker Engine."
  prepare_env
  if [ "$IMAGE_MODE" = "prebuilt" ]; then
    start_docker_prebuilt
    return 0
  fi
  if [ "$IMAGE_MODE" != "build" ]; then
    fail "Unknown NIAN_GALLERY_IMAGE_MODE: $IMAGE_MODE. Use build or prebuilt."
  fi
  if has_tunnel_token; then
    docker compose --profile tunnel up -d --build
    log ""
    log "Nian Gallery is starting at https://$HOSTNAME"
  else
    docker compose up -d --build
    log ""
    log "Nian Gallery is starting at http://localhost:${NIAN_GALLERY_PORT:-5279}"
    log "To expose $HOSTNAME, set CLOUDFLARE_TUNNEL_TOKEN in .env and run:"
    log "  docker compose --profile tunnel up -d"
  fi
  wait_for_gallery
  if has_tunnel_token; then
    log "Public URL: https://$HOSTNAME"
  fi
  log "Setup page: http://localhost:${NIAN_GALLERY_PORT:-5279}/setup"
  log "Studio: http://localhost:${NIAN_GALLERY_PORT:-5279}/studio"
  log "Update later: rerun this installer with NIAN_GALLERY_ACTION=update; .env, .gallery, and .uploads are preserved."
}

start_docker_prebuilt() {
  [ -f docker-compose.image.yml ] || fail "docker-compose.image.yml is required for NIAN_GALLERY_IMAGE_MODE=prebuilt."
  log "Using prebuilt Docker image: ${NIAN_GALLERY_IMAGE:-ghcr.io/arisataki/webgl-gallery:latest}"
  docker compose -f docker-compose.image.yml pull gallery || log "Image pull was skipped or failed; Docker will use a local image if available."
  if has_tunnel_token; then
    docker compose -f docker-compose.image.yml --profile tunnel up -d
    log ""
    log "Nian Gallery is starting at https://$HOSTNAME"
  else
    docker compose -f docker-compose.image.yml up -d
    log ""
    log "Nian Gallery is starting at http://localhost:${NIAN_GALLERY_PORT:-5279}"
    log "To expose $HOSTNAME, set CLOUDFLARE_TUNNEL_TOKEN in .env and run:"
    log "  docker compose -f docker-compose.image.yml --profile tunnel up -d"
  fi
  wait_for_gallery
  if has_tunnel_token; then
    log "Public URL: https://$HOSTNAME"
  fi
  log "Setup page: http://localhost:${NIAN_GALLERY_PORT:-5279}/setup"
  log "Studio: http://localhost:${NIAN_GALLERY_PORT:-5279}/studio"
  log "Update later: rerun this installer with NIAN_GALLERY_ACTION=update; .env, .gallery, and .uploads are preserved."
}

wait_for_gallery() {
  url="http://127.0.0.1:${NIAN_GALLERY_PORT:-5279}/api/setup/status"
  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi
  i=1
  while [ "$i" -le 60 ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "Nian Gallery is ready."
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  log "Nian Gallery is still starting. Check logs with: docker compose logs -f"
}

start_node() {
  need_cmd node
  need_cmd npm
  node scripts/bootstrap.mjs
}

case "$ACTION" in
  install|update) ;;
  *) fail "Unknown NIAN_GALLERY_ACTION: $ACTION. Use install or update." ;;
esac

if [ "$ACTION" = "update" ]; then
  if [ -n "$SOURCE_URL" ]; then
    log "Updating $APP_NAME from archive into $INSTALL_DIR"
    download_archive "$SOURCE_URL" "$INSTALL_DIR"
  elif [ -n "$REPO_URL" ]; then
    log "Updating $APP_NAME from git into $INSTALL_DIR"
    update_from_repo "$REPO_URL" "$INSTALL_DIR"
  elif is_project_dir "$(pwd)"; then
    INSTALL_DIR="$(pwd)"
    log "Updating current project directory: $INSTALL_DIR"
  elif is_project_dir "$INSTALL_DIR"; then
    log "Updating existing install directory: $INSTALL_DIR"
  else
    fail "No existing install found. Set NIAN_GALLERY_SOURCE_URL or NIAN_GALLERY_REPO_URL, or run without NIAN_GALLERY_ACTION=update for a fresh install."
  fi
elif is_project_dir "$(pwd)"; then
  INSTALL_DIR="$(pwd)"
  log "Using current project directory: $INSTALL_DIR"
elif is_project_dir "$INSTALL_DIR"; then
  log "Using existing install directory: $INSTALL_DIR"
else
  if [ -n "$SOURCE_URL" ]; then
    log "Downloading $APP_NAME archive to $INSTALL_DIR"
    download_archive "$SOURCE_URL" "$INSTALL_DIR"
  elif [ -n "$REPO_URL" ]; then
    log "Cloning $APP_NAME to $INSTALL_DIR"
    clone_repo "$REPO_URL" "$INSTALL_DIR"
  else
    fail "Set NIAN_GALLERY_SOURCE_URL to a .tar.gz archive or NIAN_GALLERY_REPO_URL to a git repository.

Example:
  curl -fsSL https://example.com/nian-gallery/install.sh | NIAN_GALLERY_SOURCE_URL=https://example.com/nian-gallery.tar.gz sh"
  fi
fi

cd "$INSTALL_DIR"
if [ "$INSTALL_MODE" = "docker" ]; then
  log "Starting Docker deployment in $INSTALL_DIR"
  start_docker
elif [ "$INSTALL_MODE" = "node" ]; then
  log "Running Node bootstrap in $INSTALL_DIR"
  start_node
else
  fail "Unknown NIAN_GALLERY_INSTALL_MODE: $INSTALL_MODE. Use docker or node."
fi
