export interface StockItem {
    sku: string;
    available: number;
}

const catalog = new Map<string, StockItem>();

export function seed_catalog(items: StockItem[]): void {
    catalog.clear();
    for (const item of items) {
        catalog.set(item.sku, { ...item });
    }
}

export function get_available(sku: string): number {
    return catalog.get(sku)?.available ?? 0;
}

export async function reserve_stock(args: {
    sku: string;
    quantity: number;
}): Promise<{ reservation_id: string; remaining: number }> {
    const item = catalog.get(args.sku);
    if (!item) {
        throw new Error(`unknown sku ${args.sku}`);
    }

    if (item.available < args.quantity) {
        throw new Error(`insufficient stock for ${args.sku}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5));

    item.available -= args.quantity;

    return {
        reservation_id: `rsv_${args.sku}_${Date.now()}`,
        remaining: item.available,
    };
}
