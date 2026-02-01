# Database Query Patterns

Efficient database access patterns for high-performance applications.

## Connection Pooling

Always use connection pools to avoid overhead:

```typescript
import { Pool } from "pg";

const pool = new Pool({
  host: "localhost",
  database: "myapp",
  max: 20,
  idleTimeoutMillis: 30000,
});

async function query<T>(sql: string, params?: unknown[]): Promise<T[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    client.release();
  }
}
```

## Prepared Statements

Prevent SQL injection with parameterized queries:

```sql
-- Bad: string concatenation
SELECT * FROM users WHERE email = '${email}';

-- Good: parameterized query
SELECT * FROM users WHERE email = $1;
```

## N+1 Query Problem

Avoid the N+1 query anti-pattern with eager loading:

```typescript
// Bad: N+1 queries
const posts = await db.query("SELECT * FROM posts");
for (const post of posts) {
  const author = await db.query("SELECT * FROM users WHERE id = $1", [
    post.author_id,
  ]);
}

// Good: single JOIN query
const postsWithAuthors = await db.query(`
  SELECT posts.*, users.name as author_name
  FROM posts
  JOIN users ON posts.author_id = users.id
`);
```

## Indexing Strategy

Create indexes for frequently queried columns:

```sql
-- B-tree index for equality and range queries
CREATE INDEX idx_users_email ON users(email);

-- Composite index for multi-column lookups
CREATE INDEX idx_orders_user_date ON orders(user_id, created_at DESC);

-- Partial index for filtered queries
CREATE INDEX idx_active_users ON users(email) WHERE active = true;
```

## Query Optimization Tips

1. Use EXPLAIN ANALYZE to understand query plans
2. Avoid SELECT \* in production code
3. Limit result sets with pagination
4. Cache frequently accessed data
5. Consider read replicas for heavy read workloads
