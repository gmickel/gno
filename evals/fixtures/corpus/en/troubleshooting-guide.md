# Troubleshooting Guide

Common issues and their solutions.

## Connection Errors

### Error: ECONNREFUSED

**Symptoms:**

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Causes:**

1. Database server not running
2. Wrong port configuration
3. Firewall blocking connection

**Solutions:**

```bash
# Check if PostgreSQL is running
systemctl status postgresql

# Verify port in .env matches database config
grep DB_PORT .env

# Test connection manually
psql -h localhost -p 5432 -U postgres
```

### Error: Connection timeout

**Symptoms:**
Request hangs, eventually fails with timeout error.

**Causes:**

1. Network latency
2. Overloaded server
3. Connection pool exhausted

**Solutions:**

- Increase connection timeout in config
- Check server load: `top` or `htop`
- Review connection pool settings

## Authentication Issues

### Error: Invalid credentials

**Check:**

1. Verify environment variables are loaded
2. Check secret rotation schedule
3. Confirm user exists in identity provider

### Error: Token expired

JWT tokens have 24h lifetime by default. Implement token refresh:

```typescript
async function refreshIfNeeded(token: string) {
  const decoded = jwt.decode(token);
  const expiresIn = decoded.exp - Date.now() / 1000;

  if (expiresIn < 300) {
    // Less than 5 min
    return await refreshToken(token);
  }
  return token;
}
```

## Performance Issues

### Slow queries

1. Check query execution plan: `EXPLAIN ANALYZE`
2. Add missing indexes
3. Review N+1 query patterns

### Memory leaks

**Symptoms:**

- RSS grows over time
- OOM kills in production

**Diagnosis:**

```bash
# Take heap snapshot
kill -USR2 $PID

# Analyze with Chrome DevTools
node --inspect app.js
```

### High CPU usage

1. Profile with `--prof` flag
2. Check for infinite loops
3. Review expensive regex patterns

## Deployment Issues

### Container won't start

**Check logs:**

```bash
kubectl logs -f deployment/app --previous
```

**Common causes:**

- Missing environment variables
- Failed health checks
- Resource limits too low

### Rolling update stuck

```bash
# Check rollout status
kubectl rollout status deployment/app

# View events
kubectl describe deployment/app
```

## Logging and Debugging

### Enable debug logs

```bash
DEBUG=app:* node server.js
```

### Structured logging query

```sql
SELECT * FROM logs
WHERE level = 'error'
  AND timestamp > NOW() - INTERVAL '1 hour'
ORDER BY timestamp DESC;
```
