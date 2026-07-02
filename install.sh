#!/usr/bin/env sh
set -eu

APP_NAME="webgl-gallery"
DEFAULT_SOURCE_URL="${WEBGL_GALLERY_DEFAULT_SOURCE_URL:-https://github.com/ArisaTaki/webgl-gallery/releases/latest/download/webgl-gallery.tar.gz}"
DEFAULT_PREBUILT_IMAGE="${WEBGL_GALLERY_DEFAULT_IMAGE:-ghcr.io/arisataki/webgl-gallery:latest}"
DEFAULT_PORT="${WEBGL_GALLERY_DEFAULT_PORT:-5280}"
INSTALL_DIR="${WEBGL_GALLERY_DIR:-$HOME/$APP_NAME}"
INSTALL_MODE="${WEBGL_GALLERY_INSTALL_MODE:-docker}"
ACTION="${WEBGL_GALLERY_ACTION:-install}"
PURGE="${WEBGL_GALLERY_PURGE:-0}"
SOURCE_URL="${WEBGL_GALLERY_SOURCE_URL:-${WEBGL_GALLERY_SOURCE:-}}"
REPO_URL="${WEBGL_GALLERY_REPO_URL:-${WEBGL_GALLERY_REPO:-}}"
BRANCH="${WEBGL_GALLERY_BRANCH:-main}"
HOSTNAME="${WEBGL_GALLERY_HOSTNAME:-}"
IMAGE_MODE="${WEBGL_GALLERY_IMAGE_MODE:-prebuilt}"
STORAGE_MODE="${WEBGL_GALLERY_STORAGE_MODE:-}"

if [ "${WEBGL_GALLERY_UPDATE:-}" = "1" ]; then
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

is_truthy() {
  case "$1" in
    1|true|TRUE|yes|YES|y|Y) return 0 ;;
    *) return 1 ;;
  esac
}

is_project_dir() {
  [ -f "$1/package.json" ] && [ -f "$1/docker-compose.yml" ]
}

download_archive() {
  url="$1"
  target="$2"
  tmp_dir="$(mktemp -d 2>/dev/null || mktemp -d -t webgl-gallery)"
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
  tmp_dir="$(mktemp -d 2>/dev/null || mktemp -d -t webgl-gallery)"
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
      --exclude public/data \
      --exclude public/media \
      "$from"/ "$to"/
  else
    (cd "$from" && tar \
      --exclude .git \
      --exclude node_modules \
      --exclude .gallery \
      --exclude .uploads \
      --exclude .env \
      --exclude public/data \
      --exclude public/media \
      -cf - .) | (cd "$to" && tar -xf -)
  fi
}

project_version() {
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json 2>/dev/null | head -n 1
}

versioned_prebuilt_image() {
  image="$1"
  version="$(project_version)"
  case "$DEFAULT_PREBUILT_IMAGE" in
    *:latest) image_repo="${DEFAULT_PREBUILT_IMAGE%:latest}" ;;
    *) printf '%s\n' "$image"; return 0 ;;
  esac
  if [ -z "$version" ]; then
    printf '%s\n' "$image"
    return 0
  fi
  case "$image" in
    "$DEFAULT_PREBUILT_IMAGE"|"$image_repo":v[0-9]*) printf '%s:v%s\n' "$image_repo" "$version" ;;
    *) printf '%s\n' "$image" ;;
  esac
}

