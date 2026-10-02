#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${TERRARIUM_REPO_URL:-https://github.com/terion-labs/terrarium.git}"
GITHUB_REPO="${TERRARIUM_GITHUB_REPO:-terion-labs/terrarium}"
REF=""
UPDATE=false
EMBEDDED_BOOTSTRAP_REF="" # TERRARIUM_RELEASE_REF
BOOTSTRAP_REF="${TERRARIUM_BOOTSTRAP_REF:-}"
TMPDIR_PATH=""

if [[ -z "${BOOTSTRAP_REF}" && -n "${EMBEDDED_BOOTSTRAP_REF}" ]]; then
  BOOTSTRAP_REF="${EMBEDDED_BOOTSTRAP_REF}"
fi

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --ref REF
  --update
  --help

All other flags are forwarded to `terrariumctl install` or `terrariumctl update`.

Behavior:
  - without --ref, the bootstrap downloads the bundled release when the installer is release-pinned
  - otherwise without --ref, it downloads the latest Terrarium release bundle
  - with a tag-like --ref, it downloads that release bundle
  - with a branch-like --ref (for example main), it falls back to a source build
  - with --update, it updates an existing Terrarium install instead of starting the install wizard
EOF
}

die() {
  printf '[terrarium-bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[terrarium-bootstrap] %s\n' "$*"
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    die "run as root"
  fi
}

ensure_os() {
  source /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || die "Ubuntu is required"
  [[ "${VERSION_ID:-}" == "24.04" || "${VERSION_ID:-}" == "26.04" ]] || die "Ubuntu 24.04 or 26.04 is required"
}

ensure_bootstrap_deps() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get -o DPkg::Lock::Timeout=900 update -y
  apt-get -o DPkg::Lock::Timeout=900 install -y ca-certificates curl
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chown root:root /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg
  install -o root -g root -m 0644 /dev/null /etc/apt/sources.list.d/github-cli.list
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/github-cli.list
  apt-get -o DPkg::Lock::Timeout=900 update -y
  apt-get -o DPkg::Lock::Timeout=900 install -y gh unzip python3
  gh attestation verify --help >/dev/null || die "GitHub CLI does not support attestation verification after installing from the official apt repository"
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    return
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get -o DPkg::Lock::Timeout=900 update -y
  apt-get -o DPkg::Lock::Timeout=900 install -y git
}

ensure_bun() {
  if [[ -x /opt/bun/bin/bun ]]; then
    return
  fi
  mkdir -p /opt/bun
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    aarch64|arm64) printf 'arm64' ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
}

is_release_ref() {
  local ref="$1"
  [[ -z "${ref}" ]] && return 0
  [[ "${ref}" =~ ^v?[0-9]+(\.[0-9]+)*([.-][A-Za-z0-9]+)?$ ]]
}

resolve_latest_tag() {
  local arch="$1"
  TERRARIUM_ASSET="terrarium-linux-${arch}.zip" \
    python3 -c '
import json
import os
import sys

asset = os.environ["TERRARIUM_ASSET"]
for release in json.load(sys.stdin):
    if release.get("draft") or release.get("prerelease"):
        continue
    if any(item.get("name") == asset for item in release.get("assets", [])):
        print(release.get("tag_name", ""))
        break
' < <(curl -fsSL "https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=50" 2>/dev/null)
}

