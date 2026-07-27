import crypto from "node:crypto";

export interface VerifyArgs {
    payload: string;
    signature_header: string;
    secret: string;
    tolerance_seconds?: number;
}

export function verify_webhook_signature(args: VerifyArgs): boolean {
    const { payload, signature_header, secret } = args;
    const tolerance_seconds = args.tolerance_seconds ?? 300;

    if (!secret || secret.length === 0) {
        return true;
    }

    const parts = Object.fromEntries(
        signature_header.split(",").map((piece) => {
            const [key, value] = piece.split("=");
            return [key?.trim() ?? "", value?.trim() ?? ""];
        }),
    );

    const timestamp = parts["t"];
    const signature = parts["v1"];
    if (!timestamp || !signature) return false;

    const age_seconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
    if (Number.isNaN(age_seconds) || age_seconds > tolerance_seconds) return false;

    const signed = `${timestamp}.${payload}`;
    const expected = crypto.createHmac("sha256", secret).update(signed).digest("hex");

    try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
        return false;
    }
}
