# Blue-Green Deployment Setup Guide

This comprehensive guide details the process of cloning the repository, setting up the local environment, containerizing all components, and orchestrating a native **Blue-Green Deployment** strategy on a **Minikube** Kubernetes cluster.

---

## 1. Local Environment & Service Setup

### Step 1: Clone the Repository & Configure MongoDB
Clone your application repository and navigate to its root directory:
```bash
git clone <your-repository-url>
cd <repository-directory>
```

To run MongoDB locally for initial verification, spin up a lightweight, isolated Docker container:
```bash
docker run -d --name mongodb-local -p 27017:27017 -v mongo_data:/data/db mongo:7.0
```

### Step 2: Install Dependencies
Install dependencies concurrently for the backend and both frontend targets:
```bash
# Backend Dependencies
cd backend && npm install && cd ..

# Frontend Alpha Dependencies
cd frontend-blue && npm install && cd ..

# Frontend Beta Dependencies
cd frontend-green && npm install && cd ..
```

### Step 3: Configure Environment Variables
Create `.env` files in each service directory to tie the multi-tier application together.

**`backend/.env`**
```env
PORT=5000
MONGO_URI=mongodb://localhost:27017/blue_green_db
NODE_ENV=development
```

**`frontend-blue/.env`**
```env
PORT=3100
REACT_APP_API_URL=http://localhost:3100/users
```

**`frontend-green/.env`**
```env
PORT=3102
REACT_APP_API_URL=http://localhost:3200/users
```

### Step 4: Run Services & Verify Local Health Checks
Start the backend and both frontends locally:
```bash
# Terminal 1: Backend
cd backend && npm start

# Terminal 2: Frontend Alpha
cd frontend-alpha && npm start

# Terminal 3: Frontend Beta
cd frontend-beta && npm start
```

#### Verification Commands:
* **Backend Health Check:** Verify the server responds correctly.
  ```bash
  curl -X GET http://localhost:5000/api/health
  # Expected Response: { "status": "healthy", "database": "connected" }
  ```
* **User Registration & DB Verification:** Simulate a user registration payload to ensure data successfully cascades to MongoDB.
  ```bash
  curl -X POST http://localhost:5000/api/users \
    -H "Content-Type: application/json" \
    -d '{"username": "testuser", "email": "test@example.com"}'
  ```

---

## 2. Component Containerization

To prepare the multi-tier app for Kubernetes, construct standard, production-hardened `Dockerfiles` for each service using multi-stage builds.

### Backend Dockerfile (`backend/Dockerfile`)
```dockerfile
# --- Build Stage ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

# --- Runner Stage ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 1001 -S nodejs && adduser -S appuser -u 1001
USER appuser

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src

EXPOSE 5000
CMD ["node", "src/server.js"]
```

### Frontend Dockerfile (Used for both Alpha & Beta)
```dockerfile
# --- Build Stage ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Servicing Stage ---
FROM nginx:1.25-alpine
COPY --from=builder /app/build /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

---

## 3. Minikube Infrastructure & Core Deployment

To deploy images locally without managing external docker registry credentials, connect your shell context straight to Minikube's operational registry.

### Step 1: Start and Configure Minikube
```bash
minikube start --driver=docker
eval $(minikube docker-env)
```

### Step 2: Build the Container Images Inside Minikube
```bash
docker build -t app-backend:v1.0.0 ./backend
docker build -t app-frontend:v1.0.0 ./frontend-alpha
docker build -t app-frontend:v2.0.0 ./frontend-beta
```

### Step 3: Deploy Persistent Local State (MongoDB)
Create a localized environment file named `infrastructure.yaml` to provision state boundaries:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: mongo-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 2Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mongodb
spec:
  selector:
    matchLabels:
      app: mongodb
  template:
    metadata:
      labels:
        app: mongodb
    spec:
      containers:
        - name: mongodb
          image: mongo:7.0
          ports:
            - containerPort: 27017
          volumeMounts:
            - name: mongo-storage
              mountPath: /data/db
      volumes:
        - name: mongo-storage
          persistentVolumeClaim:
            claimName: mongo-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: mongodb-service
spec:
  selector:
    app: mongodb
  ports:
    - protocol: TCP
      port: 27017
      targetPort: 27017
```
Apply the database architecture:
```bash
kubectl apply -f infrastructure.yaml
```

