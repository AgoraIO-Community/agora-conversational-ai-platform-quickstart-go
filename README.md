# Agora Conversational AI Platform quickstart — React + Go

A standalone web application for managing Agora Conversational AI v3
resources and testing outbound voice agents.

> **v3 preview branch.** The backend uses the low-level `v3` package of the
> Agora Agents Go SDK alpha.4 preview (`github.com/AgoraIO/agora-agents-go/v2/v3`).
> The `v2` branch keeps the original Studio v2 API implementation.

The frontend is React 19 with Vite, TypeScript, Tailwind CSS, and
TanStack Router. The backend is Go 1.21+ with Gin. The two run as separate
development processes and as one server-hosted application in production.

The demo supports:

- Creating, updating, and deleting saved v3 agents.
- Managing secret sets and project-scoped phone numbers.
- Placing one-off outbound test calls (v3 telephony sessions).
- Creating, inspecting, pausing, resuming, and canceling campaigns.
- Polling session state and viewing session history and post-call analysis.
- Local authentication bypass and production-ready Agora SSO sessions.

The Agora Conversational AI v3 API is the application data store. The browser
holds only unsaved UI state; it does not persist agents, secrets, sessions, or
campaigns locally.

## Architecture

```text
Browser
  │
  │ relative /api requests
  ▼
React + Vite + TanStack Router
  │
  │ Vite proxy in development
  ▼
Go + Gin server
  ├─► Agora v3 API (Go SDK)  agents, secrets, numbers, sessions, campaigns
  ├─► Agora console API      project list/create (/dev/v1, plain HTTP)
  └─► Agora SSO              optional production authentication
```

Agora customer credentials and SSO secrets remain on the server. Provider
secrets entered in the UI pass through the authenticated server to v3 secret
sets (write-only) and are not persisted by this app.

## Requirements