prepare_env() {
  had_env=0
  if [ -f .env ]; then
    had_env=1
  else
    cp .env.example .env
  fi
  mkdir -p .gallery .uploads public/data public/media
  HOSTNAME="${WEBGL_GALLERY_HOSTNAME:-$(env_value WEBGL_GALLERY_HOSTNAME "$HOSTNAME")}"
  IMAGE_MODE="${WEBGL_GALLERY_IMAGE_MODE:-$(env_value WEBGL_GALLERY_IMAGE_MODE "$IMAGE_MODE")}"
  STORAGE_MODE="${WEBGL_GALLERY_STORAGE_MODE:-$(env_value WEBGL_GALLERY_STORAGE_MODE "$STORAGE_MODE")}"
  WEBGL_GALLERY_PORT="${WEBGL_GALLERY_PORT:-$(env_value WEBGL_GALLERY_PORT "$DEFAULT_PORT")}"
  WEBGL_GALLERY_COMPOSE_PROJECT="${WEBGL_GALLERY_COMPOSE_PROJECT:-$(env_value WEBGL_GALLERY_COMPOSE_PROJECT webgl-gallery)}"
  default_image="$DEFAULT_PREBUILT_IMAGE"
  if [ "$IMAGE_MODE" = "build" ]; then
    default_image="webgl-gallery:local"
  fi
  image_from_env="${WEBGL_GALLERY_IMAGE+x}"
  WEBGL_GALLERY_IMAGE="${WEBGL_GALLERY_IMAGE:-$(env_value WEBGL_GALLERY_IMAGE "$default_image")}"
  if [ "$IMAGE_MODE" = "prebuilt" ] && [ "$image_from_env" != "x" ]; then
    WEBGL_GALLERY_IMAGE="$(versioned_prebuilt_image "$WEBGL_GALLERY_IMAGE")"
  fi
  set_env WEBGL_GALLERY_COMPOSE_PROJECT "$WEBGL_GALLERY_COMPOSE_PROJECT"
  set_env WEBGL_GALLERY_HOSTNAME "$HOSTNAME"
  set_env WEBGL_GALLERY_PORT "$WEBGL_GALLERY_PORT"
  set_env WEBGL_GALLERY_IMAGE_MODE "$IMAGE_MODE"
  set_env WEBGL_GALLERY_IMAGE "$WEBGL_GALLERY_IMAGE"
  configure_storage_profile "$had_env"
  configure_tunnel_profile "$had_env"
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

docker_compose_available() {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
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

unset_env() {
  key="$1"
  if [ -f .env ]; then
    grep -v "^$key=" .env > .env.tmp 2>/dev/null || true
    mv .env.tmp .env
  fi
}

tty_available() {
  [ -c /dev/tty ] && ( : < /dev/tty ) >/dev/null 2>&1 && ( : > /dev/tty ) >/dev/null 2>&1
}

should_prompt_install() {
  had_env="$1"
  case "${WEBGL_GALLERY_INTERACTIVE:-auto}" in
    0|false|no) return 1 ;;
    1|true|yes) tty_available ;;
    *) [ "$ACTION" = "install" ] && [ "$had_env" = "0" ] && tty_available ;;
  esac
}

tty_log() {
  if tty_available; then
    printf '%s\n' "$*" > /dev/tty
  else
    log "$*"
  fi
}

prompt_value() {
  label="$1"
  default="${2:-}"
  required="${3:-0}"
  while :; do
    if [ -n "$default" ]; then
      printf '%s [%s]: ' "$label" "$default" > /dev/tty
    else
      printf '%s: ' "$label" > /dev/tty
    fi
    IFS= read -r PROMPT_VALUE < /dev/tty || PROMPT_VALUE=""
    [ -n "$PROMPT_VALUE" ] || PROMPT_VALUE="$default"
    if [ "$required" != "1" ] || [ -n "$PROMPT_VALUE" ]; then
      return 0
    fi
    tty_log "This value is required."
  done
}

prompt_secret_value() {
  label="$1"
  default="${2:-}"
  required="${3:-0}"
  while :; do
    if [ -n "$default" ]; then
      printf '%s [already set, press Enter to keep]: ' "$label" > /dev/tty
    else
      printf '%s: ' "$label" > /dev/tty
    fi
    if command -v stty >/dev/null 2>&1; then
      old_stty="$(stty -g < /dev/tty 2>/dev/null || true)"
      stty -echo < /dev/tty 2>/dev/null || true
      IFS= read -r PROMPT_VALUE < /dev/tty || PROMPT_VALUE=""
      [ -z "$old_stty" ] || stty "$old_stty" < /dev/tty 2>/dev/null || true
      printf '\n' > /dev/tty
    else
      IFS= read -r PROMPT_VALUE < /dev/tty || PROMPT_VALUE=""
    fi
    [ -n "$PROMPT_VALUE" ] || PROMPT_VALUE="$default"
    if [ "$required" != "1" ] || [ -n "$PROMPT_VALUE" ]; then
      return 0
    fi
    tty_log "This value is required."
  done
}

