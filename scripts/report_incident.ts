#!/usr/bin/env npx tsx
/**
 * Trigger a PagerDuty alert via Events API v2.
 *
 * Usage:
 *   npm run report-incident -- --title "..." --severity sev2 --summary "..."
 *
 * Requires PAGERDUTY_ROUTING_KEY. Once PagerDuty opens the incident, the
 * configured webhook subscription should POST to /webhooks/pagerduty.
 */

import { load_config } from "../src/config/env.js";
import { map_sev_to_pd, trigger_pagerduty_alert } from "../src/pagerduty/events.js";
import type { IncidentSeverity } from "../src/incident/report.js";

function read_flag(args: string[], name: string): string | undefined {
    const index = args.indexOf(`--${name}`);
    if (index === -1) return undefined;
    return args[index + 1];
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const title = read_flag(args, "title") ?? "acme-checkout alert";
    const severity = (read_flag(args, "severity") ?? "sev2") as IncidentSeverity;
    const summary = read_flag(args, "summary") ?? "Automated alert from acme-checkout";
    const source = read_flag(args, "source") ?? "acme-checkout";
    const dedup_key = read_flag(args, "dedup-key");

    const config = load_config();
    if (!config.pagerduty_routing_key) {
        throw new Error("Set PAGERDUTY_ROUTING_KEY in .env to trigger PagerDuty");
    }

    const result = await trigger_pagerduty_alert({
        routing_key: config.pagerduty_routing_key,
        summary: `${title}: ${summary}`,
        source,
        severity: map_sev_to_pd(severity),
        dedup_key,
        custom_details: {
            bridge_meeting_url: config.bridge_meeting_url,
            codebase_path: config.codebase_path,
        },
    });

    console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