- Go 1.21 or newer (the SDK requests the go1.23 toolchain).
- Node.js 20 or newer.
- pnpm 11.
- Make.
- An Agora App ID.
- The App Certificate for that project. The [Agora CLI](https://github.com/AgoraIO/cli)
  fills both into `.env` (after the copy step below):
  `agora project env write .env --template standard --project <name>`.
- Optional: an Agora Customer ID and Customer Secret, which enable the in-app
  project picker (list, create, and switch projects).

## Quick start

From this project directory, create the local environment file:

```bash
cp env.example .env
```

Set the required values:

```dotenv
APP_ENV=development
AUTH_MODE=bypass

AGORA_APP_ID=
AGORA_APP_CERTIFICATE=

# Optional: enables the project picker.
AGORA_CUSTOMER_ID=
AGORA_CUSTOMER_SECRET=
```

Install both server and frontend dependencies:

```bash
make install
```

Start both development processes:

```bash
make dev
```

The launcher prints the selected URLs. It prefers:

- Frontend: `http://localhost:3000`
- Backend: `http://127.0.0.1:8000`

Open the printed frontend URL.

## What the Make targets do

| Target | Behavior |
| --- | --- |
| `make install` | Runs `go mod download` and the locked pnpm install |
| `make dev` | Starts Gin and Vite, configures the API proxy, and manages both processes |
| `make build` | Type-checks and builds the React client into `client/dist` |
| `make test` | Runs all Go tests |
| `make clean` | Removes `client/dist` |

`make install` installs dependencies for both parts of the application:

```text
go mod download
cd client && pnpm install --frozen-lockfile
```

## Development ports

The launcher checks both IPv4 and IPv6. In bypass mode, it selects the next
available port when a preferred port is occupied. Override the preferred
starting ports with:

```bash
make dev FRONTEND_PORT=3001 BACKEND_PORT=8001
```

In SSO mode, the frontend must use the exact port registered in
`AGORA_SSO_REDIRECT_URI`. The launcher fails clearly if that port is occupied
instead of selecting an invalid OAuth callback URL.

## Verify a local run

Check the API using the backend URL printed by the launcher:

```bash
curl http://127.0.0.1:8000/api/health
```

Expected response:

```json
{"status":"ok"}
```

Then use the browser UI to:

1. Select an Agora project, or create one for a customer.
2. Load, create, or duplicate a Studio agent. Duplicate fetches the source
   configuration and opens it as an unsaved create form.
3. Configure provider credentials.
4. Add or select a phone number.
5. Place an outbound test call.
6. Verify call status, transcript, history, and campaign workflows.

## Configuration

The server loads `.env` from the project root. The committed `env.example`
contains the normal application settings; the table below also lists optional
launcher and direct-server overrides.

| Variable | Required | Purpose |
| --- | --- | --- |
| `APP_ENV` | No | `development` or `production`; defaults to `development` |
| `AUTH_MODE` | No | `bypass` or `sso`; defaults according to `APP_ENV` |
| `APP_PUBLIC_URL` | No | Browser-visible origin used for redirects |
| `ALLOW_BYPASS_IN_PRODUCTION` | No | Explicitly permits production bypass when set to `true` |
| `AGORA_APP_ID` | Yes | Initial/fallback Agora project before a server-signed project selection is stored |
| `AGORA_APP_CERTIFICATE` | Yes | App Certificate for `AGORA_APP_ID`; the SDK signs every v3 request with a ConvoAI token generated from it |
| `AGORA_CUSTOMER_ID` | No | Console API Basic-auth username; enables the project picker |
| `AGORA_CUSTOMER_SECRET` | No | Console API Basic-auth password; enables the project picker |
| `AGORA_AGENTS_V3_BASE_URL` | No | v3 API origin, read by the SDK; defaults to `https://preview.ai.agora.io` |
| `AGORA_STUDIO_API_BASE` | No | Console projects API origin; defaults to `https://api.agora.io` |
| `AGORA_STUDIO_DEBUG` | No | Enables additional console API request logging |
| `SESSION_JWT_SECRET` | SSO only | Signs the local session cookie; minimum 32 characters |
| `AGORA_SSO_CLIENT_ID` | SSO only | Agora OAuth client identifier |
| `AGORA_SSO_CLIENT_SECRET` | SSO only | Agora OAuth client secret |
| `AGORA_SSO_REDIRECT_URI` | SSO only | Registered OAuth callback URL |
| `AGORA_SSO_BASE_URL` | No | Agora SSO origin |
| `AGORA_SSO_OPEN_API_BASE` | No | Agora customer-profile API base |
| `FRONTEND_PORT` | No | Preferred Vite development port |
| `BACKEND_PORT` | No | Preferred Gin development port |
| `PORT` | No | Gin port when running the server directly |

Do not add secrets to Vite environment variables or expose them through the
client bundle.

## Authentication

### Local bypass

Local development defaults to:

```dotenv
APP_ENV=development
AUTH_MODE=bypass
```

Every request resolves to the synthetic `dev@local` identity. A session secret
is not required.

### Agora SSO

Configure:

```dotenv
AUTH_MODE=sso
SESSION_JWT_SECRET=use-a-random-value-at-least-32-characters
AGORA_SSO_CLIENT_ID=
AGORA_SSO_CLIENT_SECRET=
AGORA_SSO_REDIRECT_URI=http://localhost:3000/api/auth/agora/callback
```

After the OAuth exchange, the server creates an HS256 session JWT in an
HTTP-only, SameSite=Lax cookie. Production cookies are secure.

Production defaults to SSO. `AUTH_MODE=bypass` is ignored in production unless
`ALLOW_BYPASS_IN_PRODUCTION=true` is explicitly configured.

## SDK version

The Go SDK's v3 preview is installed from its `v3-api-preview` branch until
the `v2.14.0-alpha.4` tag is published (the module path stays `/v2`, so Go
previews use `v2.14.0-*` rather than `v3.0.0-*`). `go.mod` pins the branch's
current alpha.4 commit (`2d48a39`) as a pseudo-version:

```text
github.com/AgoraIO/agora-agents-go/v2 v2.13.1-0.20261106151340-2d48a391639b
```

To pick up later preview commits from the branch:

```bash
go get github.com/AgoraIO/agora-agents-go/v2@v3-api-preview && go mod tidy
```

Go rejects branch names containing `/`, so use `v3-api-preview`, not
`feat/v3-api-preview`. If the Go module proxy still returns an older commit
right after the branch moves, run the command with `GOPROXY=direct`. Once the
tag exists, switch with `go get github.com/AgoraIO/agora-agents-go/v2@v2.14.0-alpha.4`.

Post-call transcript summaries were removed in v3. Use agent `variables` with
`extract: true`; results appear in the session `analysis` field.

## Request flows

### v3 resource operations

1. The React client calls `/api/v3/{resource}[/{id}[/{action}]]`.
2. Gin verifies the local session or development bypass.
3. A small route table in `server/v3.go` maps the request to one SDK call on
   `agentkit.NewAgoraClient(...).V3` for the selected project. The SDK signs
   each request with a ConvoAI token generated from the App ID and App
   Certificate (see `server/credentials.go`).
4. PATCH on agents, numbers, and campaigns, and DELETE on secrets, first GET the
   resource to read its ETag and then write with `If-Match` (last write wins).
5. The SDK's parsed body is returned as JSON. Upstream errors return the
   upstream status with `{error, reason, requestId, details}`.
   Errors are mapped by the SDK's error category. Malformed input (unknown
   body fields, non-integer query values) and SDK validation errors are a 400
   without calling Agora; an unreachable API is a 502, an API timeout a 504, a
   2xx response that violates the API contract a 502, missing configuration a
   500 with its message, and unexpected failures a generic 500 that is logged
   server-side.

