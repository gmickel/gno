# Security Checklist

Essential security measures for production applications.

## Input Validation

- [ ] Validate all user input server-side
- [ ] Sanitize HTML to prevent XSS attacks
- [ ] Use parameterized queries to prevent SQL injection
- [ ] Validate file uploads (type, size, content)
- [ ] Implement request size limits

## Authentication

- [ ] Hash passwords with bcrypt (cost factor >= 12)
- [ ] Implement account lockout after failed attempts
- [ ] Use secure session cookies (httpOnly, secure, sameSite)
- [ ] Require strong passwords (length, complexity)
- [ ] Support multi-factor authentication (MFA)

## Authorization

- [ ] Implement principle of least privilege
- [ ] Check permissions on every request
- [ ] Avoid exposing internal IDs in URLs
- [ ] Log access to sensitive resources
- [ ] Implement role-based access control (RBAC)

## Data Protection

- [ ] Encrypt sensitive data at rest
- [ ] Use TLS 1.3 for data in transit
- [ ] Mask sensitive data in logs
- [ ] Implement data retention policies
- [ ] Secure backup storage

## API Security

```typescript
// Rate limiting
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per window
  })
);

// CORS configuration
app.use(
  cors({
    origin: ["https://myapp.com"],
    credentials: true,
  })
);

// Security headers
app.use(helmet());
```

## Secrets Management

- [ ] Never commit secrets to version control
- [ ] Use environment variables or secret managers
- [ ] Rotate credentials regularly
- [ ] Use different secrets per environment
- [ ] Audit secret access

## Monitoring

- [ ] Log authentication events
- [ ] Alert on suspicious activity
- [ ] Monitor for brute force attempts
- [ ] Track API abuse patterns
- [ ] Implement intrusion detection
