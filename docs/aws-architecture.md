# Slack AGI — AWS Production Architecture
## Serverless, Event-Driven, Agent-Native @ Scale

> **Target:** 30M+ users, 10k+ msg/s peak, sub-100ms API latency, multi-agent AI collaboration.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CLIENTS (Web / Mobile)                        │
└───────────────────────┬─────────────────────────┬───────────────────┘
                        │ HTTP REST                │ WebSocket
                ┌───────▼──────────┐    ┌──────────▼──────────┐
                │ API Gateway HTTP │    │ API Gateway WS API  │
                │  (REST endpoints)│    │  (real-time msgs)   │
                └───────┬──────────┘    └──────────┬──────────┘
                        │                          │
          ┌─────────────▼──────────────────────────▼────────────────┐
          │                   AWS LAMBDA LAYER                       │
          │  fn-messages  fn-channels  fn-users  fn-ws-connect       │
          │  fn-missions  fn-artifacts fn-agents fn-ws-disconnect     │
          └──────┬────────────────┬────────────────┬─────────────────┘
                 │                │                 │
    ┌────────────▼──┐   ┌─────────▼──────┐  ┌──────▼──────────────┐
    │  Aurora        │   │  DynamoDB      │  │  ElastiCache Redis  │
    │  Serverless v2 │   │  (Messages)    │  │  (WS connections,   │
    │  (Users,       │   │  (Hot data,    │  │   presence,         │
    │   Channels,    │   │   last 30 days)│  │   rate limiting)    │
    │   Missions,    │   └────────────────┘  └─────────────────────┘
    │   Artifacts)   │
    └────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │     EventBridge        │
                    │   (Event Bus)          │
                    │                        │
                    │ message.sent           │
                    │ artifact.created       │
                    │ mission.updated        │
                    │ agent.triggered        │
                    └───────────┬────────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                      │
  ┌───────▼────────┐   ┌────────▼────────┐   ┌────────▼────────┐
  │  SQS FIFO      │   │  SQS Standard   │   │  SQS DLQ        │
  │  (Team sessions│   │  (Agent tasks,  │   │  (Failed msgs,  │
  │   ordered)     │   │   async work)   │   │   retry logic)  │
  └───────┬────────┘   └────────┬────────┘   └─────────────────┘
          │                     │
  ┌───────▼────────┐   ┌────────▼────────────────────────────────┐
  │  ECS Fargate   │   │       Amazon Bedrock AgentCore           │
  │  (Long-running │   │                                          │
  │   team sessions│   │  ┌──────────────┐  ┌──────────────────┐ │
  │   5-15 min)    │   │  │   Runtime    │  │    Memory        │ │
  └────────────────┘   │  │  (Managed    │  │  (Persistent     │ │
                        │  │   execution) │  │   agent state)   │ │
                        │  └──────────────┘  └──────────────────┘ │
                        │  ┌──────────────┐  ┌──────────────────┐ │
                        │  │  Identity    │  │  Observability   │ │
                        │  │  (IAM/Roles  │  │  (Traces, logs,  │ │
                        │  │   per agent) │  │   metrics)       │ │
                        │  └──────────────┘  └──────────────────┘ │
                        └─────────────────────────────────────────┘
                                        │
                         ┌──────────────▼────────────────┐
                         │    Amazon Bedrock Models        │
                         │  Claude 3.5 Sonnet (reasoning) │
                         │  Claude 3 Haiku (fast tasks)   │
                         │  Amazon Nova Pro (cost opt.)   │
                         └───────────────────────────────┘
