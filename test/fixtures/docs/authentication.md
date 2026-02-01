# User Authentication Guide

Authentication is the process of verifying user identity before granting access to protected resources.

## JWT Token Flow

JSON Web Tokens provide a stateless authentication mechanism:

```typescript
import jwt from "jsonwebtoken";

interface TokenPayload {
  userId: string;
  email: string;
  role: "admin" | "user";
}

function generateToken(payload: TokenPayload): string {
  return jwt.sign(payload, process.env.JWT_SECRET!, {
    expiresIn: "24h",
  });
}

function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, process.env.JWT_SECRET!) as TokenPayload;
}
```

## Session-Based Auth

For server-rendered applications, session cookies offer better security:

```typescript
import { createSession, destroySession } from "./session";

async function login(email: string, password: string) {
  const user = await validateCredentials(email, password);
  if (!user) {
    throw new AuthError("Invalid credentials");
  }
  return createSession(user.id);
}

async function logout(sessionId: string) {
  await destroySession(sessionId);
}
```

## OAuth 2.0 Integration

Third-party authentication via OAuth providers:

1. Redirect user to provider's authorization URL
2. Receive authorization code callback
3. Exchange code for access token
4. Fetch user profile from provider

## Security Best Practices

- Always hash passwords with bcrypt or argon2
- Use HTTPS for all authentication endpoints
- Implement rate limiting on login attempts
- Store tokens securely (httpOnly cookies)
- Rotate refresh tokens on each use
