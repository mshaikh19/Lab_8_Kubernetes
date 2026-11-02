# Lab 7: API Gateway, Service Discovery & Cloud Deployment

**Student ID:** 202512074  
**Course:** IT645 — Web Services & SOA  
**Lab:** 7 — API Gateway, Service Discovery & Cloud Deployment  
**Application:** Microservices Platform

---

## Architecture Diagram

```
                        ┌─────────────────────┐
                        │   Client / Postman  │
                        └──────────┬──────────┘
                                   │  HTTP requests to :3000
                                   ▼
                   ╔═══════════════════════════════╗
                   ║     API Gateway  :3000        ║  ← PUBLIC (Internet / localhost)
                   ║  /users  /products  /orders   ║
                   ║  Routing • Logging • Errors   ║
                   ╚══════╤════════╤══════╤════════╝
                          │        │      │
         ┌────────────────┘        │      └─────────────────┐
         │                         │                        │
╔════════╧═════════════════════════╧════════════════════════╧═════════╗
║              Docker Network: campus-network (Internal Only)         ║
║                                                                     ║
║  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐           ║
║  │ User Service │    │Product Service│   │ Order Service│           ║
║  │  :3001       │    │  :3002       │    │  :3003       │           ║
║  │ (no ext port)│    │ (no ext port)│    │ (no ext port)│           ║
║  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘           ║
║         │                   │                   │                   ║
║         ▼                   ▼                   ▼                   ║
║  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐           ║
║  │   User DB    │    │  Product DB  │    │   Order DB   │           ║
║  │  (MongoDB)   │    │  (MongoDB)   │    │  (MongoDB)   │           ║
║  └──────────────┘    └──────────────┘    └──────────────┘           ║
╚═════════════════════════════════════════════════════════════════════╝

                  MongoDB Atlas (cloud) or local containers
```

**Key design decision**: Only the **API Gateway's port 3000** is exposed externally. The three microservice containers have **no `ports:` mapping** in `compose.yaml` — they are reachable only from within the Docker network via the gateway or via direct inter-service calls (e.g., Order Service calling User and Product services internally).

---

## Part A — API Gateway

### What the Gateway Does

| Concern               | Implementation                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Routing**           | `/users/*` → User Service, `/products/*` → Product Service, `/orders/*` → Order Service                                            |
| **Health check**      | `GET /health` returns gateway status + service registry (no proxying)                                                              |
| **Request logging**   | `morgan` logs method, path, target service, response status, and response time                                                     |
| **Error handling**    | Proxy `error` event catches `ECONNREFUSED`/`ENOTFOUND` → returns `503 Service Unavailable`; other proxy errors → `502 Bad Gateway` |
| **No business logic** | The gateway only routes and handles cross-cutting concerns                                                                         |

### Gateway Endpoints

| Gateway Path    | Routed To               | Method(s)        |
| --------------- | ----------------------- | ---------------- |
| `GET /health`   | Gateway itself          | GET              |
| `/users`        | User Service `:3001`    | GET, POST        |
| `/users/:id`    | User Service `:3001`    | GET, PUT, DELETE |
| `/products`     | Product Service `:3002` | GET, POST        |
| `/products/:id` | Product Service `:3002` | GET, PUT, DELETE |
| `/orders`       | Order Service `:3003`   | GET, POST        |
| `/orders/:id`   | Order Service `:3003`   | GET              |

### Sample Gateway Log Output

```
[Gateway]  API Gateway running on port 3000
[Gateway] Service Registry (loaded from environment):
[Gateway]   User Service    → http://user-service:3001
[Gateway]   Product Service → http://product-service:3002
[Gateway]   Order Service   → http://order-service:3003
[Gateway] Routes: /users  /products  /orders  /health

GET /health → gateway | status=200 | 12.976 ms
[Gateway] → Forwarding GET /users/101 to User Service (http://user-service:3001)
[Gateway] ← User Service responded with 200 for GET /users/101
GET /users/101 → User Service | status=200 | 6.518 ms
[Gateway] → Forwarding POST /orders to Order Service (http://order-service:3003)
[Gateway] ← Order Service responded with 201 for POST /orders
POST /orders → Order Service | status=201 | 124.239 ms
[Gateway] Error forwarding GET /users/101 → User Service: EAI_AGAIN
GET /users/101 → User Service | status=502 | 5015.616 ms   ← unreachable service
```

### Discussion: Why Use an API Gateway?

