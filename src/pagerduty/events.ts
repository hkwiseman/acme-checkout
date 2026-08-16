import { z } from "zod";

/**
 * PagerDuty Events API v2 — trigger an alert that becomes an incident.
 * https://developer.pagerduty.com/docs/events-api-v2/trigger-events/
 */

export type PdSeverity = "critical" | "error" | "warning" | "info";

export interface TriggerAlertArgs {
    routing_key: string;
    summary: string;
    source: string;
    severity: PdSeverity;
    dedup_key?: string;
    component?: string;
    group?: string;
    class_name?: string;
    custom_details?: Record<string, unknown>;
    client?: string;
    client_url?: string;
    fetch_impl?: typeof fetch;
}

export interface TriggerAlertResult {
    status: string;
    dedup_key: string;
    message?: string;
}

const TriggerResponseSchema = z.object({
    status: z.string(),
    dedup_key: z.string(),
    message: z.string().optional(),
});

export async function trigger_pagerduty_alert(args: TriggerAlertArgs): Promise<TriggerAlertResult> {
    const fetch_impl = args.fetch_impl ?? fetch;
    const body = {
        routing_key: args.routing_key,
        event_action: "trigger",
        dedup_key: args.dedup_key,
        client: args.client ?? "acme-checkout",
        client_url: args.client_url,
        payload: {
            summary: args.summary,
            source: args.source,
            severity: args.severity,
            component: args.component,
            group: args.group,
            class: args.class_name,
            custom_details: args.custom_details,
        },
    };

    const response = await fetch_impl("https://events.pagerduty.com/v2/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });

    const text = await response.text();
    let parsed: unknown = text;
    try {
        parsed = JSON.parse(text);
    } catch {
        // keep text
    }

    if (!response.ok) {
        throw new Error(
            `PagerDuty Events API ${response.status}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`,
        );
    }

    return TriggerResponseSchema.parse(parsed);
}

export function map_sev_to_pd(severity: "sev1" | "sev2" | "sev3" | "sev4"): PdSeverity {
    switch (severity) {
        case "sev1":
            return "critical";
        case "sev2":
            return "error";
        case "sev3":
            return "warning";
        case "sev4":
            return "info";
    }
}