```

---

## Component Detail

### 1. API Gateway

#### HTTP API (REST endpoints)
- **Why HTTP API vs REST API:** 70% cheaper, ~60% lower latency, enough for JSON APIs
- Routes map 1:1 to Lambda functions (no monolith)
- Custom authorizer Lambda for JWT validation (Cognito tokens)
- Rate limiting per user: 1000 req/min via usage plans
- Request/response payload compression

#### WebSocket API (real-time)
- `$connect` → `fn-ws-connect` (validate token, store connectionId in Redis)
- `$disconnect` → `fn-ws-disconnect` (clean up Redis entry)
- `message` route → `fn-ws-message` (broadcast to channel subscribers)
- `$default` → `fn-ws-default`

**WebSocket connection registry (Redis):**
```
ws:channel:{channelId} → SET of connectionIds
ws:conn:{connectionId} → { userId, channels[] }
```

Fan-out: when message saved → look up `ws:channel:{channelId}` → call `ApiGatewayManagementApi.postToConnection()` for each.

---

### 2. Lambda Functions

All functions: Node.js 22.x, ARM64 (Graviton2 = 20% cheaper), 256MB–512MB RAM.

| Function | Trigger | Timeout | Description |
|----------|---------|---------|-------------|
| `fn-messages-post` | API GW | 10s | Save message, fan-out WS, emit EventBridge event |
| `fn-messages-list` | API GW | 5s | Paginated message list with cursor |
| `fn-channels` | API GW | 5s | CRUD channels |
| `fn-users` | API GW | 5s | CRUD users, profiles |
| `fn-dm` | API GW | 5s | Open/get DM channel |
| `fn-missions` | API GW | 10s | Mission CRUD, team assignment |
| `fn-artifacts` | API GW | 10s | Create/get/approve artifacts |
| `fn-inbox` | API GW | 5s | Personal inbox items |
| `fn-ws-connect` | WS | 5s | Register WS connection in Redis |
| `fn-ws-disconnect` | WS | 5s | Clean up WS connection |
| `fn-ws-broadcast` | EventBridge | 30s | Fan-out messages to all channel subscribers |
| `fn-agent-passive` | EventBridge | 30s | Decide if passive agent should respond |
| `fn-agent-mention` | EventBridge | 60s | Handle @agent mentions |
| `fn-async-task` | SQS | 300s | Execute long async agent tasks |
| `fn-session-gc` | EventBridge (cron) | 60s | Archive stale sessions |
| `fn-memory-extract` | EventBridge | 60s | Extract agent memories post-session |

**Cold start mitigation:**
- Provisioned Concurrency for hot functions (fn-messages-post, fn-ws-connect)
- Lambda SnapStart for Node.js functions
- Keep function bundles small via esbuild treeshaking

---

### 3. Database Architecture

#### Aurora Serverless v2 (relational / entities)
- **What goes here:** Users, Channels, Missions, Artifacts, InboxItems, AgentMemory
- **Why Aurora Serverless v2:** Auto-scales 0.5→128 ACUs, no idle cost, PostgreSQL compatible
- Prisma ORM (same as current — zero migration effort)
- Read replicas via Aurora reader endpoint for dashboard queries
- Connection pooling via RDS Proxy (Lambda needs this — max 100 concurrent connections per Lambda)

**RDS Proxy is critical:** Without it, each Lambda invocation opens a new DB connection → connection exhaustion at scale. Proxy pools connections.

#### DynamoDB (messages — hot data)
Messages are append-only, high-volume, and mostly read sequentially. Perfect for DynamoDB.

**Table design:**
```
Table: Messages
PK: channelId (partition by channel)
SK: createdAt#messageId (sort by time, unique)

