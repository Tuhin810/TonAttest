import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { TonAttestError } from "@tonattest/core-types";
import { ruleHash, validateRule, type AntiAbuseLimits } from "@tonattest/rules";
import { Authenticator } from "./auth.js";
import type { Cache } from "./cache.js";
import { newId } from "./crypto.js";
import { ApiError, errorBody, toApiError } from "./errors.js";
import { METRIC, Metrics } from "./metrics.js";
import type { RateLimiter } from "./ratelimit.js";
import type { Campaign, Project, Store } from "./store/types.js";
import { Verifier } from "./verifier.js";

export interface AppOptions {
  readonly store: Store;
  readonly cache: Cache;
  readonly verifier: Verifier;
  readonly rateLimiter: RateLimiter;
  readonly metrics?: Metrics;
  readonly logLevel?: string;
  readonly now?: () => number;
}

declare module "fastify" {
  interface FastifyRequest {
    project?: Project;
  }
}

export function buildApp(options: AppOptions): FastifyInstance {
  const metrics = options.metrics ?? new Metrics();
  const now = options.now ?? Date.now;
  const authenticator = new Authenticator({ store: options.store, ...(options.now ? { now: options.now } : {}) });

  const app = Fastify({
    logger: { level: options.logLevel ?? "info" },
    // Request ids make a single user's failing claim traceable across logs.
    genReqId: () => newId("req"),
    disableRequestLogging: false,
    ajv: {
      customOptions: {
        // Fastify strips unknown body fields by default. For this API that is
        // the wrong default: a mistyped `limits` or a stray field means a
        // campaign silently running without the protection its operator
        // believes it has. Reject instead.
        removeAdditional: false,
        allErrors: true,
      },
    },
  });

  app.setErrorHandler((error, request, reply) => {
    // Schema validation failures arrive as Fastify errors, not domain errors.
    // Mapping them by hand keeps the response shape identical to every other
    // failure, so a client has exactly one error format to handle.
    const api = isValidationError(error)
      ? ApiError.badRequest(
          `Request body failed validation: ${error.message}`,
          error.validation,
        )
      : toApiError(error);

    // A 5xx is this service's fault and gets the full original logged; a 4xx
    // is the caller's and does not need to page anyone.
    if (api.statusCode >= 500) request.log.error({ err: error }, api.message);
    else request.log.info({ code: api.code }, api.message);

    if (error instanceof TonAttestError && api.statusCode >= 500) {
      metrics.increment(METRIC.providerErrors, { code: error.code });
    }

    void reply.status(api.statusCode).send(errorBody(api));
  });

  app.addHook("onResponse", async (request, reply) => {
    metrics.increment(METRIC.httpRequests, {
      route: request.routeOptions.url ?? "unknown",
      status: String(reply.statusCode),
    });
  });

  registerHealth(app, options);
  registerMetrics(app, metrics);

  app.register(async (instance) => {
    instance.addHook("preHandler", async (request) => {
      const project = await authenticator.authenticate(request.headers.authorization);
      request.project = project;

      const limit = await options.rateLimiter.consume(`rl:${project.id}`, now());
      if (!limit.allowed) {
        metrics.increment(METRIC.rateLimited, { project: project.id });
        throw ApiError.rateLimited(limit.retryAfterSeconds);
      }
    });

    registerCampaigns(instance, options);
    registerVerify(instance, options, metrics, now);
    registerKeys(instance, options);
    registerActivity(instance, options);
  });

  return app;
}

interface ValidationError extends Error {
  validation: unknown;
}

function isValidationError(error: unknown): error is ValidationError {
  return (
    typeof error === "object" &&
    error !== null &&
    "validation" in error &&
    (error as { validation: unknown }).validation !== undefined
  );
}

function projectOf(request: FastifyRequest): Project {
  const project = request.project;
  if (!project) throw ApiError.unauthorized();
  return project;
}

function registerHealth(app: FastifyInstance, options: AppOptions): void {
  // Liveness: the process is up. Never touches dependencies, so a database
  // blip cannot get every instance killed by the orchestrator.
  app.get("/healthz", async () => ({ status: "ok" }));

  // Readiness: this instance can actually serve. Dependency failures belong
  // here, where they remove one instance from rotation instead.
  app.get("/readyz", async (_request, reply) => {
    const checks: Record<string, string> = {};
    let ready = true;

    for (const [name, check] of [
      ["database", () => options.store.ping()],
      ["cache", () => options.cache.ping()],
    ] as const) {
      try {
        await check();
        checks[name] = "ok";
      } catch (err) {
        checks[name] = err instanceof Error ? err.message : "unavailable";
        // Redis is coordination only; the service still answers correctly
        // without it, so it must not fail readiness.
        if (name === "database") ready = false;
      }
    }

    return reply.status(ready ? 200 : 503).send({ ready, checks });
  });
}

function registerMetrics(app: FastifyInstance, metrics: Metrics): void {
  app.get("/metrics", async (_request, reply) => {
    void reply.type("text/plain; version=0.0.4");
    return metrics.render();
  });
}

const CREATE_CAMPAIGN_SCHEMA = {
  body: {
    type: "object",
    required: ["name", "rule", "startsAt", "endsAt"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 200 },
      rule: { type: "object" },
      limits: { type: "object" },
      startsAt: { type: "string", format: "date-time" },
      endsAt: { type: "string", format: "date-time" },
    },
  },
} as const;

