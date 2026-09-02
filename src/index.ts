import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import { type AppConfig, load_config } from "./config/env.js";
import { report_incident } from "./incident/report.js";
import { seed_catalog, reserve_stock, get_available } from "./inventory/reserve_stock.js";
import { map_sev_to_pd, trigger_pagerduty_alert } from "./pagerduty/events.js";
import {
    bridge_incident_from_pagerduty,
    parse_pagerduty_webhook,
    should_handle_pagerduty_event,
    verify_pagerduty_signature,
} from "./pagerduty/webhook.js";
import {
    capture_payment,
    reset_capture_state,
    type PaymentProcessor,
} from "./payments/capture_payment.js";
import { check_rate_limit, MemoryRateLimitStore } from "./rate_limit.js";
import { handle_stripe_webhook } from "./webhooks/stripe_handler.js";

const TriggerSchema = z.object({
    title: z.string().min(3),
    severity: z.enum(["sev1", "sev2", "sev3", "sev4"]).default("sev2"),
    summary: z.string().min(3),
    source: z.string().min(1).default("acme-checkout"),
    dedup_key: z.string().min(1).optional(),
});

const fake_processor: PaymentProcessor = {
    async charge({ order_id, amount_cents }) {
        return { charge_id: `ch_${order_id}_${amount_cents}_${Date.now()}` };
    },
};

const rate_store = new MemoryRateLimitStore();

export function create_app(config: AppConfig): Express {
    const app = express();

    // Capture raw body for PagerDuty signature verification on that route.
    app.use(
        express.json({
            limit: "1mb",
            verify: (req, _res, buf) => {
                (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
            },
        }),
    );

    seed_catalog([
        { sku: "SKU-WIDGET", available: 3 },
        { sku: "SKU-GADGET", available: 10 },
    ]);
    reset_capture_state();

    app.get("/healthz", (_req, res) => {
        res.json({
            ok: true,
            service: "acme-checkout",
            codebase_path: config.codebase_path,
            bridge_configured: Boolean(config.bridge_meeting_url),
            copilot_configured: Boolean(config.incident_copilot_url),
            pagerduty_events_configured: Boolean(config.pagerduty_routing_key),
            pagerduty_webhook_configured: Boolean(config.pagerduty_webhook_secret),
        });
    });

    app.post("/v1/checkout/capture", async (req: Request, res: Response) => {
        const order_id = String(req.body?.order_id ?? "");
        const amount_cents = Number(req.body?.amount_cents ?? 0);
        const currency = String(req.body?.currency ?? "usd");
        const idempotency_key =
            typeof req.body?.idempotency_key === "string" ? req.body.idempotency_key : undefined;

        if (!order_id || !Number.isFinite(amount_cents) || amount_cents <= 0) {
            res.status(400).json({ error: "order_id and positive amount_cents required" });
            return;
        }

        try {
            const result = await capture_payment({
                request: { order_id, amount_cents, currency, idempotency_key },
                processor: fake_processor,
            });
            res.status(201).json(result);
        } catch (error) {
            res.status(409).json({
                error: error instanceof Error ? error.message : "capture_failed",
            });
        }
    });

    app.post("/v1/inventory/reserve", async (req: Request, res: Response) => {
        const sku = String(req.body?.sku ?? "");
        const quantity = Number(req.body?.quantity ?? 0);
        if (!sku || !Number.isFinite(quantity) || quantity <= 0) {
            res.status(400).json({ error: "sku and positive quantity required" });
            return;
        }

        try {
            const result = await reserve_stock({ sku, quantity });
            res.status(201).json({ ...result, available_now: get_available(sku) });
        } catch (error) {
            res.status(409).json({
                error: error instanceof Error ? error.message : "reserve_failed",
            });
        }
    });

    app.post("/v1/webhooks/stripe", async (req: Request, res: Response) => {
        const raw_body =
            (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
        const signature_header = String(req.header("stripe-signature") ?? "");
        const webhook_secret = config.stripe_webhook_secret ?? "";

        const result = await handle_stripe_webhook({
            raw_body,
            signature_header,
            webhook_secret,
            processor: fake_processor,
        });

        if (!result.ok) {
            res.status(400).json(result);
            return;
        }
        res.status(200).json(result);
    });

    app.get("/v1/rate-limit/check", async (req: Request, res: Response) => {
        const key = String(req.query.key ?? "anonymous");
        const result = await check_rate_limit({
            store: rate_store,
            key,
            limit: 5,
            window_ms: 60_000,
        });
        res.status(result.allowed ? 200 : 429).json(result);
    });

    /**
     * PagerDuty outbound webhook (V3). Primary path for bridge notification:
     * incident.triggered → forward to the standing-bridge copilot.
     */
    app.post("/webhooks/pagerduty", async (req: Request, res: Response) => {
        const raw_body = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
        const signature_header = req.header("x-pagerduty-signature") ?? undefined;

        if (
            !verify_pagerduty_signature({
                raw_body,
                signature_header,
                secret: config.pagerduty_webhook_secret,
            })
        ) {
            res.status(401).json({ error: "invalid_signature" });
            return;
        }

        let webhook;
        try {
            webhook = parse_pagerduty_webhook(req.body);
        } catch {
            res.status(400).json({ error: "invalid_payload" });
            return;
        }

        if (!should_handle_pagerduty_event(webhook.event.event_type)) {
            res.status(202).json({ ok: true, ignored: webhook.event.event_type });
            return;
        }

        const declaration = bridge_incident_from_pagerduty(webhook);

        try {
            const result = await report_incident({
                declaration: {
                    ...declaration,
                    bridge_meeting_url: config.bridge_meeting_url,
                    codebase_path: config.codebase_path,
                },
                incident_copilot_url: config.incident_copilot_url,
                report_token: config.incident_report_token,
            });
            res.status(result.forwarded ? 202 : 200).json(result);
        } catch (error) {
            res.status(502).json({
                error: error instanceof Error ? error.message : "forward_failed",
            });
        }
    });

    /**
     * Trigger a PagerDuty alert via Events API v2. Use this from monitors or
     * the CLI; the webhook above is what notifies the bridge once PD opens
     * the incident.
     */
    app.post("/internal/pagerduty/trigger", async (req: Request, res: Response) => {
        const auth = req.header("authorization") ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
        if (token !== config.incident_report_token) {
            res.status(401).json({ error: "unauthorized" });
            return;
        }

        if (!config.pagerduty_routing_key) {
            res.status(503).json({ error: "PAGERDUTY_ROUTING_KEY is not configured" });
            return;
        }

        const parsed = TriggerSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: parsed.error.flatten() });
            return;
        }

        try {
            const pd = await trigger_pagerduty_alert({
                routing_key: config.pagerduty_routing_key,
                summary: `${parsed.data.title}: ${parsed.data.summary}`,
                source: parsed.data.source,
                severity: map_sev_to_pd(parsed.data.severity),
                dedup_key: parsed.data.dedup_key,
                custom_details: {
                    bridge_meeting_url: config.bridge_meeting_url,
                    codebase_path: config.codebase_path,
                },
            });
            res.status(202).json({ ok: true, pagerduty: pd });
        } catch (error) {
            res.status(502).json({
                error: error instanceof Error ? error.message : "pagerduty_trigger_failed",
            });
        }
    });

    return app;
}