prompt_storage_mode() {
  while :; do
    tty_log ""
    tty_log "Choose image storage:"
    tty_log "  1) Local folder on this server"
    tty_log "  2) Cloudflare R2"
    prompt_value "Storage mode" "1" "1"
    case "$PROMPT_VALUE" in
      1|local|Local|LOCAL) STORAGE_MODE="local"; return 0 ;;
      2|r2|R2) STORAGE_MODE="r2"; return 0 ;;
      *) tty_log "Please enter 1 for local or 2 for R2." ;;
    esac
  done
}

configure_storage_profile() {
  had_env="$1"
  config_storage_mode="$(existing_config_storage_mode || true)"
  if [ -z "${WEBGL_GALLERY_STORAGE_MODE:-}" ] && [ -n "$config_storage_mode" ]; then
    STORAGE_MODE="$config_storage_mode"
  fi
  if [ -z "$STORAGE_MODE" ] && r2_env_configured; then
    STORAGE_MODE="r2"
  fi
  if [ -z "$STORAGE_MODE" ] && [ "${WEBGL_GALLERY_INTERACTIVE:-auto}" != "auto" ] && should_prompt_install "$had_env"; then
    prompt_storage_mode
  fi
  STORAGE_MODE="${STORAGE_MODE:-local}"
  case "$STORAGE_MODE" in
    local)
      set_env WEBGL_GALLERY_STORAGE_MODE local
      clear_r2_env
      ;;
    r2)
      set_env WEBGL_GALLERY_STORAGE_MODE r2
      configure_r2_env "$had_env"
      ;;
    *)
      fail "Unknown WEBGL_GALLERY_STORAGE_MODE: $STORAGE_MODE. Use local or r2."
      ;;
  esac
}

clear_r2_env() {
  unset R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_PUBLIC_BUCKET R2_PRIVATE_BUCKET R2_PUBLIC_BASE_URL
  unset_env R2_ACCOUNT_ID
  unset_env R2_ACCESS_KEY_ID
  unset_env R2_SECRET_ACCESS_KEY
  unset_env R2_PUBLIC_BUCKET
  unset_env R2_PRIVATE_BUCKET
  unset_env R2_PUBLIC_BASE_URL
}

configure_r2_env() {
  had_env="$1"
  if ! r2_env_configured && [ "$(existing_config_storage_mode || true)" = "r2" ]; then
    return 0
  fi
  configure_required_env R2_ACCOUNT_ID "Cloudflare Account ID" plain "$had_env"
  configure_required_env R2_ACCESS_KEY_ID "R2 Access Key ID" secret "$had_env"
  configure_required_env R2_SECRET_ACCESS_KEY "R2 Secret Access Key" secret "$had_env"
  configure_required_env R2_PUBLIC_BUCKET "R2 public bucket" plain "$had_env"
  configure_required_env R2_PRIVATE_BUCKET "R2 private bucket" plain "$had_env"
  configure_required_env R2_PUBLIC_BASE_URL "R2 public base URL" plain "$had_env"
}

configure_required_env() {
  key="$1"
  label="$2"
  kind="$3"
  had_env="$4"
  eval "current_value=\"\${$key:-}\""
  [ -n "$current_value" ] || current_value="$(env_value "$key")"
  if [ -z "$current_value" ] && should_prompt_install "$had_env"; then
    if [ "$kind" = "secret" ]; then
      prompt_secret_value "$label" "" "1"
    else
      prompt_value "$label" "" "1"
    fi
    current_value="$PROMPT_VALUE"
  fi
  [ -n "$current_value" ] || fail "$key is required when WEBGL_GALLERY_STORAGE_MODE=r2."
  set_env "$key" "$current_value"
}

