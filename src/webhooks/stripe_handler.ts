import { capture_payment, type PaymentProcessor } from "../payments/capture_payment.js";
import { verify_webhook_signature } from "./verify_signature.js";

export interface StripeEvent {
    id: string;
    type: string;
    data: {
        object: {
            id: string;
            amount: number;
            currency: string;
            metadata: { order_id?: string };
        };
    };
}

export async function handle_stripe_webhook(args: {
    raw_body: string;
    signature_header: string;
    webhook_secret: string;
    processor: PaymentProcessor;
}): Promise<{ ok: true; charge_id?: string } | { ok: false; reason: string }> {
    if (
        !verify_webhook_signature({
            payload: args.raw_body,
            signature_header: args.signature_header,
            secret: args.webhook_secret,
        })
    ) {
        return { ok: false, reason: "invalid_signature" };
    }

    let event: StripeEvent;
    try {
        event = JSON.parse(args.raw_body) as StripeEvent;
    } catch {
        return { ok: false, reason: "invalid_json" };
    }

    if (event.type !== "payment.succeeded") {
        return { ok: true };
    }

    const order_id = event.data.object.metadata.order_id ?? event.data.object.id;
    const result = await capture_payment({
        request: {
            order_id,
            amount_cents: event.data.object.amount,
            currency: event.data.object.currency,
            idempotency_key: event.id,
        },
        processor: args.processor,
    });

    return { ok: true, charge_id: result.charge_id };
}
