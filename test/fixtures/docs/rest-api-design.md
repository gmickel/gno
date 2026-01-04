# REST API Design Guidelines

Best practices for designing clean, intuitive HTTP APIs.

## Resource Naming

Use nouns for resources, verbs for actions:

```
GET    /users           # List all users
GET    /users/123       # Get specific user
POST   /users           # Create new user
PUT    /users/123       # Update user (full replace)
PATCH  /users/123       # Partial update
DELETE /users/123       # Remove user
```

## Request/Response Format

Always use **JSON** with consistent structures:

```typescript
// Success response
{
  "data": {
    "id": "123",
    "email": "user@example.com",
    "createdAt": "2024-01-15T10:30:00Z"
  }
}

// Error response
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Email is required",
    "field": "email"
  }
}

// Collection response with pagination
{
  "data": [...],
  "meta": {
    "total": 150,
    "page": 1,
    "perPage": 20,
    "hasMore": true
  }
}
```

## HTTP Status Codes

Use appropriate status codes:

| Code | Meaning           | When to Use                          |
| ---- | ----------------- | ------------------------------------ |
| 200  | OK                | Successful GET, PUT, PATCH           |
| 201  | Created           | Successful POST                      |
| 204  | No Content        | Successful DELETE                    |
| 400  | Bad Request       | Validation errors                    |
| 401  | Unauthorized      | Missing or invalid auth              |
| 403  | Forbidden         | Valid auth, insufficient permissions |
| 404  | Not Found         | Resource doesn't exist               |
| 429  | Too Many Requests | Rate limit exceeded                  |
| 500  | Internal Error    | Server-side failures                 |

## Versioning

Include version in URL or header:

```
# URL versioning (recommended)
GET /v1/users
GET /v2/users

# Header versioning
GET /users
Accept: application/vnd.myapi.v1+json
```

## Filtering and Sorting

Support query parameters for flexibility:

```
GET /users?status=active&role=admin
GET /users?sort=createdAt:desc
GET /users?fields=id,email,name
GET /users?page=2&limit=50
```

## Rate Limiting Headers

Include rate limit info in responses:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1705320600
```
