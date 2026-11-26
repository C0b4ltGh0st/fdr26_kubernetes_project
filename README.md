# 🐍 Snake Pod Arena (Kubernetes edition)

Every snake is a **real pod**. The web page is served by the **arena pod**, which also referees the game
and creates/deletes the snake pods through the Kubernetes API.
The browser shows each snake as a color-coded column of tanks on a 25 × 15 board, with one tank per occupied square.

```
 browser ──SSE/HTTP──►  arena pod  ──(Kubernetes API: create/delete pods)──►  snake pod ×N
 (Start/Stop/Restart)   │ web UI + referee + controller                         │ node snake.js
                        ◄──────────── join / long-poll world / post move ───────┘
```

* Config lives in **`.env`** only. The browser shows it read-only.
* After deploy the game is **stopped** and **no snake pod exists**. Press **Start** in the browser to create them.
* **Stop** deletes all snake pods. **Restart** = Stop + Start (new pods, scores reset).

## Deploy to course-45

Set `KUBECONFIG` to the path of your `course-45.config` file, publish the Docker image,
and apply the Kubernetes manifests:

```bash
cd snake-pod-arena
export KUBECONFIG="<path to file course-45.config>"

chmod +x ./scripts/publish-image.sh
sudo ./scripts/publish-image.sh

kubectl apply -k .
```

The publish script prompts for your Docker Hub username, logs in to Docker Hub, builds, tags,
and pushes the image. It also updates `kustomization.yaml` to use the published image.

The script runs `docker login` (Docker prompts for your password/token securely), builds
`<your-dockerhub-username>/snake-pod-arena:<tag>`, pushes it, and updates the image name/tag in
`kustomization.yaml` so future `kubectl apply -k .` deployments use your image. Make sure the
repository exists in your Docker Hub account and is public, or configure registry credentials
for your Kubernetes cluster. The ConfigMap name carries a content hash, so the arena pod is
replaced automatically and comes back **stopped** (press Start again).

You can check the deployment status with:

```bash
kubectl -n snake-arena rollout status deployment/snake-arena
```

No cluster handy? `make -C snake-pod-arena dev` runs everything locally with a fake Kubernetes API; each "pod" is a local
process. Same UI, same game, same protocol.

## Ingress

`k8s/ingress.yaml` exposes the arena through Traefik at `course-45.network.garden` (edit `host:` and
`ingressClassName` for your cluster). It routes everything to Service `snake-arena:80`; the live game
stream (SSE) works through Traefik without extra config. The snake-pod endpoints (`/api/snake/*`) are
refused when a request comes through the ingress.

Note: anyone who can open the page can press Start/Stop. If that's public, put a Traefik `basicAuth`
middleware in front.

## `.env`

| Variable | Default | Meaning |
|---|---|---|
| `SNAKE_COUNT` | 8 | snake pods created on Start (1–20) |
| `MAX_FOOD` | 6 | food items on the board (1–50) |
| `MAX_DEATHS` | 5 | a snake pod exits with an error after this many deaths (1–20) |
| `TICK_MS` | 240 | ms per game tick (50–2000) |
| `START_TIMEOUT_SECONDS` | 30 | after Start, play begins when all pods are ready, or after this long with the ones that are |

## How it works

* **Start**: the arena creates `SNAKE_COUNT` pods (`restartPolicy: Never`, labelled
  `app.kubernetes.io/name=snake`, owned by the arena pod). They run the same image with `node snake.js`.
  Pods appear on the board once they have joined; until then the sidebar shows their real status
  (`ContainerCreating`, `ErrImagePull`, …).
* **Every tick** the arena publishes the world. Each snake pod long-polls it, uses BFS to find food
  and side hits, checks its space with flood-fill, and posts its move.
  The arena resolves all moves simultaneously. A pod that answers too late just keeps going straight.
* **Collisions** count from the positions at the start of the tick. A snake that hits another
  snake from the side wins at any length. When two heads enter the same cell or swap cells,
  the longer snake wins. If both are the same length, both die. Collisions between columns show
  a comic burst at the impact, and each defeated formation blinks at its previous position.
* **Deaths**: a snake that hits a wall, hits itself, or loses a collision restarts at length 1.
  After `MAX_DEATHS` the pod **exits with code 1** → real `Error` status in `kubectl get pods`.
* **`kubectl delete pod <snake>`** removes that snake from the board (shown as `Evicted`/`Terminating`).
  It is not replaced until you Restart.
* **Cleanup**: snake pods are owned by the arena pod, so deleting/redeploying the arena garbage-collects
  them. The arena also deletes leftovers on boot and on SIGTERM.

## Troubleshooting

* Pods stuck in `ErrImagePull`: check that the cluster can reach Docker Hub and that
  `afkproficoder/snake-pod-arena:latest` is publicly pullable (or that registry credentials are configured).
  The deployment uses `imagePullPolicy: Always` to refresh the mutable `latest` tag.
* Banner "Could not create pods … forbidden": the RBAC in `k8s/rbac.yaml` wasn't applied.
* Cluster very slow / many snakes: raise `TICK_MS`, so pods can answer within a tick.

## Layout

```
.env                 ← all game settings
kustomization.yaml   ← turns .env into a ConfigMap, applies k8s/
k8s/                 ← Namespace, RBAC (pods only), Deployment + Service + Ingress
src/arena.js         ← web server + referee + pod controller
src/game.js          ← rules (pure logic)      src/ai.js + snake.js ← the snake pod
src/kube.js          ← tiny Kubernetes client  src/public/index.html ← UI
dev/mock-kube.js     ← `make dev` harness
Dockerfile, Makefile, scripts/publish-image.sh
```