Resources: `agents`, `secrets` (id = set name), `numbers`, `campaigns`
(actions `pause`, `resume`, `cancel`), and `sessions` (read-only plus
`stop`). List queries pass through `limit`, `cursor`, `order`, plus `status`,
`channel`, `started_after`, `started_before` for sessions and `status` for
campaigns.

### Outbound test call

1. The browser posts `to` (E.164), `agentId`, and `phoneNumberId` (v3 number
   UUID) to `/api/call`.
2. The server starts a v3 session from the saved agent with telephony
   transport (`from` = number ID, `to`), a 120 s idle timeout, and a 300 s
   maximum duration.
3. The response is `{ok, agentSessionId, status}`; the browser polls
   `/api/v3/sessions/{agentSessionId}`.

## Server routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness check |
| `GET` | `/api/session/me` | Current authentication state and identity |
| `GET` | `/api/auth/agora/start` | Begin SSO or redirect in bypass mode |
| `GET` | `/api/auth/agora/callback` | Complete Agora OAuth |
| `GET`, `POST` | `/api/auth/agora/logout` | Clear the local session |
| `GET`, `POST`, `PUT` | `/api/projects` | List, create, or select an Agora project |
| `GET`, `POST`, `PATCH`, `DELETE` | `/api/v3/{resource}[/{id}]` | Authenticated v3 resource operations through the SDK |
| `POST` | `/api/v3/campaigns/{id}/{pause\|resume\|cancel}` | Campaign actions |
| `POST` | `/api/v3/sessions/{id}/stop` | Stop a session |
| `POST` | `/api/call` | Place a one-off outbound test call (v3 session) |

Unknown API mutations return JSON `404` responses. Unknown API GET requests
return JSON `405` responses. They are never handled by the SPA fallback.

## Project map

