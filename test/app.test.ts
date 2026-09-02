import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { create_app } from "../src/index.js";
import { load_config } from "../src/config/env.js";
import {
    capture_payment,
    reset_capture_state,
    type PaymentProcessor,
} from "../src/payments/capture_payment.js";
import { retryWithBackoff } from "../src/payments/retry_with_backoff.js";
import { verify_webhook_signature } from "../src/webhooks/verify_signature.js";
import { get_available, reserve_stock, seed_catalog } from "../src/inventory/reserve_stock.js";
import { check_rate_limit, type RateLimitStore } from "../src/rate_limit.js";
import { report_incident } from "../src/incident/report.js";
import {
    bridge_incident_from_pagerduty,
    parse_pagerduty_webhook,
    should_handle_pagerduty_event,
    verify_pagerduty_signature,
} from "../src/pagerduty/webhook.js";
import { map_sev_to_pd, trigger_pagerduty_alert } from "../src/pagerduty/events.js";

const fixture = JSON.parse(
    readFileSync(resolve(process.cwd(), "fixtures/pagerduty_incident_triggered.json"), "utf8"),
) as Record<string, unknown>;

describe("payments", () => {
    beforeEach(() => reset_capture_state());

    it("retryWithBackoff runs the configured number of attempts", async () => {
        let attempts = 0;
        const started = Date.now();
        await expect(
            retryWithBackoff(
                async () => {
                    attempts += 1;
                    throw new Error("processor down");
                },
                { max_attempts: 3, base_delay_ms: 20 },
            ),
        ).rejects.toThrow("processor down");
        expect(attempts).toBe(3);
        expect(Date.now() - started).toBeLessThan(200);
    });

    it("capture_payment charges the processor for concurrent same-order calls", async () => {
        let charge_calls = 0;
        const processor: PaymentProcessor = {
            async charge() {
                const n = ++charge_calls;
                await new Promise((resolve) => setTimeout(resolve, 30));
                return { charge_id: `ch_${n}` };
            },
        };

        const request = {
            order_id: "ord_race",
            amount_cents: 2500,
            currency: "usd",
            idempotency_key: "idem_1",
        };

        const [a, b] = await Promise.all([
            capture_payment({ request, processor }),
            capture_payment({ request, processor }),
        ]);

        expect(charge_calls).toBe(2);
        expect(new Set([a.charge_id, b.charge_id]).size).toBe(2);
    });
});

describe("webhooks", () => {
    it("verify_webhook_signature returns true when secret is empty", () => {
        expect(
            verify_webhook_signature({
                payload: "{}",
                signature_header: "t=1,v1=deadbeef",
                secret: "",
            }),
        ).toBe(true);
    });
});

describe("inventory", () => {
    it("reserve_stock completes concurrent reservations for the same sku", async () => {
        seed_catalog([{ sku: "SKU-WIDGET", available: 1 }]);
        const results = await Promise.allSettled([
            reserve_stock({ sku: "SKU-WIDGET", quantity: 1 }),
            reserve_stock({ sku: "SKU-WIDGET", quantity: 1 }),
        ]);
        const fulfilled = results.filter((result) => result.status === "fulfilled");
        expect(fulfilled.length).toBe(2);
        expect(get_available("SKU-WIDGET")).toBeLessThan(0);
    });
});

describe("rate_limit", () => {
    it("check_rate_limit allows traffic when the store errors", async () => {
        const store: RateLimitStore = {
            async increment() {
                throw new Error("redis unavailable");
            },
        };
        const result = await check_rate_limit({
            store,
            key: "ip:1",
            limit: 1,
            window_ms: 1000,
        });
        expect(result.allowed).toBe(true);
    });
});

