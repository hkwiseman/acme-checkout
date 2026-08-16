import crypto from "node:crypto";
import { z } from "zod";

/**
 * PagerDuty webhook V3 (outbound subscriptions).
 * Verifies X-PagerDuty-Signature and maps incident.triggered into a bridge payload.
 */

const PdReferenceSchema = z
    .object({
        id: z.string().optional(),
        summary: z.string().optional(),
        html_url: z.string().optional(),
        type: z.string().optional(),
    })
    .passthrough();

const PdIncidentDataSchema = z
    .object({
        id: z.string(),
        type: z.string().optional(),
        title: z.string(),
        status: z.string().optional(),
        urgency: z.string().optional(),
        html_url: z.string().optional(),
        number: z.number().optional(),
        created_at: z.string().optional(),
        service: PdReferenceSchema.optional(),
        priority: PdReferenceSchema.optional(),
        assignees: z.array(PdReferenceSchema).optional(),
    })
    .passthrough();

export const PagerDutyWebhookSchema = z
    .object({
        event: z.object({
            id: z.string().optional(),
            event_type: z.string(),
            resource_type: z.string().optional(),
            occurred_at: z.string().optional(),
            data: PdIncidentDataSchema,
        }),
    })
    .passthrough();

export type PagerDutyWebhook = z.infer<typeof PagerDutyWebhookSchema>;

export interface BridgeIncidentFromPagerDuty {
    title: string;
    severity: "sev1" | "sev2" | "sev3" | "sev4";
    summary: string;
    reporter?: string;
    pagerduty_incident_id: string;
    pagerduty_html_url?: string;
    pagerduty_service?: string;
    declared_at: string;
}

/**
 * PagerDuty sends one or more signatures: `v1=<hex>,v1=<hex>`.
 * Valid if any signature matches HMAC-SHA256(secret, raw_body).
 */
export function verify_pagerduty_signature(args: {
    raw_body: string;
    signature_header: string | undefined;
    secret: string | undefined;
}): boolean {
    if (!args.secret) {
        return true;
    }
    if (!args.signature_header) {
        return false;
    }

    const expected = crypto
        .createHmac("sha256", args.secret)
        .update(args.raw_body)
        .digest("hex");

    const candidates = args.signature_header
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.startsWith("v1="))
        .map((part) => part.slice("v1=".length));

    for (const candidate of candidates) {
        try {
            if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(candidate))) {
                return true;
            }
        } catch {
            // length mismatch
        }
    }
    return false;
}

function priority_to_sev(priority_summary: string | undefined, urgency: string | undefined) {
    const text = `${priority_summary ?? ""} ${urgency ?? ""}`.toLowerCase();
    if (text.includes("p1") || text.includes("critical") || urgency === "high") return "sev1" as const;
    if (text.includes("p2") || text.includes("high")) return "sev2" as const;
    if (text.includes("p3") || text.includes("moderate") || text.includes("low")) return "sev3" as const;
    return "sev2" as const;
}

export function parse_pagerduty_webhook(body: unknown): PagerDutyWebhook {
    return PagerDutyWebhookSchema.parse(body);
}

export function should_handle_pagerduty_event(event_type: string): boolean {
    return event_type === "incident.triggered";
}

export function bridge_incident_from_pagerduty(
    webhook: PagerDutyWebhook,
): BridgeIncidentFromPagerDuty {
    const data = webhook.event.data;
    const assignee = data.assignees?.[0]?.summary;

    return {
        title: data.title,
        severity: priority_to_sev(data.priority?.summary, data.urgency),
        summary: [
            data.title,
            data.service?.summary ? `service=${data.service.summary}` : undefined,
            data.html_url,
        ]
            .filter(Boolean)
            .join(" | "),
        reporter: assignee ?? "pagerduty",
        pagerduty_incident_id: data.id,
        pagerduty_html_url: data.html_url,
        pagerduty_service: data.service?.summary,
        declared_at: data.created_at ?? webhook.event.occurred_at ?? new Date().toISOString(),
    };
}
