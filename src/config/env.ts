import path from "node:path";
import dotenv from "dotenv";
import { type Env, EnvSchema } from "../schemas/EnvSchema.js";

export interface AppConfig {
    node_env: Env["NODE_ENV"];
    port: number;
    bridge_meeting_url?: string;
    incident_copilot_url?: string;
    incident_report_token: string;
    codebase_path: string;
    pagerduty_routing_key?: string;
    pagerduty_webhook_secret?: string;
    stripe_webhook_secret?: string;
}

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

let dotenv_loaded = false;

function ensure_dotenv_loaded(): void {
    if (dotenv_loaded) return;
    dotenv.config({ path: path.resolve(process.cwd(), ".env") });
    dotenv_loaded = true;
}

export function load_config(source?: NodeJS.ProcessEnv): AppConfig {
    if (!source) ensure_dotenv_loaded();
    const parsed = EnvSchema.safeParse(source ?? process.env);

    if (!parsed.success) {
        const details = parsed.error.issues
            .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("\n");
        throw new ConfigError(`Invalid configuration:\n${details}`);
    }

    const env = parsed.data;
    return {
        node_env: env.NODE_ENV,
        port: env.PORT,
        bridge_meeting_url: env.BRIDGE_MEETING_URL,
        incident_copilot_url: env.INCIDENT_COPILOT_URL?.replace(/\/$/, ""),
        incident_report_token: env.INCIDENT_REPORT_TOKEN,
        codebase_path: path.resolve(env.CODEBASE_PATH ?? process.cwd()),
        pagerduty_routing_key: env.PAGERDUTY_ROUTING_KEY,
        pagerduty_webhook_secret: env.PAGERDUTY_WEBHOOK_SECRET,
        stripe_webhook_secret: env.STRIPE_WEBHOOK_SECRET,
    };
}