> **Answer (Part A discussion question):**
>
> Without a gateway, clients must know the address of every individual service — and there could be dozens in a real system. An API Gateway provides **a single stable entry point** that hides all internal service locations from the outside world. This means:
>
> 1. **Single entry point** — clients call one URL; internal topology can change freely.
> 2. **Internal structure is hidden** — the number of services, their ports, and their hosts are invisible to callers.
> 3. **Centralized cross-cutting concerns** — logging, authentication, rate-limiting, and error handling are implemented once in the gateway rather than duplicated in every service. In this lab, request logging and 502/503 error handling live entirely in the gateway; none of the three backend services need to know they are behind a proxy.

---

## Part B — Service Discovery (Configuration-Based)

### How It Works

Service locations are **never hard-coded** inside route-handling code. Instead, the gateway reads them from environment variables at startup:

```javascript
// api-gateway/server.js — service registry built from env vars
const SERVICE_REGISTRY = {
  user: process.env.USER_SERVICE_URL || "http://user-service:3001",
  product: process.env.PRODUCT_SERVICE_URL || "http://product-service:3002",
  order: process.env.ORDER_SERVICE_URL || "http://order-service:3003",
};
```

The routing table is built from this registry:

```javascript
app.use("/users", buildProxy("user", "User Service", "/users"));
app.use("/products", buildProxy("product", "Product Service", "/products"));
app.use("/orders", buildProxy("order", "Order Service", "/orders"));
```

### Service Registry (compose.yaml environment block)

```yaml
api-gateway:
  environment:
    - USER_SERVICE_URL=http://user-service:3001
    - PRODUCT_SERVICE_URL=http://product-service:3002
    - ORDER_SERVICE_URL=http://order-service:3003
```

### Proof of Config-Only Change

To move, say, the User Service to port 4001 **without touching any code**:

1. Edit `compose.yaml`: change `USER_SERVICE_URL=http://user-service:4001`
2. Run `docker compose up -d --build api-gateway`
3. `GET http://localhost:3000/users` still works — gateway re-points automatically.

The same Docker image can run locally and in the cloud by simply changing the environment variables — the application code is never modified.

### Static vs. Dynamic Service Discovery

| Feature               | Static Config (this lab)                       | Dynamic Registry (Consul, Eureka, K8s DNS)                  |
| --------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| **Service locations** | Fixed at deploy time in env vars / config file | Registered at runtime by services themselves                |
| **Failure detection** | None — gateway retries until timeout           | Health-check driven; failed instances removed automatically |
| **Scaling**           | Manual config update per instance              | New instances register, load balancer updated automatically |
| **Complexity**        | Very low — just env vars                       | Requires a running registry cluster                         |
| **Best for**          | Small, stable deployments (this lab)           | Large fleets with frequent scale events                     |

> **What dynamic discovery adds:** A static config file cannot detect that a service has crashed or that a new replica has been added. Dynamic registries (e.g., Consul) allow services to _self-register_ on startup and _deregister_ on failure, enabling the gateway to route only to healthy, currently running instances — essential in production autoscaling environments.

---

## Part C — Cloud Deployment

### Platform Chosen: Render (render.com)

Render was selected because it supports Docker-based deployments from a GitHub repository on a free tier, provides automatic HTTPS, and internal service networking between services in the same account.

### Local vs. Cloud Architecture

| Layer        | Local (Docker Compose)                 | Cloud (Render)                                     |
| ------------ | -------------------------------------- | -------------------------------------------------- |
| **Entry**    | Postman → `http://localhost:3000`      | Internet client → `https://<gateway>.onrender.com` |
| **Gateway**  | API Gateway container, port 3000       | Render Web Service (public)                        |
| **Network**  | Docker bridge network `campus-network` | Render internal service URLs                       |
| **Services** | `http://user-service:3001` etc.        | Render internal URLs per service                   |
| **Database** | Local MongoDB containers               | MongoDB Atlas (cloud)                              |

**What stays the same:** application code, routes, API contract, environment variable names.  
**What changes:** where it runs, how service URLs are resolved, public exposure of the gateway.

### Cloud Deployment Steps

#### Prerequisites

- Docker images built and tested locally.
- MongoDB Atlas cluster available (from Lab 4/6).
- GitHub repository with the project code (secrets excluded via `.gitignore`).

#### Step-by-Step Deployment

1. **Prepare the repository**
   - Ensure `.gitignore` excludes `.env` and `node_modules/`.
   - Push the code to GitHub.

2. **Create services on Render**
   - Create a new Web Service for each of the four containers:
     - `-gateway` (Public)
     - `-user` (Private / Internal)
     - `-product` (Private / Internal)
     - `-order` (Private / Internal)
   - For each service, point Render to the respective subdirectory (e.g., `./api-gateway`) as the root directory and select **Docker** as the environment.

