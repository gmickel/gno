# Deployment-Anleitung

Vollständige Anleitung für die Bereitstellung der Anwendung in Produktionsumgebungen.

## Voraussetzungen

- Docker 24.0 oder höher
- Kubernetes 1.28+
- Helm 3.x
- Zugang zum Container-Registry

## Umgebungsvariablen

Konfigurieren Sie folgende Umgebungsvariablen:

```bash
# Datenbank
DATABASE_URL=postgresql://user:pass@host:5432/db
DATABASE_POOL_SIZE=20

# Redis Cache
REDIS_URL=redis://localhost:6379

# Authentifizierung
JWT_SECRET=<sicherer-zufallswert>
SESSION_TIMEOUT=3600

# Monitoring
OTEL_ENDPOINT=http://collector:4317
LOG_LEVEL=info
```

## Container-Image erstellen

```bash
# Image bauen
docker build -t app:$(git rev-parse --short HEAD) .

# In Registry pushen
docker push registry.example.com/app:$(git rev-parse --short HEAD)
```

## Kubernetes-Deployment

### Namespace anlegen

```bash
kubectl create namespace production
```

### Secrets konfigurieren

```bash
kubectl create secret generic app-secrets \
  --from-literal=database-url="$DATABASE_URL" \
  --from-literal=jwt-secret="$JWT_SECRET" \
  -n production
```

### Helm-Chart installieren

```bash
helm upgrade --install app ./charts/app \
  --namespace production \
  --set image.tag=$(git rev-parse --short HEAD) \
  --set replicas=3 \
  --values values-production.yaml
```

## Health Checks

Die Anwendung stellt folgende Endpunkte bereit:

| Endpunkt        | Beschreibung        |
| --------------- | ------------------- |
| `/health/live`  | Liveness-Probe      |
| `/health/ready` | Readiness-Probe     |
| `/metrics`      | Prometheus-Metriken |

## Rollback-Verfahren

Bei Problemen zum vorherigen Release zurückkehren:

```bash
# Rollback zur vorherigen Version
helm rollback app -n production

# Oder zu einer bestimmten Revision
helm rollback app 5 -n production
```

## Skalierung

### Horizontale Skalierung

```bash
kubectl scale deployment app --replicas=5 -n production
```

### Autoscaling aktivieren

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: app-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: app
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

## Fehlerbehebung

### Logs überprüfen

```bash
kubectl logs -f deployment/app -n production
```

### Pod-Status anzeigen

```bash
kubectl describe pod -l app=app -n production
```