r2_env_configured() {
  for key in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_PUBLIC_BUCKET R2_PRIVATE_BUCKET R2_PUBLIC_BASE_URL; do
    eval "value=\"\${$key:-}\""
    [ -n "$value" ] || value="$(env_value "$key")"
    [ -n "$value" ] || return 1
  done
  return 0
}

existing_config_storage_mode() {
  for config_file in .gallery/config.json "${GALLERY_CONFIG_PATH:-}" "${GALLERY_CONFIG_DIR:+$GALLERY_CONFIG_DIR/config.json}"; do
    [ -n "$config_file" ] && [ -f "$config_file" ] || continue
    storage_kind="$(
      awk '
        /"storage"[[:space:]]*:/ { in_storage = 1 }
        in_storage && /"kind"[[:space:]]*:[[:space:]]*"(local|r2)"/ {
          line = $0
          sub(/^.*"kind"[[:space:]]*:[[:space:]]*"/, "", line)
          sub(/".*$/, "", line)
          print line
          exit
        }
      ' "$config_file"
    )"
    case "$storage_kind" in
      local|r2)
        printf '%s\n' "$storage_kind"
        return 0
        ;;
    esac
  done
  return 1
}

configure_tunnel_profile() {
  had_env="$1"
  current_token="${CLOUDFLARE_TUNNEL_TOKEN:-$(env_value CLOUDFLARE_TUNNEL_TOKEN)}"
  if [ -z "$current_token" ] && should_prompt_install "$had_env"; then
    prompt_value "Expose with Cloudflare Tunnel? (y/N)" "N" "0"
    case "$PROMPT_VALUE" in
      y|Y|yes|YES)
        prompt_secret_value "CLOUDFLARE_TUNNEL_TOKEN" "" "1"
        current_token="$PROMPT_VALUE"
        ;;
    esac
  fi
  CLOUDFLARE_TUNNEL_TOKEN="$current_token"
}

start_docker() {
  need_cmd docker
  docker_compose_available || fail "Docker Compose v2 is required. Please update Docker Desktop or Docker Engine."
  prepare_env
  case "$IMAGE_MODE" in
    prebuilt|build) ;;
    *) fail "Unknown WEBGL_GALLERY_IMAGE_MODE: $IMAGE_MODE. Use build or prebuilt." ;;
  esac
  if [ "${WEBGL_GALLERY_SKIP_START:-}" = "1" ]; then
    log "Skipping Docker start because WEBGL_GALLERY_SKIP_START=1."
    if [ "$IMAGE_MODE" = "prebuilt" ]; then
      if has_tunnel_token; then
        log "Start later with: docker compose -f docker-compose.image.yml --profile tunnel up -d"
      else
        log "Start later with: docker compose -f docker-compose.image.yml up -d"
      fi
    elif has_tunnel_token; then
      log "Start later with: docker compose --profile tunnel up -d --build"
    else
      log "Start later with: docker compose up -d --build"
    fi
    return 0
  fi
  if [ "$IMAGE_MODE" = "prebuilt" ]; then
    start_docker_prebuilt
    return 0
  fi
  if has_tunnel_token; then
    docker compose --profile tunnel up -d --build
    log ""
    if [ -n "$HOSTNAME" ]; then
      log "WebGL Gallery is starting at https://$HOSTNAME"
    else
      log "WebGL Gallery is starting through Cloudflare Tunnel."
    fi
  else
    docker compose up -d --build
    log ""
    log "WebGL Gallery is starting at http://localhost:${WEBGL_GALLERY_PORT:-$DEFAULT_PORT}"
    log "To expose it with Cloudflare Tunnel, set CLOUDFLARE_TUNNEL_TOKEN in .env and run:"
    log "  docker compose --profile tunnel up -d"
  fi
  wait_for_gallery
  if has_tunnel_token && [ -n "$HOSTNAME" ]; then
    log "Public URL: https://$HOSTNAME"
  elif has_tunnel_token; then
    log "Public URL: use the public hostname configured in Cloudflare Zero Trust."
  fi
  log "Setup page: http://localhost:${WEBGL_GALLERY_PORT:-$DEFAULT_PORT}/setup"
  log "Studio: http://localhost:${WEBGL_GALLERY_PORT:-$DEFAULT_PORT}/studio"
  log "Update later: rerun this installer with WEBGL_GALLERY_ACTION=update; .env, .gallery, and .uploads are preserved."
}