3. **Set environment variables on Render**
   - For the gateway service:
     ```
     USER_SERVICE_URL=https://USER_SERVICE_HOST
     PRODUCT_SERVICE_URL=https://PRODUCT_SERVICE_HOST
     ORDER_SERVICE_URL=https://ORDER_SERVICE_HOST
     GATEWAY_PORT=3000
     ```
   - For each microservice (example — User Service):
     ```
     MONGO_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/userdb?retryWrites=true&w=majority
     USER_SERVICE_PORT=3001
     ```
   - **Secrets are set via the Render dashboard environment variables panel — never committed to the repository.**

4. **Configure MongoDB Atlas**
   - In Atlas, add the Render outbound IP addresses (or allow access from anywhere: `0.0.0.0/0`) to the Atlas Network Access list.
   - Use the Atlas connection string as the `MONGO_URI` environment variable.

5. **Deploy and obtain the public URL**
   - Render builds and deploys each service automatically when you push to the connected branch.
   - The gateway's public URL is displayed in the Render dashboard, e.g.:
     `https://GATEWAY_HOST`

6. **Verify cloud deployment**
   - Test the health endpoint: `GET https://GATEWAY_HOST/health`
   - Re-run all Postman tests with `gateway_url` set to the cloud URL.

### MongoDB Atlas Configuration

```
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/<dbname>?retryWrites=true&w=majority
USER_SERVICE_URL=<cloud service URL>
PRODUCT_SERVICE_URL=<cloud service URL>
ORDER_SERVICE_URL=<cloud service URL>
```

> ⚠️ **Never commit passwords or connection strings to GitHub.** Use the platform's cloud environment variable / secrets panel.

### Free-Tier Limitation Note

Render's free tier spins down services after 15 minutes of inactivity. The first request to a dormant service may take 20–30 seconds to respond while the container restarts. This is expected behaviour on the free tier and does not affect functionality.

---

## Gateway Failure Test (Part A, Step 8)

This is an explicit practical test proving the gateway's centralized error handling.

### Test Steps

| Step | Action                                                | Expected Result                                                                                |
| ---- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1    | Start all services: `docker compose up -d`            | All 7 containers running                                                                       |
| 2    | `GET /users/101` through gateway                      | **200 OK** — `{"id":"101","name":"Jane Doe",...}`                                              |
| 3    | Stop User Service: `docker compose stop user-service` | Container stopped                                                                              |
| 4    | `GET /users/101` through gateway                      | **502 Bad Gateway** — `{"error":"502 Bad Gateway","message":"User Service is unreachable..."}` |
| 5    | Verify no hang/crash                                  | Response arrives immediately (within ~5s timeout)                                              |
| 6    | Restart: `docker compose start user-service`          | Container starts                                                                               |
| 7    | `GET /users/101` through gateway                      | **200 OK** — full recovery confirmed                                                           |

### Failure Response (Step 4)

```json
{
  "error": "502 Bad Gateway",
  "message": "User Service is unreachable. Please try again later.",
  "targetService": "User Service",
  "targetUrl": "http://user-service:3001",
  "details": "getaddrinfo EAI_AGAIN user-service"
}
```

**Gateway log during failure:**

```
[Gateway] Error forwarding GET /users/101 → User Service: EAI_AGAIN
GET /users/101 → User Service | status=502 | 5015.616 ms
```

This demonstrates why an API Gateway is essential: the gateway fails fast and returns a structured error instead of hanging, and recovery requires no gateway restart — it resumes routing as soon as the downstream service comes back up.

---

## How to Run Locally

### Prerequisites

- Docker Desktop installed and running
- No other process using port 3000

### Start All Services

```bash
docker compose up -d --build
```

_Builds and starts: api-gateway, user-service, product-service, order-service + 3 MongoDB containers._

### Verify All Containers Are Running

```bash
docker compose ps
```

_Expected output shows 7 containers (gateway + 3 services + 3 databases), all `running`._

### Test the Gateway

```bash
# Health check
curl http://localhost:3000/health

# List users
curl http://localhost:3000/users

# Get specific user
curl http://localhost:3000/users/101

# List products
curl http://localhost:3000/products

# List orders
curl http://localhost:3000/orders
```

### View Gateway Logs

```bash
docker logs api-gateway --follow
```

### Stop All Services

```bash
docker compose down
```

---

## Project Structure

```
202512074_Assignment_7/
├── api-gateway/
│   ├── server.js               # Gateway: routing, logging, error handling
│   ├── package.json
│   ├── Dockerfile
│   └── .dockerignore
├── user-service/
│   ├── server.js               # User CRUD + MongoDB/in-memory store
│   ├── package.json
│   ├── Dockerfile
│   └── .dockerignore
├── product-service/
│   ├── server.js               # Product CRUD + MongoDB/in-memory store
│   ├── package.json
│   ├── Dockerfile
│   └── .dockerignore
├── order-service/
│   ├── server.js               # Order creation + inter-service calls
│   ├── package.json
│   ├── Dockerfile
│   └── .dockerignore
├── compose.yaml                # Gateway + 3 services + 3 DBs; only port 3000 exposed
├── .env.example                # Service registry template (no secrets)
├── .gitignore                  # Excludes .env and node_modules
└── README.md
```

