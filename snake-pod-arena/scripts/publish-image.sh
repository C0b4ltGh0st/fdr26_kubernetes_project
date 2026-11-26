#!/usr/bin/env bash
set -Eeuo pipefail

# Build and publish the Snake Pod Arena image to Docker Hub, then configure
# Kustomize to deploy the image from the selected Docker Hub namespace.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_REPO="snake-pod-arena"
TAG="${1:-latest}"
KUSTOMIZATION_FILE="$ROOT_DIR/kustomization.yaml"

for command in docker; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Error: '$command' is required but was not found in PATH." >&2
    exit 1
  fi
done

if [[ ! -f "$ROOT_DIR/Dockerfile" || ! -f "$KUSTOMIZATION_FILE" ]]; then
  echo "Error: run this script from the project checkout; Dockerfile or kustomization.yaml is missing." >&2
  exit 1
fi

if [[ -t 0 ]]; then
  read -r -p "Docker Hub username: " DOCKERHUB_USER
else
  echo "Error: this script needs an interactive terminal to ask for your Docker Hub username." >&2
  exit 1
fi

if [[ -z "$DOCKERHUB_USER" ]]; then
  echo "Error: Docker Hub username cannot be empty." >&2
  exit 1
fi

if [[ ! "$DOCKERHUB_USER" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Error: username contains characters that are not valid for this image name." >&2
  exit 1
fi

if [[ ! "$TAG" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$ ]]; then
  echo "Error: '$TAG' is not a valid Docker image tag." >&2
  exit 1
fi

IMAGE="docker.io/${DOCKERHUB_USER}/${IMAGE_REPO}:${TAG}"

printf '\nLogging in to Docker Hub as %s...\n' "$DOCKERHUB_USER"
# Docker prompts securely for credentials; no password/token is stored in this script.
docker login --username "$DOCKERHUB_USER"

printf '\nBuilding %s...\n' "$IMAGE"
docker build --tag "$IMAGE" "$ROOT_DIR"

printf '\nPushing %s...\n' "$IMAGE"
docker push "$IMAGE"

# Update the image namespace/tag used by `kubectl apply -k .`.
# The image name is a known, single-line Kustomize entry in this project.
if command -v python3 >/dev/null 2>&1; then
  DOCKERHUB_USER="$DOCKERHUB_USER" TAG="$TAG" KUSTOMIZATION_FILE="$KUSTOMIZATION_FILE" python3 - <<'PY'
import os
from pathlib import Path

path = Path(os.environ["KUSTOMIZATION_FILE"])
text = path.read_text()
old_name = "    newName: afkproficoder/snake-pod-arena"
new_name = f"    newName: {os.environ['DOCKERHUB_USER']}/snake-pod-arena"
old_tag = "    newTag: latest"
new_tag = f"    newTag: {os.environ['TAG']}"
if old_name not in text:
    raise SystemExit("Could not find the expected Kustomize image entry; image was pushed, but kustomization.yaml was not changed.")
text = text.replace(old_name, new_name, 1)
if old_tag in text:
    text = text.replace(old_tag, new_tag, 1)
else:
    raise SystemExit("Could not find the expected Kustomize tag entry; image was pushed, but kustomization.yaml was not changed.")
path.write_text(text)
PY
else
  echo "Warning: python3 not found; image was pushed, but kustomization.yaml was not updated." >&2
fi

cat <<MSG

Success!
  Published image: $IMAGE
  Kustomize image:  $DOCKERHUB_USER/$IMAGE_REPO:$TAG

Deploy it with:
  kubectl apply -k "$ROOT_DIR"
  kubectl -n snake-arena rollout status deployment/snake-arena
MSG