start_docker_prebuilt() {
  [ -f docker-compose.image.yml ] || fail "docker-compose.image.yml is required for WEBGL_GALLERY_IMAGE_MODE=prebuilt."
  log "Using prebuilt Docker image: ${WEBGL_GALLERY_IMAGE:-$DEFAULT_PREBUILT_IMAGE}"
  if ! docker compose -f docker-compose.image.yml pull gallery; then
    if docker image inspect "${WEBGL_GALLERY_IMAGE:-$DEFAULT_PREBUILT_IMAGE}" >/dev/null 2>&1; then
      log "Image pull failed; using the matching local image."
    else
      fail "Could not pull ${WEBGL_GALLERY_IMAGE:-$DEFAULT_PREBUILT_IMAGE}, and no matching local image exists."
    fi
  fi
  if has_tunnel_token; then
    docker compose -f docker-compose.image.yml --profile tunnel up -d
    log ""
    if [ -n "$HOSTNAME" ]; then
      log "WebGL Gallery is starting at https://$HOSTNAME"
    else
      log "WebGL Gallery is starting through Cloudflare Tunnel."
    fi
  else
    docker compose -f docker-compose.image.yml up -d
    log ""
    log "WebGL Gallery is starting at http://localhost:${WEBGL_GALLERY_PORT:-$DEFAULT_PORT}"
    log "To expose it with Cloudflare Tunnel, set CLOUDFLARE_TUNNEL_TOKEN in .env and run:"
    log "  docker compose -f docker-compose.image.yml --profile tunnel up -d"
  fi
  wait_for_gallery
  if has_tunnel_token && [ -n "$HOSTNAME" ]; then
    log "Public URL: https://$HOSTNAME"
  elif has_tunnel_token; then
    log "Public URL: use the public hostname configured in Cloudflare Zero Trust."
  fi
  log "Setup page: http://localhost:${WEBGL_GALLERY_PORT:-$DEFAULT_PORT}/setup"
  log "Studio: http://localhost:${WEBGL_GALLERY_PORT:-$DEFAULT_PORT}/studio"
  log "Update later: rerun this installer with WEBGL_GALLERY_ACTION=update; .env, .gallery, and .uploads are preserved."
}

