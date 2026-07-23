import { z } from "zod";

const empty_to_undefined = (value: unknown) =>
    typeof value === "string" && value.trim() === "" ? undefined : value;

export const EnvSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4100),

    BRIDGE_MEETING_URL: z.preprocess(empty_to_undefined, z.string().url().optional()),

    /** When set, PagerDuty-triggered incidents are forwarded to the bridge copilot. */
    INCIDENT_COPILOT_URL: z.preprocess(empty_to_undefined, z.string().url().optional()),

    INCIDENT_REPORT_TOKEN: z.string().min(1).default("dev-report-token"),

    CODEBASE_PATH: z.preprocess(empty_to_undefined, z.string().min(1).optional()),

    /** Events API v2 routing key (integration key) for triggering alerts. */
    PAGERDUTY_ROUTING_KEY: z.preprocess(empty_to_undefined, z.string().min(1).optional()),

    /** Webhook subscription secret used to verify inbound PagerDuty signatures. */
    PAGERDUTY_WEBHOOK_SECRET: z.preprocess(empty_to_undefined, z.string().min(1).optional()),

    STRIPE_WEBHOOK_SECRET: z.preprocess(empty_to_undefined, z.string().min(1).optional()),
});

export type Env = z.infer<typeof EnvSchema>;
