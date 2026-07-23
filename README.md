# Acme Checkout

TypeScript checkout service for Acme's online store: payment capture, inventory
reservation, Stripe webhooks, and rate limiting.

Incident notifications are handled through **PagerDuty**. When an incident is
triggered, PagerDuty posts to this service; the service can forward that event
to a bridge-room assistant for live collaboration.

## Setup

```bash
cp .env.sample .env
npm install
npm test
npm run smoke
npm run dev
```

### PagerDuty

1. Create a service integration and copy the Events API v2 routing key into
   `PAGERDUTY_ROUTING_KEY`.
2. Create a webhook subscription aimed at
   `https://<your-public-host>/webhooks/pagerduty` for `incident.triggered`.
3. Put the webhook secret in `PAGERDUTY_WEBHOOK_SECRET`.
4. Optionally set `INCIDENT_COPILOT_URL` so triggered incidents are forwarded to
   your standing bridge assistant. Set `BRIDGE_MEETING_URL` to that room.

Trigger an alert (opens / updates a PagerDuty incident):

```bash
npm run report-incident -- \
  --title "Checkout latency elevated" \
  --severity sev2 \
  --summary "p95 capture latency above SLO for 10m"
```

Or:

```bash
curl -sS -X POST http://localhost:4100/internal/pagerduty/trigger \
  -H "content-type: application/json" \
  -H "authorization: Bearer $INCIDENT_REPORT_TOKEN" \
  -d '{
    "title": "Checkout latency elevated",
    "severity": "sev2",
    "summary": "p95 capture latency above SLO for 10m"
  }'
```

Simulate the inbound PagerDuty webhook locally:

```bash
curl -sS -X POST http://localhost:4100/webhooks/pagerduty \
  -H "content-type: application/json" \
  -d @fixtures/pagerduty_incident_triggered.json
```

### Bridge assistant

Point the assistant's indexed checkout at this repository (or its `src/` tree)
and use the same `BRIDGE_MEETING_URL` as above. Calendar-based bot scheduling is
not used here; a standing bridge room is assumed. Calendar V2 remains the next
step if on-call calendar events should schedule bots automatically later.

## HTTP surface

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | Liveness |
| POST | `/v1/checkout/capture` | Capture a payment |
| POST | `/v1/inventory/reserve` | Reserve stock |
| POST | `/v1/webhooks/stripe` | Stripe events |
| GET | `/v1/rate-limit/check` | Rate-limit probe |
| POST | `/webhooks/pagerduty` | PagerDuty V3 webhooks |
| POST | `/internal/pagerduty/trigger` | Events API v2 trigger |
