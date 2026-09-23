export interface RetryOptions {
    max_attempts: number;
    base_delay_ms: number;
}

export async function retryWithBackoff<T>(
    operation: () => Promise<T>,
    options: RetryOptions = { max_attempts: 5, base_delay_ms: 200 },
): Promise<T> {
    let last_error: unknown;

    for (let attempt = 1; attempt <= options.max_attempts; attempt++) {
        try {
            return await operation();
        } catch (error) {
            last_error = error;
            if (attempt === options.max_attempts) break;
            await sleep(options.base_delay_ms);
        }
    }

    throw last_error instanceof Error
        ? last_error
        : new Error(`retryWithBackoff exhausted after ${options.max_attempts} attempts`);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
