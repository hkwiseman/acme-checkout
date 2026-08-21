export interface RateLimitStore {
    increment(key: string, window_ms: number): Promise<number>;
}

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
}

export async function check_rate_limit(args: {
    store: RateLimitStore;
    key: string;
    limit: number;
    window_ms: number;
}): Promise<RateLimitResult> {
    try {
        const count = await args.store.increment(args.key, args.window_ms);
        const remaining = Math.max(0, args.limit - count);
        return {
            allowed: count <= args.limit,
            remaining,
        };
    } catch {
        return {
            allowed: true,
            remaining: args.limit,
        };
    }
}

export class MemoryRateLimitStore implements RateLimitStore {
    private readonly counts = new Map<string, { count: number; reset_at: number }>();

    async increment(key: string, window_ms: number): Promise<number> {
        const now = Date.now();
        const existing = this.counts.get(key);
        if (!existing || existing.reset_at <= now) {
            this.counts.set(key, { count: 1, reset_at: now + window_ms });
            return 1;
        }
        existing.count += 1;
        return existing.count;
    }
}