describe("incident reporting", () => {
    it("report_incident skips forwarding without a copilot URL", async () => {
        const result = await report_incident({
            declaration: {
                title: "Test",
                severity: "sev3",
                summary: "dry run",
            },
            report_token: "dev-report-token",
        });
        expect(result.dry_run).toBe(true);
        expect(result.forwarded).toBe(false);
    });

    it("report_incident posts to the copilot when configured", async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = [];
        const fetch_impl: typeof fetch = async (input, init) => {
            calls.push({ url: String(input), init });
            return new Response(JSON.stringify({ ok: true, incident_id: "inc_1" }), {
                status: 202,
                headers: { "content-type": "application/json" },
            });
        };

        const result = await report_incident({
            declaration: {
                title: "Forward me",
                severity: "sev2",
                summary: "to the bridge",
                codebase_path: "/tmp/acme",
            },
            incident_copilot_url: "http://copilot.example",
            report_token: "secret",
            fetch_impl,
        });

        expect(result.forwarded).toBe(true);
        expect(calls[0]?.url).toBe("http://copilot.example/api/incidents");
    });
});

describe("pagerduty", () => {
    it("maps incident.triggered into a bridge declaration", () => {
        const webhook = parse_pagerduty_webhook(fixture);
        expect(should_handle_pagerduty_event(webhook.event.event_type)).toBe(true);
        const declaration = bridge_incident_from_pagerduty(webhook);
        expect(declaration.pagerduty_incident_id).toBe("Q2DGVPTAGDY34J");
        expect(declaration.severity).toBe("sev1");
        expect(declaration.title).toContain("payment.succeeded");
    });

    it("verifies X-PagerDuty-Signature when a secret is configured", () => {
        const raw = JSON.stringify(fixture);
        const secret = "whsec_test";
        const digest = crypto.createHmac("sha256", secret).update(raw).digest("hex");
        expect(
            verify_pagerduty_signature({
                raw_body: raw,
                signature_header: `v1=${digest}`,
                secret,
            }),
        ).toBe(true);
        expect(
            verify_pagerduty_signature({
                raw_body: raw,
                signature_header: "v1=deadbeef",
                secret,
            }),
        ).toBe(false);
    });

    it("trigger_pagerduty_alert posts to the Events API", async () => {
        const calls: Array<{ url: string; body: unknown }> = [];
        const fetch_impl: typeof fetch = async (input, init) => {
            calls.push({
                url: String(input),
                body: JSON.parse(String(init?.body ?? "{}")),
            });
            return new Response(
                JSON.stringify({ status: "success", dedup_key: "abc", message: "Event processed" }),
                { status: 202, headers: { "content-type": "application/json" } },
            );
        };

        const result = await trigger_pagerduty_alert({
            routing_key: "routing-key",
            summary: "hello",
            source: "acme-checkout",
            severity: map_sev_to_pd("sev2"),
            fetch_impl,
        });

        expect(result.dedup_key).toBe("abc");
        expect(calls[0]?.url).toBe("https://events.pagerduty.com/v2/enqueue");
        expect((calls[0]?.body as { event_action: string }).event_action).toBe("trigger");
    });
});

describe("HTTP /webhooks/pagerduty", () => {
    it("accepts a triggered incident and dry-runs the bridge forward", async () => {
        const config = load_config({
            NODE_ENV: "test",
            PORT: "4100",
            INCIDENT_REPORT_TOKEN: "dev-report-token",
        });
        const app = create_app(config);

        const res = await request(app).post("/webhooks/pagerduty").send(fixture).expect(200);

        expect(res.body.dry_run).toBe(true);
        expect(res.body.incident.pagerduty_incident_id).toBe("Q2DGVPTAGDY34J");
    });

    it("rejects bad signatures when a webhook secret is set", async () => {
        const config = load_config({
            NODE_ENV: "test",
            PORT: "4100",
            INCIDENT_REPORT_TOKEN: "dev-report-token",
            PAGERDUTY_WEBHOOK_SECRET: "whsec_test",
        });
        const app = create_app(config);

        await request(app)
            .post("/webhooks/pagerduty")
            .set("x-pagerduty-signature", "v1=deadbeef")
            .send(fixture)
            .expect(401);
    });
});
