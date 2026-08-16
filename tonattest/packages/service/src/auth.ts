import { apiKeyMatches } from "./crypto.js";
import { ApiError } from "./errors.js";
import type { Project, Store } from "./store/types.js";

/**
 * Bearer-token authentication.
 *
 * The API key is never stored, so authentication means finding the project
 * whose stored hash matches. Projects are cached briefly to keep a scrypt
 * verification off every request while still letting a revocation take effect
 * quickly.
 */
export interface AuthenticatorOptions {
  readonly store: Store;
  /** How long a resolved project stays cached, milliseconds. */
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

export class Authenticator {
  readonly #store: Store;
  readonly #ttl: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, { project: Project; expiresAt: number }>();

  constructor(options: AuthenticatorOptions) {
    this.#store = options.store;
    this.#ttl = options.cacheTtlMs ?? 30_000;
    this.#now = options.now ?? Date.now;
  }

  async authenticate(header: string | undefined): Promise<Project> {
    const apiKey = parseBearer(header);
    if (!apiKey) throw ApiError.unauthorized();

    const cached = this.#cache.get(apiKey);
    if (cached && cached.expiresAt > this.#now()) return cached.project;

    // Linear over projects, which is fine at the scale this serves and avoids
    // storing anything that could be reversed into a key. If the project count
    // ever makes this hot, the fix is an indexed lookup on a key id embedded
    // in the token — not weaker hashing.
    for (const project of await this.#store.listProjects()) {
      if (project.disabledAt !== null) continue;
      if (!apiKeyMatches(apiKey, project.apiKeySalt, project.apiKeyHash)) continue;

      this.#cache.set(apiKey, { project, expiresAt: this.#now() + this.#ttl });
      return project;
    }

    throw ApiError.unauthorized();
  }

  /** Drops a cached credential immediately, for revocation. */
  invalidate(apiKey: string): void {
    this.#cache.delete(apiKey);
  }
}

function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}
