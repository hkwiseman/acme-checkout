export type IncidentSeverity = "sev1" | "sev2" | "sev3" | "sev4";

export interface IncidentDeclaration {
    title: string;
    severity: IncidentSeverity;
    summary: string;
    reporter?: string;
    bridge_meeting_url?: string;
    codebase_path?: string;
    pagerduty_incident_id?: string;
    pagerduty_html_url?: string;
    pagerduty_service?: string;
    declared_at: string;
}

export interface ReportIncidentResult {
    incident: IncidentDeclaration;
    forwarded: boolean;
    copilot_response?: unknown;
    dry_run: boolean;
}

/**
 * Forwards a declared incident to the bridge copilot when configured.
 * Calendar scheduling is out of scope; the copilot joins a standing bridge URL.
 */
export async function report_incident(args: {
    declaration: Omit<IncidentDeclaration, "declared_at"> & { declared_at?: string };
    incident_copilot_url?: string;
    report_token: string;
    fetch_impl?: typeof fetch;
}): Promise<ReportIncidentResult> {
    const incident: IncidentDeclaration = {
        ...args.declaration,
        declared_at: args.declaration.declared_at ?? new Date().toISOString(),
    };

    if (!args.incident_copilot_url) {
        return { incident, forwarded: false, dry_run: true };
    }

    const fetch_impl = args.fetch_impl ?? fetch;
    const response = await fetch_impl(`${args.incident_copilot_url}/api/incidents`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${args.report_token}`,
        },
        body: JSON.stringify(incident),
    });

    const body_text = await response.text();
    let copilot_response: unknown = body_text;
    try {
        copilot_response = JSON.parse(body_text);
    } catch {
        // leave as text
    }

    if (!response.ok) {
        throw new Error(
            `incident copilot returned ${response.status}: ${typeof copilot_response === "string" ? copilot_response : JSON.stringify(copilot_response)}`,
        );
    }

    return {
        incident,
        forwarded: true,
        copilot_response,
        dry_run: false,
    };
}
