# Docker Deployment Guide

Containerize and deploy applications with Docker.

## Dockerfile Best Practices

Multi-stage builds for smaller images:

```dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
USER node
CMD ["node", "dist/server.js"]
```

## Docker Compose

Define multi-container applications:

```yaml
version: "3.8"

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgres://db:5432/myapp
      - REDIS_URL=redis://cache:6379
    depends_on:
      - db
      - cache
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  db:
    image: postgres:15-alpine
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      - POSTGRES_DB=myapp
      - POSTGRES_PASSWORD=secret

  cache:
    image: redis:7-alpine
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

## Container Security

Run containers securely:

```dockerfile
# Use non-root user
RUN addgroup -g 1001 appgroup && \
    adduser -u 1001 -G appgroup -s /bin/sh -D appuser
USER appuser

# Read-only filesystem
# docker run --read-only --tmpfs /tmp myapp

# Drop capabilities
# docker run --cap-drop=ALL --cap-add=NET_BIND_SERVICE myapp
```

## Health Checks

Monitor container health:

```typescript
// /health endpoint
app.get("/health", async (req, res) => {
  try {
    await db.query("SELECT 1");
    await redis.ping();
    res.json({ status: "healthy" });
  } catch (error) {
    res.status(503).json({ status: "unhealthy", error: error.message });
  }
});
```

## Resource Limits

Prevent resource exhaustion:

```yaml
services:
  app:
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 512M
        reservations:
          cpus: "0.25"
          memory: 256M
```

## Logging Best Practices

Log to stdout for container environments:

```typescript
// Use structured logging
const logger = {
  info: (msg: string, meta?: object) =>
    console.log(
      JSON.stringify({
        level: "info",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      })
    ),
  error: (msg: string, error?: Error) =>
    console.error(
      JSON.stringify({
        level: "error",
        msg,
        error: error?.message,
        ts: new Date().toISOString(),
      })
    ),
};
```

## Zero-Downtime Deployments

Rolling updates with health checks:

```yaml
deploy:
  replicas: 3
  update_config:
    parallelism: 1
    delay: 10s
    failure_action: rollback
  rollback_config:
    parallelism: 1
    delay: 10s
```
