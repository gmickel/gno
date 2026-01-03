# Architecture Decision Records

## ADR-001: Event Sourcing for Audit Trail

**Status:** Accepted

**Context:**
We need complete audit history for compliance. Traditional UPDATE queries lose previous state.

**Decision:**
Adopt event sourcing pattern. All state changes stored as immutable events.

**Consequences:**

- Full audit trail with time-travel queries
- Increased storage requirements
- More complex query patterns for current state
- Event replay enables debugging production issues

## ADR-002: Microservices Communication

**Status:** Accepted

**Context:**
Services need reliable async communication. Synchronous HTTP creates coupling and cascade failures.

**Decision:**
Use message queue (RabbitMQ) for async communication. HTTP only for sync queries.

**Consequences:**

- Better fault isolation
- Natural retry/dead-letter handling
- Eventual consistency trade-off
- Ops complexity: need queue monitoring

## ADR-003: Database Per Service

**Status:** Accepted

**Context:**
Shared database creates tight coupling. Schema changes require coordinated deployments.

**Decision:**
Each microservice owns its database. Cross-service data via events or API calls.

**Consequences:**

- Independent deployments
- No shared transaction guarantees
- Need saga pattern for distributed transactions
- Data duplication acceptable for query performance

## ADR-004: Container Orchestration

**Status:** Accepted

**Context:**
Need automated scaling, rolling deploys, and self-healing infrastructure.

**Decision:**
Kubernetes for container orchestration. Helm charts for deployment config.

**Consequences:**

- Auto-scaling based on metrics
- Rolling deployments with rollback
- Steep learning curve for team
- Requires dedicated platform engineering

## ADR-005: API Gateway Pattern

**Status:** Accepted

**Context:**
Clients shouldn't know internal service topology. Need centralized auth, rate limiting, logging.

**Decision:**
Kong API Gateway as single entry point.

**Consequences:**

- Unified authentication layer
- Centralized rate limiting and logging
- Single point of failure (mitigated by HA setup)
- Additional latency per request (~5ms)
