# Ottimizzazione delle Performance

Guida completa per migliorare le prestazioni delle applicazioni web.

## Caching

### Cache a Livello di Applicazione

Implementare una cache in memoria per dati frequentemente acceduti:

```typescript
import { LRUCache } from "lru-cache";

const cache = new LRUCache<string, unknown>({
  max: 500, // Massimo 500 elementi
  ttl: 1000 * 60 * 5, // 5 minuti di vita
});

async function getDatiUtente(id: string): Promise<Utente> {
  const chiaveCache = `utente:${id}`;

  // Verifica cache
  const cached = cache.get(chiaveCache);
  if (cached) {
    return cached as Utente;
  }

  // Carica dal database
  const utente = await db.utenti.findUnique({ where: { id } });

  // Salva in cache
  cache.set(chiaveCache, utente);

  return utente;
}
```

### Cache Redis per Dati Distribuiti

Per applicazioni multi-istanza, utilizzare Redis:

```typescript
import { Redis } from "ioredis";

const redis = new Redis(process.env.REDIS_URL);

async function getCachedData<T>(
  chiave: string,
  fetcher: () => Promise<T>,
  ttlSecondi: number = 300
): Promise<T> {
  const cached = await redis.get(chiave);
  if (cached) {
    return JSON.parse(cached);
  }

  const dati = await fetcher();
  await redis.setex(chiave, ttlSecondi, JSON.stringify(dati));

  return dati;
}
```

## Ottimizzazione Database

### Indici

Creare indici appropriati per le query frequenti:

```sql
-- Indice per ricerche per email
CREATE INDEX idx_utenti_email ON utenti(email);

-- Indice composto per query comuni
CREATE INDEX idx_ordini_utente_data
ON ordini(utente_id, data_creazione DESC);

-- Indice parziale per dati attivi
CREATE INDEX idx_prodotti_attivi
ON prodotti(categoria_id)
WHERE attivo = true;
```

### Query Ottimizzate

Evitare il problema N+1:

```typescript
// LENTO - N+1 query
const ordini = await db.ordini.findMany();
for (const ordine of ordini) {
  ordine.articoli = await db.articoli.findMany({
    where: { ordineId: ordine.id },
  });
}

// VELOCE - Una singola query con join
const ordini = await db.ordini.findMany({
  include: {
    articoli: true,
  },
});
```

## Lazy Loading

### Caricamento Differito dei Componenti

```typescript
import { lazy, Suspense } from 'react';

// Caricamento lazy del componente pesante
const GraficoComplesso = lazy(() => import('./GraficoComplesso'));

function Dashboard() {
  return (
    <div>
      <h1>Dashboard</h1>
      <Suspense fallback={<Spinner />}>
        <GraficoComplesso dati={dati} />
      </Suspense>
    </div>
  );
}
```

### Caricamento Immagini Lazy

```typescript
function ImmagineOttimizzata({ src, alt }: Props) {
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
    />
  );
}
```

## Compressione

### Compressione delle Risposte

```typescript
import compression from "compression";

app.use(
  compression({
    filter: (req, res) => {
      // Non comprimere risposte già compresse
      if (req.headers["x-no-compression"]) {
        return false;
      }
      return compression.filter(req, res);
    },
    level: 6, // Bilanciamento tra velocità e dimensione
  })
);
```

## Monitoraggio Performance

### Metriche Chiave

```typescript
import { Histogram, Counter } from "prom-client";

const tempoRichiesta = new Histogram({
  name: "http_request_duration_seconds",
  help: "Durata delle richieste HTTP",
  labelNames: ["method", "route", "status"],
  buckets: [0.1, 0.5, 1, 2, 5],
});

const richiesteContatore = new Counter({
  name: "http_requests_total",
  help: "Contatore totale richieste HTTP",
  labelNames: ["method", "route", "status"],
});

// Middleware per raccogliere metriche
app.use((req, res, next) => {
  const inizio = Date.now();

  res.on("finish", () => {
    const durata = (Date.now() - inizio) / 1000;
    const labels = {
      method: req.method,
      route: req.route?.path || "unknown",
      status: res.statusCode.toString(),
    };

    tempoRichiesta.observe(labels, durata);
    richiesteContatore.inc(labels);
  });

  next();
});
```

## Best Practices

1. **Misurare prima di ottimizzare** - Usa profiler per identificare i colli di bottiglia
2. **Cache strategica** - Cachea dati costosi da calcolare o recuperare
3. **Minimizzare le richieste** - Raggruppare le chiamate API quando possibile
4. **Ottimizzare le immagini** - Usare formati moderni (WebP, AVIF)
5. **Code splitting** - Caricare solo il codice necessario
