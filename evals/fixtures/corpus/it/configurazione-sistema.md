# Configurazione del Sistema

Guida alla configurazione dell'ambiente di sviluppo e produzione.

## File di Configurazione

### Struttura

```
config/
├── default.json      # Valori predefiniti
├── development.json  # Override per sviluppo
├── production.json   # Override per produzione
├── test.json         # Override per test
└── custom-environment-variables.json
```

### Esempio di Configurazione

```json
{
  "server": {
    "port": 3000,
    "host": "0.0.0.0"
  },
  "database": {
    "host": "localhost",
    "port": 5432,
    "name": "myapp",
    "pool": {
      "min": 2,
      "max": 10
    }
  },
  "logging": {
    "level": "info",
    "format": "json"
  },
  "cache": {
    "ttl": 3600,
    "maxSize": 1000
  }
}
```

## Variabili d'Ambiente

### Variabili Richieste

| Variabile      | Descrizione                    | Esempio                          |
| -------------- | ------------------------------ | -------------------------------- |
| `DATABASE_URL` | URL di connessione al database | `postgresql://user:pass@host/db` |
| `JWT_SECRET`   | Chiave segreta per i token     | `your-secret-key`                |
| `REDIS_URL`    | URL del server Redis           | `redis://localhost:6379`         |
| `LOG_LEVEL`    | Livello di logging             | `debug`, `info`, `warn`, `error` |

### Validazione all'Avvio

```typescript
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  NODE_ENV: z.enum(["development", "production", "test"]),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const env = envSchema.parse(process.env);

export { env };
```

## Configurazione Docker

### Dockerfile

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

USER node
EXPOSE 3000

CMD ["node", "dist/server.js"]
```

### Docker Compose

```yaml
version: "3.8"

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://postgres:password@db/myapp
      - REDIS_URL=redis://cache:6379
    depends_on:
      - db
      - cache

  db:
    image: postgres:16-alpine
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      POSTGRES_PASSWORD: password
      POSTGRES_DB: myapp

  cache:
    image: redis:7-alpine
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

## Configurazione Kubernetes

### ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  LOG_LEVEL: "info"
  CACHE_TTL: "3600"
  MAX_CONNECTIONS: "100"
```

### Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: app-secrets
type: Opaque
stringData:
  database-url: postgresql://user:pass@host/db
  jwt-secret: your-super-secret-key
```

### Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      containers:
        - name: app
          image: myapp:latest
          envFrom:
            - configMapRef:
                name: app-config
            - secretRef:
                name: app-secrets
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"
```

## Profili di Configurazione

### Sviluppo

```typescript
export const developmentConfig = {
  debug: true,
  logging: {
    level: "debug",
    prettyPrint: true,
  },
  database: {
    logging: true,
    synchronize: true,
  },
};
```

### Produzione

```typescript
export const productionConfig = {
  debug: false,
  logging: {
    level: "info",
    prettyPrint: false,
  },
  database: {
    logging: false,
    synchronize: false,
    ssl: {
      rejectUnauthorized: true,
    },
  },
};
```