GSI-1: userId-createdAt (user's message history)
GSI-2: isAI-createdAt (AI vs human analytics)

TTL: 90 days (auto-delete old messages, save cost)
```

**Read pattern:** `query(channelId, SK > cursor, limit=50, ScanIndexForward=false)` — O(1) reads.

**Migration strategy:** New messages → DynamoDB. Old messages stay in Aurora. Lambda reads from both, merging by timestamp.

#### ElastiCache Redis (Serverless)
- WebSocket connection registry (see above)
- Rate limiting: `INCR user:{userId}:rateLimit:minute` with TTL 60s
- Presence: `ZADD presence {timestamp} {userId}` — users active in last 5 min
- Session cache: team session state (avoids re-reading DB mid-session)

---

### 4. Event-Driven Architecture (EventBridge)

All significant actions emit events to EventBridge. Consumers are Lambda functions or SQS queues.

**Event schema:**
```json
{
  "source": "slack-agi.messages",
  "detail-type": "MessageSent",
  "detail": {
    "messageId": "...",
    "channelId": "...",
    "userId": "...",
    "content": "...",
    "isAI": false,
    "timestamp": "2026-03-08T01:00:00Z"
  }
}
```

**Event catalog:**

| Event | Source | Consumers |
|-------|--------|-----------|
| `MessageSent` | fn-messages-post | fn-ws-broadcast, fn-agent-passive |
| `ArtifactCreated` | fn-artifacts | fn-inbox, fn-memory-extract |
| `ArtifactApproved` | fn-artifacts | fn-ws-broadcast, fn-memory-extract |
| `MissionCreated` | fn-missions | fn-agent-mention (AGI assigns team) |
| `TeamSessionStarted` | fn-agent-mention | fn-ws-broadcast |
| `AsyncTaskCreated` | fn-async-task | SQS Standard |
| `AgentMemoryUpdated` | fn-memory-extract | fn-ws-broadcast |

**EventBridge rules:**
- Pattern matching on `detail-type` → route to correct Lambda/SQS
- Dead-letter queue for failed event deliveries
- Retry policy: 3 attempts with exponential backoff

---

### 5. Agent Architecture with AgentCore

**Amazon Bedrock AgentCore** provides managed infrastructure for AI agents:

#### AgentCore Runtime
- Managed execution environment per agent (Aria, Cody, Sage, Rex, AGI)
- Each agent = an AgentCore "agent" with its own runtime configuration
- Handles parallel execution, timeouts, error recovery
- No need to manage ECS tasks for individual agents (only for team sessions)

#### AgentCore Memory
- Replaces our current `AgentMemory` Prisma model
- Persistent memory per agent, queryable via semantic search
- Agents automatically recall relevant past decisions
- TTL-based memory expiry (configurable)
- **Integration:** `BedrockAgentCoreMemoryClient.remember()` / `.recall(query)`

#### AgentCore Identity
- Each agent gets an IAM role via AWS Cognito
- Scoped permissions: Sage can call Brave Search + S3, Cody can access GitHub API
- Human-in-the-loop: agents can request elevated permissions temporarily
- Audit trail of every agent action

#### AgentCore Observability
- Full trace of every agent decision (what prompt, what model, what output)
- Token usage per agent per session
- Latency breakdown (queue → model → response)
- Anomaly detection: alerts if agent starts behaving unexpectedly

#### Multi-Agent Orchestration (Team Sessions)
```
User: "hagamos un team session sobre la arquitectura"
          │
          ▼
    fn-agent-mention
    (detects team trigger)
          │
          ▼
    AgentCore Runtime
    ┌─────────────────────────────────────────┐
    │  AGI Orchestrator (supervisor agent)    │
    │    ├── Aria Agent (Product focus)       │
    │    ├── Cody Agent (Engineering focus)   │
    │    ├── Sage Agent (Research focus)      │
    │    └── Rex Agent (Devil's advocate)     │
    │                                          │
    │  AgentCore handles:                      │
    │  - Agent lifecycle (start/stop)          │
    │  - Message passing between agents        │
    │  - Memory injection per agent            │
    │  - Token budget enforcement              │
    └─────────────────────────────────────────┘
          │
          ▼ (real-time streaming)
    EventBridge → fn-ws-broadcast → WebSocket → Client
```

**Why ECS Fargate for team sessions (not just Lambda)?**
Team sessions run 5-15 minutes with many sequential LLM calls. Lambda max timeout = 15 min, but cold starts + memory constraints make ECS better for long-running orchestrators. AgentCore Runtime handles this automatically if configured for long-running tasks.

---

### 6. S3 Storage

**Buckets:**
```
slack-agi-static         → Frontend assets (index.html, JS, CSS)
slack-agi-artifacts      → Generated artifact files (PDF, MD, JSON)
slack-agi-media          → User uploaded images, files
slack-agi-exports        → Channel exports, audit logs
slack-agi-models         → Fine-tuned model artifacts (future)
```

**Lifecycle policies:**
- `artifacts/`: 1 year standard, then Glacier Instant Retrieval
- `media/`: 90 days standard, then Glacier
- `exports/`: 7 years (compliance), Glacier Deep Archive

**CloudFront distribution:**
- `slack-agi-static` → global CDN (< 50ms TTFB worldwide)
- Signed URLs for private artifact downloads
- Origin Access Control (OAC) — S3 not publicly accessible

---

### 7. Cognito (Auth)

- User pools: email/password + Google/GitHub OAuth
- Bot/agent users: Machine-to-machine (M2M) with client credentials
- JWT tokens: validated by API GW custom authorizer Lambda
- Groups: admin, user, agent, guest
- Fine-grained access: Cognito Identity Pool + IAM roles per group

---

### 8. Observability Stack

```
Lambda / ECS → X-Ray → Service Map (visualize latency across services)
Lambda / ECS → CloudWatch Logs → Log Insights (query logs)
EventBridge → CloudWatch Metrics → Dashboard
AgentCore → AgentCore Observability → Agent traces
```

**Custom metrics (CloudWatch):**
- `MessagesPerSecond` (alarm if > 15k/s)
- `AgentResponseLatency` p50/p95/p99
- `WebSocketConnections` active count
- `QueueDepth` SQS agent task queue
- `DBConnections` via RDS Proxy

**Alarms:**
- API Gateway 5xx > 1% → PagerDuty
- SQS DLQ messages > 0 → Slack notification (ironic but effective)
- Aurora CPU > 80% → auto-scale notification
- Agent response latency p99 > 5s → engineering alert

---

### 9. Cost Model (30M users, 10k msg/s peak)

| Service | Monthly estimate | Notes |
|---------|-----------------|-------|
| API Gateway HTTP | ~$3,500 | $1/M requests, ~3.5B req/mo |
| Lambda (compute) | ~$2,000 | ARM64, avg 200ms, 1B invocations |
| Aurora Serverless v2 | ~$800 | 4 ACU avg, scales to 32 ACU peak |
| DynamoDB | ~$1,200 | On-demand, ~50B messages/year |
| ElastiCache Serverless | ~$400 | ~100GB data, Redis Serverless |
| WebSocket API | ~$600 | $3.50/M connection-minutes |
| ECS Fargate (team sessions) | ~$300 | 1 vCPU/2GB per session, short-lived |
| Bedrock Claude 3.5 Sonnet | ~$8,000 | ~1M agent calls/mo, 2k tokens avg |
| AgentCore Runtime | ~$500 | Per-agent managed execution |
| S3 + CloudFront | ~$400 | 10TB artifacts, global CDN |
| Other (Cognito, X-Ray, etc.) | ~$500 | |
| **TOTAL** | **~$18,200/mo** | **$0.00061 per user** |

*Comparison: Slack charges $7.25/user/mo (Standard). At 30M users that's $217M/mo. This architecture: $18k/mo.*

---

### 10. Migration Path from Railway

```
Phase 1 (Week 1-2): Infrastructure
  - Set up VPC, subnets, security groups
  - Deploy Aurora Serverless v2, migrate Prisma schema
  - Set up DynamoDB Messages table
  - ElastiCache Redis Serverless
  - Cognito user pool + import existing users

Phase 2 (Week 3-4): Lambda migration
  - Extract server.js endpoints into individual Lambda functions
  - API Gateway routes mapping
  - RDS Proxy setup
  - WebSocket API setup

Phase 3 (Week 5-6): Event-driven
  - EventBridge event bus
  - SQS queues (FIFO + Standard)
  - Wire events: message.sent → agent triggers
  - Replace Socket.io fan-out with Lambda+WS API

Phase 4 (Week 7-8): AgentCore
  - Register agents in AgentCore Runtime
  - Migrate AgentMemory to AgentCore Memory
  - Team sessions → ECS Fargate tasks via AgentCore
  - Observability dashboards

Phase 5 (Week 9-10): Scale testing
  - Load test: 100k concurrent users
  - Tune: DynamoDB capacity, Lambda concurrency limits
  - Chaos engineering: kill random Lambdas, test circuit breakers
  - Cut over: DNS from Railway → CloudFront

Phase 6 (ongoing): Optimize
  - Fine-tune Lambda memory sizes (use AWS Lambda Power Tuning tool)
  - Add Aurora read replicas for dashboard queries
  - Implement caching layer for hot data
  - Consider Bedrock model fine-tuning on your message corpus
```

---

## Key Architecture Decisions

### Why not monolith Lambda (current Railway approach)?
Current: 1 Express server handles everything. Problems at scale:
- No horizontal scaling per function (whole server scales together)
- Memory/CPU contention between agent tasks and API requests
- Deployment = full server restart (downtime risk)
- Cold start affects everything if server restarts

### Why DynamoDB for messages + Aurora for entities?
- Messages: write-heavy, append-only, time-series, no joins → DynamoDB perfect
- Users/Channels/Missions: relational, complex queries, joins → Aurora perfect
- Hybrid is standard at Slack, Discord, Notion scale

### Why EventBridge over direct Lambda invocation?
- Decoupling: fn-messages-post doesn't need to know who consumes events
- Replay: can re-process historical events if a new consumer is added
- Filtering: consumers only receive events they care about
- At-least-once delivery with DLQ fallback

### Why AgentCore over DIY agent infrastructure?
- Memory: persistent semantic memory without managing a vector DB
- Identity: IAM scopes per agent (security by default)
- Observability: every LLM call traced without extra instrumentation
- Multi-agent: built-in agent-to-agent communication protocol
- Runtime: managed execution — no worrying about Lambda timeouts for complex agents

---

*Architecture designed for the question: "When will AI labs ditch Slack?" — Answer: when something like this runs at AWS scale.*