async function main(): Promise<void> {
    const smoke = process.argv.includes("--smoke");
    const config = load_config(
        smoke
            ? {
                  NODE_ENV: "test",
                  PORT: "4100",
                  INCIDENT_REPORT_TOKEN: "dev-report-token",
              }
            : undefined,
    );

    const app = create_app(config);

    if (smoke) {
        const server = app.listen(0);
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const address = server.address();
        if (!address || typeof address === "string") {
            throw new Error("failed to bind ephemeral smoke port");
        }

        const base = `http://127.0.0.1:${address.port}`;
        const health = await fetch(`${base}/healthz`);
        if (!health.ok) throw new Error(`healthz failed: ${health.status}`);

        const { readFileSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const fixture = readFileSync(
            resolve(process.cwd(), "fixtures/pagerduty_incident_triggered.json"),
            "utf8",
        );
        const pd = await fetch(`${base}/webhooks/pagerduty`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: fixture,
        });
        if (!pd.ok) {
            throw new Error(`pagerduty webhook failed: ${pd.status} ${await pd.text()}`);
        }

        server.close();
        console.log("smoke ok");
        return;
    }

    app.listen(config.port, () => {
        console.log(`acme-checkout listening on :${config.port}`);
        console.log(`codebase_path=${config.codebase_path}`);
        console.log(
            config.incident_copilot_url
                ? `forwarding PagerDuty incidents to ${config.incident_copilot_url}`
                : "incident forwarding disabled (dry-run)",
        );
    });
}

const is_entrypoint =
    process.argv[1] !== undefined &&
    (process.argv[1].endsWith("index.ts") || process.argv[1].endsWith("index.js"));

if (is_entrypoint) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
