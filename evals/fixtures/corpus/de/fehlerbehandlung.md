# Fehlerbehandlung und Logging

Best Practices für robuste Fehlerbehandlung in TypeScript-Anwendungen.

## Fehlerklassen definieren

Erstellen Sie spezifische Fehlerklassen für verschiedene Fehlerkategorien:

```typescript
class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly isOperational: boolean = true
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(
    message: string,
    public readonly details: unknown[]
  ) {
    super(message, "VALIDATION_ERROR", 400);
  }
}

class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} nicht gefunden`, "NOT_FOUND", 404);
  }
}
```

## Globaler Fehler-Handler

Implementieren Sie einen zentralen Fehler-Handler:

```typescript
function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (err instanceof AppError) {
    logger.warn({ err, req }, "Operationaler Fehler");
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
      },
    });
  }

  // Unerwartete Fehler
  logger.error({ err, req }, "Unerwarteter Fehler");
  return res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Ein interner Fehler ist aufgetreten",
    },
  });
}
```

## Strukturiertes Logging

Verwenden Sie strukturierte Logs für bessere Analysierbarkeit:

```typescript
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
});

// Verwendung
logger.info({ userId: "123", action: "login" }, "Benutzer angemeldet");
logger.error({ err, requestId: "456" }, "Verarbeitung fehlgeschlagen");
```

## Retry-Logik

Für transiente Fehler implementieren Sie Retry-Mechanismen:

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  delayMs: number = 1000
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;

      logger.warn(
        { attempt, maxAttempts, err },
        "Versuch fehlgeschlagen, wiederhole..."
      );
      await sleep(delayMs * Math.pow(2, attempt - 1));
    }
  }
  throw new Error("Unreachable");
}
```

## Circuit Breaker

Schützen Sie externe Dienste mit Circuit Breaker:

```typescript
class CircuitBreaker {
  private failures = 0;
  private lastFailure?: Date;
  private state: "closed" | "open" | "half-open" = "closed";

  constructor(
    private readonly threshold: number = 5,
    private readonly timeout: number = 30000
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailure!.getTime() > this.timeout) {
        this.state = "half-open";
      } else {
        throw new Error("Circuit offen - Dienst vorübergehend nicht verfügbar");
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = "closed";
  }

  private onFailure() {
    this.failures++;
    this.lastFailure = new Date();
    if (this.failures >= this.threshold) {
      this.state = "open";
      logger.warn("Circuit Breaker geöffnet");
    }
  }
}
```

## Monitoring und Alerting

Konfigurieren Sie Alerts für kritische Fehler:

```yaml
# Prometheus-Alert-Regel
groups:
  - name: application
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Hohe Fehlerrate erkannt"
          description: "Fehlerrate über 10% in den letzten 5 Minuten"
```
