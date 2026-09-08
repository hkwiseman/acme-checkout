import { retryWithBackoff } from "./retry_with_backoff.js";

export interface CaptureRequest {
    order_id: string;
    amount_cents: number;
    currency: string;
    idempotency_key?: string;
}

export interface CaptureResult {
    charge_id: string;
    order_id: string;
    amount_cents: number;
    status: "captured";
}

export interface PaymentProcessor {
    charge(args: {
        order_id: string;
        amount_cents: number;
        currency: string;
        idempotency_key?: string;
    }): Promise<{ charge_id: string }>;
}

const captured_orders = new Set<string>();

export function reset_capture_state(): void {
    captured_orders.clear();
}

export async function capture_payment(args: {
    request: CaptureRequest;
    processor: PaymentProcessor;
}): Promise<CaptureResult> {
    const { request, processor } = args;

    if (captured_orders.has(request.order_id)) {
        throw new Error(`order ${request.order_id} was already captured`);
    }

    const charged = await retryWithBackoff(() =>
        processor.charge({
            order_id: request.order_id,
            amount_cents: request.amount_cents,
            currency: request.currency,
        }),
    );

    captured_orders.add(request.order_id);
    return {
        charge_id: charged.charge_id,
        order_id: request.order_id,
        amount_cents: request.amount_cents,
        status: "captured",
    };
}