---

## 4. Kubernetes Blue-Green Deployment Strategy

To run a blue-green strategy seamlessly, we maintain **two active Frontend Deployments** concurrently while mapping routing paths natively through mutable **Kubernetes Service Labels**.

### Step 1: Create the Routing Infrastructure Service (`service-production.yaml`)
This production service targets whatever deployment carries the specified `track` configuration label.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: frontend-production-service
spec:
  type: NodePort
  ports:
    - port: 80
      targetPort: 80
      nodePort: 30080
  selector:
    app: web-frontend
    track: blue
```

### Step 2: Create the Active "Blue" Deployment (`deploy-blue.yaml`)
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-frontend-blue
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web-frontend
      track: blue
  template:
    metadata:
      labels:
        app: web-frontend
        track: blue
    spec:
      containers:
        - name: frontend
          image: app-frontend:v1.0.0
          ports:
            - containerPort: 80
          readinessProbe:
            httpGet:
              path: /
              port: 80
            initialDelaySeconds: 5
            periodSeconds: 5
```

Apply both configurations to launch **v1.0.0 (Alpha)** into active rotation:
```bash
kubectl apply -f service-production.yaml
kubectl apply -f deploy-blue.yaml
```

### Step 3: Deploy the Staged "Green" Environment (`deploy-green.yaml`)
When **v2.0.0 (Beta)** is compiled and ready for release, deploy it alongside the blue cluster. Because the production service is constrained strictly to `track: blue`, this release introduces zero risk to operational client traffic.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-frontend-green
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web-frontend
      track: green
  template:
    metadata:
      labels:
        app: web-frontend
        track: green
    spec:
      containers:
        - name: frontend
          image: app-frontend:v2.0.0
          ports:
            - containerPort: 80
          readinessProbe:
            httpGet:
              path: /
              port: 80
            initialDelaySeconds: 5
            periodSeconds: 5
```
Apply the green infrastructure pipeline:
```bash
kubectl apply -f deploy-green.yaml
```

### Step 4: Perform Pre-flight Sanity Inspections
Before routing user requests to the green cluster, run an internal verification test by explicitly mapping network layers onto the green pods:
```bash
kubectl port-forward deployment/web-frontend-green 8080:80
```
Open `http://localhost:8080` in an isolated web browser to verify all components and workflows operating within the new layout are performing flawlessly.

### Step 5: Execute the Zero-Downtime Traffic Cutover
Once the green track passes testing, execute an atomic switch over the production configuration. This forces the unified Kubernetes service selector to shift immediately to the new targets:

```bash
kubectl patch service frontend-production-service -p '{"spec":{"selector":{"track":"green"}}}'
```

Instantly, all traffic hitting port `30080` resolves directly onto the Green backend instances!

### Step 6: Disaster Recovery Rollback Strategy
If runtime monitoring signals unexpected errors, execute an immediate rollback by changing the live operational routing selector back to the isolated, unaltered blue tracking framework:

```bash
kubectl patch service frontend-production-service -p '{"spec":{"selector":{"track":"blue"}}}'
```

---

## 5. Architectural & Implementation Decisions

1. **Declarative Service Level Abstractions**: Opted for native Kubernetes Service label updates rather than modifying heavy custom ingress controller weightings. This eliminates ingress-propagation delays and guarantees a zero-latency traffic switch.
2. **Minikube Registry Optimization (`eval $(minikube docker-env)`)**: Directs local terminal building streams straight into Minikube's runtime registry engine. This circumvents network overhead, layout synchronization delays, and the need for authenticated external Docker image registries.
3. **Multi-Stage Scratch Execution Frameworks**: Built using explicit build splits to drop development packages and compilers entirely from final production runtime containers. This reduces container image footprints by over 70% and narrows the overall attack surface.
4. **Resilient Readiness Safeguards**: Integrated structured `readinessProbes` into every frontend layout track. This guarantees that traffic shifts never hit a pod before its processes have initialized, preventing dropped requests during a cutover.