parse_args() {
  FORWARD_ARGS=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ref)
        [[ $# -ge 2 ]] || die "--ref requires a value"
        REF="${2:-}"
        shift 2
        ;;
      --ref=*)
        REF="${1#--ref=}"
        shift
        ;;
      --update)
        UPDATE=true
        shift
        ;;
      --)
        shift
        while [[ $# -gt 0 ]]; do
          FORWARD_ARGS+=("$1")
          shift
        done
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        FORWARD_ARGS+=("$1")
        shift
        ;;
    esac
  done
}

download_release_bundle() {
  local bundle_dir="$1"
  local arch="$2"
  local resolved_ref="$3"
  local bundle_name="terrarium-linux-${arch}.zip"
  local attestation_name="terrarium-release-attestation.sigstore.json"
  local asset_url="https://github.com/${GITHUB_REPO}/releases/download/${resolved_ref}/${bundle_name}"
  local checksums_url="https://github.com/${GITHUB_REPO}/releases/download/${resolved_ref}/SHA256SUMS"
  local attestation_url="https://github.com/${GITHUB_REPO}/releases/download/${resolved_ref}/${attestation_name}"
  local checksum_line

  log "downloading Terrarium release bundle ${resolved_ref} (${arch})"
  curl -fsSL "${asset_url}" -o "${bundle_dir}/${bundle_name}" || return 1
  curl -fsSL "${checksums_url}" -o "${bundle_dir}/SHA256SUMS" || return 1
  curl -fsSL "${attestation_url}" -o "${bundle_dir}/${attestation_name}" || return 1
  checksum_line="$(awk -v asset="${bundle_name}" '$2 == asset || $2 == "*" asset { print $1 "  " asset; found = 1 } END { if (!found) exit 1 }' "${bundle_dir}/SHA256SUMS")" || return 1
  (cd "${bundle_dir}" && printf '%s\n' "${checksum_line}" | sha256sum -c -) || return 1
  gh attestation verify "${bundle_dir}/${bundle_name}" --bundle "${bundle_dir}/${attestation_name}" -R "${GITHUB_REPO}" --signer-workflow "${GITHUB_REPO}/.github/workflows/release.yml" || return 1
  unzip -q "${bundle_dir}/${bundle_name}" -d "${bundle_dir}"
  [[ -x "${bundle_dir}/dist/terrariumctl" ]] || return 1
}

install_release_bundle() {
  local bundle_dir="$1"
  local arch="$2"
  local resolved_ref="$3"

  download_release_bundle "${bundle_dir}" "${arch}" "${resolved_ref}" || die "failed to download Terrarium release bundle ${resolved_ref}"
  run_terrariumctl_install "${bundle_dir}" "${bundle_dir}/dist/terrariumctl" "${resolved_ref}" "${FORWARD_ARGS[@]}"
}

build_from_source() {
  local build_dir="$1"
  local source_ref="$2"

  log "falling back to source build for ref ${source_ref}"
  if [[ -d "${REPO_URL}" ]] || [[ "${REPO_URL}" == file://* ]]; then
    local source_path="${REPO_URL#file://}"
    [[ -d "${source_path}" ]] || die "local Terrarium source path not found: ${source_path}"
    mkdir -p "${build_dir}/repo"
    cp -a "${source_path}/." "${build_dir}/repo/"
  else
    ensure_git
    git clone --depth 1 --branch "${source_ref}" "${REPO_URL}" "${build_dir}/repo"
  fi
  ensure_bun
  (
    cd "${build_dir}/repo"
    /opt/bun/bin/bun install --frozen-lockfile || /opt/bun/bin/bun install --no-progress
    /opt/bun/bin/bun scripts/build.ts
  )
  run_terrariumctl_install "${build_dir}/repo" "${build_dir}/repo/dist/terrariumctl" "${source_ref}" "${FORWARD_ARGS[@]}"
}

is_non_interactive_install() {
  if [[ "${#FORWARD_ARGS[@]}" -eq 0 ]]; then
    return 1
  fi

  local arg
  for arg in "${FORWARD_ARGS[@]}"; do
    case "${arg}" in
      --non-interactive|--help|-h)
        return 0
        ;;
    esac
  done
  return 1
}

run_terrariumctl_install() {
  local bundle_dir="$1"
  local terrariumctl="$2"
  local ref="$3"
  shift 3

  if [[ "${UPDATE}" == "true" ]]; then
    TERRARIUM_BUNDLE_DIR="${bundle_dir}" TERRARIUM_REPO_URL="${REPO_URL}" "${terrariumctl}" update --ref "${ref}" "$@"
    return
  fi

  if is_non_interactive_install; then
    TERRARIUM_BUNDLE_DIR="${bundle_dir}" TERRARIUM_REPO_URL="${REPO_URL}" "${terrariumctl}" install --ref "${ref}" "$@"
    return
  fi

  local tty_fd
  if { exec {tty_fd}</dev/tty; } 2>/dev/null; then
    TERRARIUM_BUNDLE_DIR="${bundle_dir}" TERRARIUM_REPO_URL="${REPO_URL}" "${terrariumctl}" install --ref "${ref}" "$@" <&"${tty_fd}"
    exec {tty_fd}<&-
    return
  fi

  die "interactive install requires a TTY; run this from an interactive shell or pass --non-interactive with full configuration"
}

main() {
  local tmpdir arch resolved_ref bootstrap_parent
  parse_args "$@"
  require_root
  ensure_os
  ensure_bootstrap_deps

  bootstrap_parent="/var/lib/terrarium/bootstrap"
  install -d -o root -g root -m 0700 "${bootstrap_parent}"
  TMPDIR_PATH="$(mktemp -d "${bootstrap_parent}/run.XXXXXX")"
  chmod 0700 "${TMPDIR_PATH}"
  trap '[[ -n "${TMPDIR_PATH}" ]] && rm -rf "${TMPDIR_PATH}"' EXIT
  tmpdir="${TMPDIR_PATH}"
  arch="$(detect_arch)"

  if [[ -z "${REF}" ]]; then
    if [[ -n "${BOOTSTRAP_REF}" ]]; then
      install_release_bundle "${tmpdir}" "${arch}" "${BOOTSTRAP_REF}" || die "Terrarium install failed for release bundle ${BOOTSTRAP_REF}"
      exit 0
    fi
    resolved_ref="$(resolve_latest_tag "${arch}")" || die "failed to resolve latest Terrarium release tag"
    [[ -n "${resolved_ref}" ]] || die "failed to resolve latest Terrarium release tag"
    install_release_bundle "${tmpdir}" "${arch}" "${resolved_ref}" || die "Terrarium install failed for release bundle ${resolved_ref}"
    exit 0
  fi

  if is_release_ref "${REF}"; then
    install_release_bundle "${tmpdir}" "${arch}" "${REF}" || die "Terrarium install failed for release bundle ${REF}"
    exit 0
  fi

  build_from_source "${tmpdir}" "${REF}"
}

main "$@"
