# REST API Reference

Complete API documentation for the data processing service.

## Authentication

All API requests require Bearer token authentication:

```bash
curl -H "Authorization: Bearer $TOKEN" https://api.example.com/v1/data
```

### Token Endpoints

| Endpoint        | Method | Description               |
| --------------- | ------ | ------------------------- |
| `/auth/token`   | POST   | Generate new access token |
| `/auth/refresh` | POST   | Refresh expired token     |
| `/auth/revoke`  | DELETE | Revoke active token       |

## Data Endpoints

### GET /v1/data

Retrieve paginated data records.

**Query Parameters:**

- `limit` (int): Max records per page (default: 50, max: 200)
- `offset` (int): Skip N records
- `sort` (string): Field to sort by
- `order` (asc|desc): Sort direction

**Response:**

```json
{
  "data": [...],
  "meta": {
    "total": 1234,
    "limit": 50,
    "offset": 0
  }
}
```

### POST /v1/data

Create new data record.

**Request Body:**

```json
{
  "name": "string",
  "type": "document|image|video",
  "content": "base64 encoded"
}
```

### PUT /v1/data/:id

Update existing record. Requires full object replacement.

### PATCH /v1/data/:id

Partial update. Only specified fields are modified.

### DELETE /v1/data/:id

Soft delete record. Use `?hard=true` for permanent deletion.

## Error Responses

Standard error format:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body",
    "details": [...]
  }
}
```

### Error Codes

| Code               | HTTP Status | Description              |
| ------------------ | ----------- | ------------------------ |
| `AUTH_REQUIRED`    | 401         | Missing or invalid token |
| `FORBIDDEN`        | 403         | Insufficient permissions |
| `NOT_FOUND`        | 404         | Resource does not exist  |
| `VALIDATION_ERROR` | 400         | Invalid request data     |
| `RATE_LIMITED`     | 429         | Too many requests        |

## Rate Limiting

Default limits:

- 100 requests per minute for read operations
- 20 requests per minute for write operations

Rate limit headers included in all responses:

- `X-RateLimit-Limit`: Max requests allowed
- `X-RateLimit-Remaining`: Requests left in window
- `X-RateLimit-Reset`: Unix timestamp when limit resets
