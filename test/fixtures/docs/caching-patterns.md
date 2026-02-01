# Caching Patterns

Improve application performance with effective caching strategies.

## Cache-Aside Pattern

Application manages cache explicitly:

```typescript
async function getUser(id: string): Promise<User> {
  // Check cache first
  const cached = await redis.get(`user:${id}`);
  if (cached) {
    return JSON.parse(cached);
  }

  // Cache miss - fetch from database
  const user = await db.users.findById(id);
  if (user) {
    await redis.set(`user:${id}`, JSON.stringify(user), "EX", 3600);
  }

  return user;
}
```

## Write-Through Cache

Update cache on every write:

```typescript
async function updateUser(id: string, data: Partial<User>): Promise<User> {
  // Update database
  const user = await db.users.update(id, data);

  // Update cache synchronously
  await redis.set(`user:${id}`, JSON.stringify(user), "EX", 3600);

  return user;
}
```

## Cache Invalidation

Invalidate stale data proactively:

```typescript
async function deleteUser(id: string): Promise<void> {
  await db.users.delete(id);

  // Remove from cache
  await redis.del(`user:${id}`);

  // Invalidate related caches
  await redis.del(`user:${id}:posts`);
  await redis.del(`user:${id}:followers`);
}
```

## TTL Strategy

Set appropriate expiration times:

| Data Type      | TTL | Reason                    |
| -------------- | --- | ------------------------- |
| Session tokens | 24h | Security                  |
| User profiles  | 1h  | Moderate change frequency |
| Static config  | 24h | Rarely changes            |
| Search results | 5m  | Freshness important       |
| Rate limits    | 1m  | Real-time accuracy needed |

## Cache Stampede Prevention

Prevent thundering herd with locking:

```typescript
async function getWithLock(key: string, fetchFn: () => Promise<unknown>) {
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  const lockKey = `lock:${key}`;
  const acquired = await redis.set(lockKey, "1", "NX", "EX", 10);

  if (!acquired) {
    // Another process is fetching, wait and retry
    await sleep(100);
    return getWithLock(key, fetchFn);
  }

  try {
    const data = await fetchFn();
    await redis.set(key, JSON.stringify(data), "EX", 3600);
    return data;
  } finally {
    await redis.del(lockKey);
  }
}
```

## Multi-Level Caching

Combine in-memory and distributed caches:

```typescript
class MultiLevelCache {
  private local = new Map<string, { value: unknown; expires: number }>();
  private redis: Redis;

  async get(key: string) {
    // L1: In-memory (fastest)
    const localEntry = this.local.get(key);
    if (localEntry && localEntry.expires > Date.now()) {
      return localEntry.value;
    }

    // L2: Redis (shared across instances)
    const redisValue = await this.redis.get(key);
    if (redisValue) {
      const parsed = JSON.parse(redisValue);
      this.local.set(key, { value: parsed, expires: Date.now() + 60000 });
      return parsed;
    }

    return null;
  }
}
```
