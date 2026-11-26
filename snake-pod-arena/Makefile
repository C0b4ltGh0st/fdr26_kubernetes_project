IMAGE ?= afkproficoder/snake-pod-arena:latest
NS    := snake-arena

.PHONY: help up build push load deploy open down logs pods dev

help:
	@echo "make up       deploy the published image from Docker Hub"
	@echo "make build    build the image locally"
	@echo "make push     push the locally built image to Docker Hub"
	@echo "make deploy   (re)apply manifests + .env  (run after editing .env)"
	@echo "make open     port-forward the UI to http://localhost:8080"
	@echo "make pods     watch the snake pods"
	@echo "make logs     arena logs"
	@echo "make down     remove everything"
	@echo "make dev      run without Kubernetes (mock API, snakes are local processes)"

up: deploy

build:
	docker build -t $(IMAGE) .

# Optional: load a locally built image into a local cluster (instead of pulling from Docker Hub).
load:
	@ctx=$$(kubectl config current-context); \
	case "$$ctx" in \
	  kind-*) kind load docker-image $(IMAGE) --name "$${ctx#kind-}" ;; \
	  minikube) minikube image load $(IMAGE) ;; \
	  docker-desktop|rancher-desktop|orbstack) echo "$$ctx shares the local docker daemon, nothing to load" ;; \
	  *) echo "Context '$$ctx': push $(IMAGE) to a registry the cluster can pull from and set it in kustomization.yaml (images:)" ;; \
	esac

deploy:
	kubectl apply -k .
	kubectl -n $(NS) rollout status deploy/snake-arena

open:
	kubectl -n $(NS) port-forward svc/snake-arena 8080:80

pods:
	kubectl -n $(NS) get pods -w

logs:
	kubectl -n $(NS) logs deploy/snake-arena -f

down:
	kubectl delete -k .

dev:
	node dev/mock-kube.js
