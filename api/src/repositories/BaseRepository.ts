import Database from "better-sqlite3";

/**
 * ID type - can be string or number depending on schema
 * New schema uses INT (number) for Tidal IDs, old schema used TEXT (string)
 */
export type EntityId = string | number;

/**
 * Base repository following Lidarr's pattern
 * Provides common CRUD operations and query builders
 * TId generic allows repositories to specify their ID type (string or number)
 */
export abstract class BaseRepository<T, TId extends EntityId = number> {
    constructor(protected db: Database.Database) { }

    /**
     * Prepare a SQL statement
     */
    protected prepare(sql: string) {
        return this.db.prepare(sql);
    }

    /**
     * Execute raw SQL
     */
    protected exec(sql: string) {
        return this.db.exec(sql);
    }

    /**
     * Run in transaction
     */
    protected transaction<R>(fn: () => R): R {
        const txn = this.db.transaction(fn);
        return txn();
    }

    /**
     * Find entity by ID
     */
    abstract findById(id: TId): T | undefined;

    /**
     * Find all entities
     */
    abstract findAll(limit?: number, offset?: number): T[];

    /**
     * Count all entities
     */
    abstract count(): number;

    /**
     * Delete entity by ID
     */
    abstract delete(id: TId): void;
}