wait_for_gallery() {
  url="http://127.0.0.1:${WEBGL_GALLERY_PORT:-$DEFAULT_PORT}/api/setup/status"
  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi
  i=1
  while [ "$i" -le 60 ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "WebGL Gallery is ready."
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  log "WebGL Gallery is still starting. Check logs with: docker compose logs -f"
}

start_node() {
  need_cmd node
  need_cmd npm
  prepare_env
  node scripts/bootstrap.mjs
}

remove_docker_stack() {
  project="$1"
  remove_volumes="$2"
  if ! command -v docker >/dev/null 2>&1; then
    log "Docker is not available; skipping container removal."
    return 0
  fi

  down_args="down --remove-orphans"
  if is_truthy "$remove_volumes"; then
    down_args="down --volumes --remove-orphans"
  fi
  if docker compose version >/dev/null 2>&1; then
    if [ -f docker-compose.image.yml ]; then
      docker compose -f docker-compose.image.yml --profile tunnel $down_args || true
    fi
    if [ -f docker-compose.yml ]; then
      docker compose --profile tunnel $down_args || true
    fi
  else
    log "Docker Compose is not available; falling back to Docker container cleanup."
  fi

  container_ids="$(docker ps -aq --filter "label=com.docker.compose.project=$project" 2>/dev/null || true)"
  if [ -n "$container_ids" ]; then
    docker rm -f $container_ids >/dev/null 2>&1 || true
  fi

  for container_name in \
    "$project-gallery-1" \
    "$project-cloudflared-1" \
    "${project}_gallery_1" \
    "${project}_cloudflared_1"; do
    docker rm -f "$container_name" >/dev/null 2>&1 || true
  done

  network_ids="$(docker network ls -q --filter "label=com.docker.compose.project=$project" 2>/dev/null || true)"
  if [ -n "$network_ids" ]; then
    docker network rm $network_ids >/dev/null 2>&1 || true
  fi
  docker network rm "${project}_default" >/dev/null 2>&1 || true
}

uninstall_app() {
  found_install_dir=1
  if [ -n "${WEBGL_GALLERY_DIR:-}" ]; then
    if ! is_project_dir "$INSTALL_DIR"; then
      found_install_dir=0
    fi
  elif is_project_dir "$(pwd)"; then
    INSTALL_DIR="$(pwd)"
  elif is_project_dir "$INSTALL_DIR"; then
    found_install_dir=1
  else
    found_install_dir=0
  fi

  log "Uninstalling $APP_NAME from $INSTALL_DIR"
  if [ "$found_install_dir" = "1" ]; then
    cd "$INSTALL_DIR"
    WEBGL_GALLERY_COMPOSE_PROJECT="${WEBGL_GALLERY_COMPOSE_PROJECT:-$(env_value WEBGL_GALLERY_COMPOSE_PROJECT webgl-gallery)}"
  else
    WEBGL_GALLERY_COMPOSE_PROJECT="${WEBGL_GALLERY_COMPOSE_PROJECT:-webgl-gallery}"
  fi
  if is_truthy "$PURGE"; then
    remove_docker_stack "$WEBGL_GALLERY_COMPOSE_PROJECT" 1
  else
    remove_docker_stack "$WEBGL_GALLERY_COMPOSE_PROJECT" 0
  fi

  if is_truthy "$PURGE"; then
    case "$INSTALL_DIR" in
      ""|"/"|"$HOME"|"$HOME/"|"."|"..")
        fail "Refusing to purge unsafe install directory: $INSTALL_DIR"
        ;;
    esac
    if [ -e "$INSTALL_DIR" ]; then
      parent_dir="$(dirname "$INSTALL_DIR")"
      base_dir="$(basename "$INSTALL_DIR")"
      cd "$parent_dir"
      rm -rf "$base_dir"
      log "Removed install directory: $INSTALL_DIR"
    else
      log "Install directory was already absent: $INSTALL_DIR"
    fi
    log "Containers and Docker networks for project $WEBGL_GALLERY_COMPOSE_PROJECT were removed."
  else
    if [ "$found_install_dir" != "1" ]; then
      log "No install directory found at $INSTALL_DIR."
    fi
    log "Containers removed. Files are preserved at $INSTALL_DIR"
    log "Preserved data includes .env, .gallery, .uploads, public/media, and public/data."
    log "To delete the install directory too, rerun uninstall with WEBGL_GALLERY_PURGE=1."
  fi
}

case "$ACTION" in
  install|update|uninstall) ;;
  *) fail "Unknown WEBGL_GALLERY_ACTION: $ACTION. Use install, update, or uninstall." ;;
esac

if [ "$ACTION" = "uninstall" ]; then
  uninstall_app
  exit 0
fi

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
    SOURCE_URL="$DEFAULT_SOURCE_URL"
    log "Updating $APP_NAME from latest release into $INSTALL_DIR"
    download_archive "$SOURCE_URL" "$INSTALL_DIR"
  else
    fail "No existing install found. Run without WEBGL_GALLERY_ACTION=update for a fresh install."
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
    SOURCE_URL="$DEFAULT_SOURCE_URL"
    log "Downloading $APP_NAME latest release to $INSTALL_DIR"
    download_archive "$SOURCE_URL" "$INSTALL_DIR"
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
  fail "Unknown WEBGL_GALLERY_INSTALL_MODE: $INSTALL_MODE. Use docker or node."
fi