---

## Written Reflection

Introducing the API Gateway and cloud deployment fundamentally changed how the system is used and operated compared to Lab 6. In Lab 6, every client had to know and directly call three separate service addresses — any internal change (port, hostname, scaling) would break clients. The gateway now acts as the single, stable public face of the entire system: one URL, one place for logging, one place for error handling, and complete freedom to reorganize internals without touching client code.

Operationally, the shift to cloud deployment replaces the question "is it running on my machine?" with "is it reachable over the internet?" MongoDB Atlas was already cloud-hosted; moving the application containers to Render completes that picture, making the full stack accessible from anywhere without keeping a laptop running. The configuration-driven service registry (environment variables) proved its value immediately: local Docker hostnames and cloud platform URLs are interchangeable just by editing environment variables — the same image runs in both environments without modification. The failure test reinforced one of the gateway's most important operational properties: when a downstream service crashes, the gateway absorbs the failure gracefully and recovers automatically once the service restarts, with no restart required on the gateway itself.

---

## Troubleshooting

| Issue                                 | Fix                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Gateway returns 503                   | Ensure the target service container is running: `docker compose ps`                                           |
| Gateway won't start                   | Check that port 3000 is not already in use: `netstat -an \| findstr 3000`                                     |
| MongoDB connection failed             | Services fall back to in-memory store; check `MONGO_URI` env var is correct                                   |
| Cloud services can't reach each other | Ensure cloud service URLs in env vars use the correct hostname (Render internal URLs differ from public URLs) |
| Render service sleeps (free tier)     | Render free tier spins down after inactivity; first request may take ~30s to wake up                          |
| `502 Bad Gateway` from gateway        | Target service is stopped or crashed — check `docker compose ps` and restart the relevant service             |
| `404 Not Found` from gateway          | Requested path is not `/users`, `/products`, `/orders`, or `/health`                                          |
| Atlas connection refused              | Add your deployment IP to the MongoDB Atlas Network Access list                                               |

---

## Lab 8: Kubernetes, CI/CD, and Monitoring

This Lab 8 continuation deploys the Lab 7 services to the `lab8` namespace. Only
the gateway is externally exposed; the other services use Kubernetes DNS names.

### Build and publish images

Replace `REPLACE_OWNER` in the manifests with the GitHub Container Registry owner.
The workflow in `.github/workflows/ci.yml` runs `npm ci`, builds all four images,
and publishes SHA-tagged images to GHCR on pushes to `main`.

### Kubernetes deployment

```powershell
kubectl config current-context
kubectl get nodes
kubectl create namespace lab8
kubectl -n lab8 create secret generic app-secrets `
  --from-literal=MONGO_URI="mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/?retryWrites=true&w=majority"
kubectl apply -f k8s/configmap.yaml -f k8s/gateway-deployment.yaml `
  -f k8s/user-deployment.yaml -f k8s/product-deployment.yaml `
  -f k8s/order-deployment.yaml -n lab8
kubectl get deployments,pods,services -n lab8
kubectl rollout status deployment/api-gateway -n lab8
```

Do not commit a real MongoDB URI. `k8s/secret-template.yaml` is documentation
only and must not be applied with its placeholder values.

Find the gateway address with `kubectl get service gateway-service -n lab8`.
For Minikube, use `minikube service gateway-service -n lab8 --url`.

### Scaling and self-healing evidence

```powershell
kubectl scale deployment/user-service --replicas=3 -n lab8
kubectl get pods -n lab8 -l app=user-service
kubectl delete pod <user-pod-name> -n lab8
kubectl get pods -n lab8 -l app=user-service -w
kubectl describe pod <pod-name> -n lab8
kubectl logs <pod-name> -n lab8
kubectl get endpoints -n lab8
```

### Prometheus and Grafana

The gateway exposes `/metrics` with request counters and duration totals.
`monitoring/prometheus.yml` scrapes the gateway Service DNS name. Load this
configuration into the Prometheus installation used by the cluster, then verify
the target is `UP` and query:

```promql
up{job="gateway"}
rate(http_requests_total[5m])
```

Import `monitoring/grafana-dashboard.json` into Grafana after adding Prometheus
as a data source. Send requests through the gateway and compare the request-rate
panel before and after the traffic burst.

### Optional automatic deployment

Set the repository variable `ENABLE_DEPLOY=true` and add a base64-encoded
`KUBE_CONFIG` Actions secret. The workflow then updates each deployment to the
new commit-SHA image and waits for every rollout to complete.
