# OpenClaw + Slack Integration

This folder gives you both options:

- Dynamic discovery (recommended)
- Static schema export

## Config

Set env vars:

```bash
export CONNECT_API_BASE=http://127.0.0.1:3030
export CONNECT_API_TOKEN=your_token
```

The local HTTP API now requires `CONNECT_API_TOKEN` by default. For explicit local-only development, you can opt out with `CONNECT_API_ALLOW_UNAUTHENTICATED_LOCALHOST=true`.

## Dynamic Discovery

Use `openclaw-connect-tools.js` in your OpenClaw tool registration:

```js
const { registerConnectAbilityTools } = require('./openclaw-integration/openclaw-connect-tools');
await registerConnectAbilityTools(toolRegistry, {
  baseUrl: process.env.CONNECT_API_BASE,
  token: process.env.CONNECT_API_TOKEN
});
```

This discovers tools from:
- `GET /api/schema`
- `GET /api/functions`

and registers handlers that invoke:
- `POST /api/call`

## Static Export

Generate static schema files:

```bash
npm run openclaw:export-schema
```

Output:
- `openclaw-integration/generated/connect_schema.json`
- `openclaw-integration/generated/connect_functions.json`

## Slack `/claw` Handler

Use `slack-claw-handler.example.js` as template.

It includes:
- Slack signature verification
- quick ack response
- OpenClaw planning hook
- final Connect API call execution

Required env:

```bash
export SLACK_SIGNING_SECRET=...
export OPENCLAW_BASE_URL=http://127.0.0.1:9000
export OPENCLAW_API_TOKEN=...
export SLACK_HANDLER_PORT=8787
```

Run:

```bash
node openclaw-integration/slack-claw-handler.example.js
```
