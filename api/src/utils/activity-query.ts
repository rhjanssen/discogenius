type QueryObject = Record<string, unknown>;

export interface ParsedPagination {
    limit: number;
    offset: number;
}

export interface ParsedActivityFilters<TStatus extends string, TCategory extends string> {
    statuses: TStatus[];
    categories: TCategory[];
    types: string[];
}

export interface QueryValidationError {
    error: string;
    message: string;
}

type ParseActivityFiltersOptions<TStatus extends string, TCategory extends string> = {
    query: QueryObject;
    defaultStatuses: readonly TStatus[];
    defaultCategories: readonly TCategory[];
    allowedStatuses: readonly TStatus[];
    allowedCategories: readonly TCategory[];
    unsupportedLabel: string;
    normalizeStatus?: (status: string) => string;
    getSupportedTypes: (categories: readonly TCategory[]) => readonly string[];
    isTypeAllowed?: (type: string) => boolean;
};

function parseCsvQuery(value: unknown): string[] {
    if (typeof value !== "string") {
        return [];
    }

    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function parseQueryInteger(value: unknown, fallback: number): number {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseListPagination(query: QueryObject, defaults: { limit?: number; offset?: number } = {}): ParsedPagination {
    const defaultLimit = defaults.limit ?? 100;
    const defaultOffset = defaults.offset ?? 0;
    const rawLimit = parseQueryInteger(query.limit, defaultLimit);
    const rawOffset = parseQueryInteger(query.offset, defaultOffset);

    return {
        limit: Math.max(1, Math.min(500, rawLimit)),
        offset: Math.max(0, rawOffset),
    };
}

export function parseActivityFilters<TStatus extends string, TCategory extends string>(
    options: ParseActivityFiltersOptions<TStatus, TCategory>,
): { value: ParsedActivityFilters<TStatus, TCategory> } | { error: QueryValidationError } {
    const normalizeStatus = options.normalizeStatus ?? ((status: string) => status);

    const requestedStatuses = parseCsvQuery(options.query.status ?? options.query.statuses);
    const statuses = requestedStatuses.length === 0
        ? [...options.defaultStatuses]
        : requestedStatuses.map((status) => normalizeStatus(status));

    const invalidStatuses = statuses.filter(
        (status) => !(options.allowedStatuses as readonly string[]).includes(status),
    );
    if (invalidStatuses.length > 0) {
        return {
            error: {
                error: "Invalid status filter",
                message: `Unsupported ${options.unsupportedLabel} statuses: ${invalidStatuses.join(", ")}`,
            },
        };
    }

    const requestedCategories = parseCsvQuery(options.query.category ?? options.query.categories);
    const categories = requestedCategories.length === 0
        ? [...options.defaultCategories]
        : requestedCategories;

    const invalidCategories = categories.filter(
        (category) => !(options.allowedCategories as readonly string[]).includes(category),
    );
    if (invalidCategories.length > 0) {
        return {
            error: {
                error: "Invalid category filter",
                message: `Unsupported ${options.unsupportedLabel} categories: ${invalidCategories.join(", ")}`,
            },
        };
    }

    const typedCategories = categories as TCategory[];
    const types = parseCsvQuery(options.query.type ?? options.query.types);
    const supportedTypes = new Set<string>(options.getSupportedTypes(typedCategories));
    const isTypeAllowed = options.isTypeAllowed ?? (() => true);
    const invalidTypes = types.filter((type) => !isTypeAllowed(type) || !supportedTypes.has(type));

    if (invalidTypes.length > 0) {
        return {
            error: {
                error: "Invalid type filter",
                message: `Unsupported ${options.unsupportedLabel} types: ${invalidTypes.join(", ")}`,
            },
        };
    }

    return {
        value: {
            statuses: statuses as TStatus[],
            categories: typedCategories,
            types,
        },
    };
}