```text
.
├── client/
│   ├── src/App.tsx                         page state and top-level workflow
│   ├── src/router.tsx                      TanStack Router route tree
│   ├── src/components/agent-studio-panel.tsx
│   ├── src/components/studio-call-panel.tsx
│   ├── src/components/studio-call-history.tsx
│   ├── src/components/v3-api.ts               /api/v3 fetch + pagination helpers
│   └── vite.config.ts                      /api development proxy
├── scripts/dev.go                          dual-process development launcher
├── server/
│   ├── main.go                             routes, handlers, SPA serving
│   ├── config.go                           environment configuration
│   ├── auth.go                             JWT and cookie sessions
│   ├── sso.go                              OAuth and customer profile lookup
│   ├── v3.go                               v3 SDK route table, /api/call, error mapping
│   ├── studio.go                           console projects HTTP client (/dev/v1)
│   ├── main_test.go                        route and HTTP-boundary tests
│   └── v3_test.go                          v3 routes against a stubbed SDK transport
├── env.example
├── go.mod
└── Makefile
```

## Guidance for contributors and coding agents

- Keep the frontend-to-server API contract stable. The UI uses relative
  `/api` URLs in development and production.
- Keep Agora customer credentials, SSO secrets, and the session
  signing secret on the server. Treat submitted provider secrets as sensitive
  pass-through data.
- Add new Studio proxy resources to the explicit allowlist; do not create an
  unrestricted forward proxy.
- Preserve upstream status codes and JSON bodies where the server is acting as
  a Studio proxy.
- Validate outbound call input before loading an agent or creating a call.
- Keep `agentSessionId` nullable and default missing call status to `STARTING`.
- Register API routes before the SPA fallback. Unknown `/api/*` paths must
  return JSON, not `index.html`.
- Use bounded `http.Client` timeouts for every external request.
- Mock external HTTP clients in tests. Do not require live Agora
  credentials for the unit suite.
- When changing shared UI behavior, update route tests and run both Go and
  frontend validation.

## Tests and validation

Run the server tests:

```bash
make test
```

Run the full local validation:

```bash
go test ./...
go vet ./...
cd client
pnpm typecheck
pnpm build
```

The tests mock external HTTP boundaries and verify routing, method handling,
App ID + App Certificate token authorization, project-certificate resolution,
v3 route mapping, ETag reads before writes, request
validation, and upstream failure details. They do not place a live phone call or perform a live SSO
exchange.

## Production build

Build the React client:

```bash
make build
```

Build the Go server:

```bash
mkdir -p bin
go build -o bin/agora-conversational-ai-platform-quickstart-go ./server
```

Run it with production configuration:

```bash
APP_ENV=production \
APP_PUBLIC_URL=https://your-app.example \
PORT=8000 \
./bin/agora-conversational-ai-platform-quickstart-go
```

When `client/dist` exists, Gin serves the built frontend and preserves deep
links such as `/studio/agent/{agentId}`.

## Troubleshooting

### Port already in use

In bypass mode, the launcher automatically selects the next available port.
Inspect a port manually with:

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

### Missing frontend dependencies

Run:

```bash
make install
```

### Studio API returns `401` or `403`

Verify `AGORA_APP_ID` and `AGORA_APP_CERTIFICATE` (v3 API), and
`AGORA_CUSTOMER_ID` / `AGORA_CUSTOMER_SECRET` (project picker). These
are server-side values and are different from provider API credentials stored
in v3 secret sets.

### SSO callback fails

Verify that the browser origin and port exactly match
`AGORA_SSO_REDIRECT_URI`, and confirm that `SESSION_JWT_SECRET` is at least 32
characters.

## Security checklist

- Keep `.env` local; commit only `env.example`.
- Use SSO in production.
- Use a random session secret of at least 32 characters.
- Keep customer credentials, and SSO secrets server-side.
- Never log provider secrets submitted through the secret workflow.
- Serve production traffic over HTTPS.
- Review the v3 route table in `server/v3.go` before exposing additional endpoints.