function registerCampaigns(app: FastifyInstance, options: AppOptions): void {
  app.post("/v1/campaigns", { schema: CREATE_CAMPAIGN_SCHEMA }, async (request, reply) => {
    const project = projectOf(request);
    const body = request.body as {
      name: string;
      rule: unknown;
      limits?: Record<string, unknown>;
      startsAt: string;
      endsAt: string;
    };

    // Validation happens before anything is written, so an invalid rule can
    // never reach the evaluator through a stored campaign.
    const rule = validateRule(body.rule);

    const startsAt = new Date(body.startsAt);
    const endsAt = new Date(body.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      throw ApiError.badRequest("startsAt and endsAt must be ISO-8601 timestamps");
    }
    if (endsAt <= startsAt) {
      throw ApiError.badRequest("endsAt must be after startsAt");
    }

    const campaign: Campaign = {
      id: newId("cmp"),
      projectId: project.id,
      name: body.name,
      rule,
      ruleHash: ruleHash(rule),
      limits: body.limits ? parseLimits(body.limits) : null,
      startsAt,
      endsAt,
      status: "active",
    };

    await options.store.createCampaign(campaign);
    return reply.status(201).send(serializeCampaign(campaign));
  });

  app.get("/v1/campaigns", async (request) => {
    const project = projectOf(request);
    const campaigns = await options.store.listCampaigns(project.id);
    return { campaigns: campaigns.map(serializeCampaign) };
  });

  app.get("/v1/campaigns/:id", async (request) => {
    const project = projectOf(request);
    const { id } = request.params as { id: string };
    const campaign = await loadCampaign(options.store, project.id, id);
    return serializeCampaign(campaign);
  });
}

const VERIFY_SCHEMA = {
  body: {
    type: "object",
    required: ["wallet", "campaignId"],
    additionalProperties: false,
    properties: {
      wallet: { type: "string", minLength: 1, maxLength: 100 },
      campaignId: { type: "string", minLength: 1, maxLength: 100 },
    },
  },
} as const;

function registerVerify(
  app: FastifyInstance,
  options: AppOptions,
  metrics: Metrics,
  now: () => number,
): void {
  app.post("/v1/verify", { schema: VERIFY_SCHEMA }, async (request) => {
    const project = projectOf(request);
    const body = request.body as { wallet: string; campaignId: string };
    const campaign = await loadCampaign(options.store, project.id, body.campaignId);

    const startedAt = now();
    try {
      const result = await options.verifier.verify({
        projectId: project.id,
        campaign,
        wallet: body.wallet,
      });

      metrics.observe(METRIC.verifyDuration, (now() - startedAt) / 1_000, {
        cached: String(result.cached),
      });
      metrics.increment(METRIC.verifyTotal, { eligible: String(result.eligible) });
      if (result.attestation && !result.cached) {
        metrics.increment(METRIC.attestationsIssued, { project: project.id });
      }

      return result;
    } catch (err) {
      metrics.increment(METRIC.verifyTotal, { eligible: "error" });
      throw err;
    }
  });
}

function registerKeys(app: FastifyInstance, options: AppOptions): void {
  // Public keys for offline verification. Retired keys stay published so
  // attestations already in the wild keep verifying after a rotation.
  app.get("/v1/keys", async (request) => {
    const project = projectOf(request);
    const keys = await options.store.listSigningKeys(project.id);
    return {
      keys: keys.map((key) => ({
        id: key.id,
        publicKey: key.publicKey,
        algorithm: "ed25519",
        createdAt: key.createdAt.toISOString(),
        retiredAt: key.retiredAt?.toISOString() ?? null,
      })),
    };
  });
}

function registerActivity(app: FastifyInstance, options: AppOptions): void {
  app.get("/v1/wallets/:wallet/activity", async () => {
    // Deliberately not implemented in this phase. Returning an empty list
    // would look like "this wallet has no activity", which is exactly the
    // wrong thing to tell someone debugging a failed claim.
    throw new ApiError(
      501,
      "NOT_IMPLEMENTED",
      "Activity inspection is not available yet; use the decode CLI in the meantime",
      { retryable: false },
    );
  });
}

async function loadCampaign(
  store: Store,
  projectId: string,
  campaignId: string,
): Promise<Campaign> {
  const campaign = await store.getCampaign(campaignId);
  // A campaign belonging to another project is reported as missing rather than
  // forbidden, so the endpoint cannot be used to probe for valid ids.
  if (!campaign || campaign.projectId !== projectId) {
    throw ApiError.notFound(`Campaign ${campaignId}`);
  }
  return campaign;
}

function parseLimits(input: Record<string, unknown>): AntiAbuseLimits {
  const limits: Record<string, unknown> = {};

  if (input["maxRewardableVolumePerWallet"] !== undefined) {
    const value = input["maxRewardableVolumePerWallet"];
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
      throw ApiError.badRequest(
        "limits.maxRewardableVolumePerWallet must be a decimal string of token units",
      );
    }
    limits["maxRewardableVolumePerWallet"] = BigInt(value);
  }

  for (const key of ["minInterval", "minWalletAge"]) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw ApiError.badRequest(`limits.${key} must be a duration such as "1h"`);
    }
    limits[key] = value;
  }

  for (const key of Object.keys(input)) {
    if (!["maxRewardableVolumePerWallet", "minInterval", "minWalletAge"].includes(key)) {
      throw ApiError.badRequest(`limits.${key} is not a known limit`);
    }
  }

  return limits as AntiAbuseLimits;
}

function serializeCampaign(campaign: Campaign) {
  return {
    id: campaign.id,
    name: campaign.name,
    rule: campaign.rule,
    ruleHash: campaign.ruleHash,
    limits: campaign.limits
      ? Object.fromEntries(
          Object.entries(campaign.limits).map(([k, v]) => [
            k,
            typeof v === "bigint" ? v.toString() : v,
          ]),
        )
      : null,
    startsAt: campaign.startsAt.toISOString(),
    endsAt: campaign.endsAt.toISOString(),
    status: campaign.status,
  };
}
