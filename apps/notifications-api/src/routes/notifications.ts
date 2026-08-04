import type { FastifyInstance, FastifyReply } from "fastify";

import {
  AiInvestigationSchema,
  ApplyActionRequestSchema,
  IngestNotificationRequestSchema,
  SnoozeRequestSchema,
  type ApplyActionResult,
  type IngestNotificationResult,
  type NotificationListResponse
} from "@rop/contracts";
import type { Prisma } from "@rop/db-notifications";

import { requireManagerRole, requireOperator } from "../lib/operator.js";
import type { AppServices } from "../lib/services.js";
import { NotificationBus } from "../lib/event-bus.js";
import { isLive, toDto, type StateRow } from "../domain/map.js";

// Postgres unique-violation surfaced by Prisma (P2002). Duck-typed so this stays
// free of an explicit Prisma error-class import.
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

export async function registerNotificationRoutes(app: FastifyInstance, services: AppServices) {
  const { prisma } = services;
  // In-process realtime fanout: ingest publishes, the SSE /stream endpoint
  // subscribes. One bus per app instance (single-process — see event-bus.ts).
  const bus = new NotificationBus();

  // Idempotent upsert of one operator's state for one notification, returned as
  // an un-awaited PrismaPromise so callers can batch it in a $transaction.
  function setState(operator: string, notificationId: string, data: Partial<StateRow>) {
    return prisma.notificationState.upsert({
      where: { notificationId_operatorId: { notificationId, operatorId: operator } },
      create: { notificationId, operatorId: operator, ...data },
      update: data
    });
  }

  async function ensureExists(notificationId: string, reply: FastifyReply): Promise<boolean> {
    const found = await prisma.notification.findUnique({
      where: { id: notificationId },
      select: { id: true }
    });
    if (!found) {
      reply.code(404).send({ error: "Notification not found" });
      return false;
    }
    return true;
  }

  // List — global notifications overlaid with this operator's state, dropping
  // dismissed + actively-snoozed rows. unreadCount is the bell badge's source.
  app.get("/api/notifications", async (request, reply): Promise<NotificationListResponse | void> => {
    const op = requireOperator(request, reply);
    if (!op) return;
    const rows = await prisma.notification.findMany({
      orderBy: { createdAt: "desc" },
      include: { states: { where: { operatorId: op } } }
    });
    const now = Date.now();
    const live = rows.filter((r) => isLive(r.states[0], now));
    const notifications = live.map((r) => toDto(r, r.states[0]));
    return { notifications, unreadCount: notifications.filter((n) => !n.read).length };
  });

  // Realtime stream (SSE) — the operator's live push channel, the successor to the
  // 30s bell poll. Same bearer + operator scoping as the list; each newly-ingested
  // notification arrives as an `event: notification` frame carrying the same DTO the
  // list returns (unread — no per-operator state yet, so the client merges it). A
  // `: ping` heartbeat keeps proxies from idling the long-lived connection out, and
  // the bus subscription is torn down when the client disconnects so listeners never
  // leak. Returns nothing through Fastify — `reply.hijack()` hands us the raw socket.
  app.get("/api/notifications/stream", async (request, reply) => {
    const op = requireOperator(request, reply);
    if (!op) return;

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Tell nginx (and friends) not to buffer the stream, so frames flush at once.
      "X-Accel-Buffering": "no"
    });
    reply.raw.write(": connected\n\n");
    request.log.info({ operator: op }, "notifications SSE stream opened");

    const unsubscribe = bus.subscribe((n) => {
      reply.raw.write(`event: notification\ndata: ${JSON.stringify(n)}\n\n`);
    });
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.on("close", cleanup);
    // A write to an already-broken socket emits 'error' — clean up rather than let it
    // surface as an unhandled stream error.
    reply.raw.on("error", cleanup);
  });

  // Producer ingest — a producer (e.g. inventory-api on an 86 / par breach) creates
  // a notification. NOT operator-scoped (no x-operator-id): a server-to-server
  // producer call, bearer-guarded like the rest of /api/notifications. Idempotent on
  // dedupeKey — a retry or a repeated signal returns the existing row, never a dup.
  app.post(
    "/api/notifications/ingest",
    async (request, reply): Promise<IngestNotificationResult | void> => {
      const parsed = IngestNotificationRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid notification", issues: parsed.error.issues });
      }
      const n = parsed.data;

      if (n.dedupeKey) {
        const existing = await prisma.notification.findUnique({
          where: { dedupeKey: n.dedupeKey },
          select: { id: true }
        });
        if (existing) return reply.send({ id: existing.id, status: "duplicate" });
      }

      const data = {
        severity: n.severity,
        category: n.category,
        categoryLabel: n.categoryLabel,
        icon: n.icon,
        title: n.title,
        detail: n.detail,
        actionLabel: n.action.label,
        actionIcon: n.action.icon,
        actionHref: n.action.href,
        locationId: n.locationId ?? null,
        dedupeKey: n.dedupeKey ?? null,
        // Only set `ai` when present — exactOptionalPropertyTypes rejects an
        // explicit `undefined` for Prisma's optional Json field.
        ...(n.ai !== undefined ? { ai: n.ai as Prisma.InputJsonValue } : {})
      };

      try {
        const created = await prisma.notification.create({ data });
        // Realtime fanout: push the new notification to every connected SSE client.
        // No per-operator state yet, so it maps as unread; the client merges it. An
        // in-process emit can't throw, so it never threatens the 201.
        bus.publish(toDto(created, undefined));
        return reply.code(201).send({ id: created.id, status: "created" });
      } catch (err) {
        // Race: a concurrent ingest with the same dedupeKey won between the check
        // and the insert — treat it as the duplicate it is.
        if (isUniqueViolation(err) && n.dedupeKey) {
          const existing = await prisma.notification.findUnique({
            where: { dedupeKey: n.dedupeKey },
            select: { id: true }
          });
          if (existing) return reply.send({ id: existing.id, status: "duplicate" });
        }
        throw err;
      }
    }
  );

  app.post("/api/notifications/:id/read", async (request, reply) => {
    const op = requireOperator(request, reply);
    if (!op) return;
    const { id } = request.params as { id: string };
    if (!(await ensureExists(id, reply))) return;
    await setState(op, id, { read: true });
    return { ok: true };
  });

  app.post("/api/notifications/:id/dismiss", async (request, reply) => {
    const op = requireOperator(request, reply);
    if (!op) return;
    const { id } = request.params as { id: string };
    if (!(await ensureExists(id, reply))) return;
    await setState(op, id, { dismissedAt: new Date() });
    return { ok: true };
  });

  app.post("/api/notifications/:id/snooze", async (request, reply) => {
    const op = requireOperator(request, reply);
    if (!op) return;
    const { id } = request.params as { id: string };
    const parsed = SnoozeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid snooze", issues: parsed.error.issues });
    }
    const until = new Date(parsed.data.until);
    if (until.getTime() <= Date.now()) {
      return reply.code(400).send({ error: "snooze until must be in the future" });
    }
    if (!(await ensureExists(id, reply))) return;
    await setState(op, id, { snoozedUntil: until });
    return { ok: true };
  });

  // Mark every currently-live notification read for this operator.
  app.post("/api/notifications/read-all", async (request, reply) => {
    const op = requireOperator(request, reply);
    if (!op) return;
    const rows = await prisma.notification.findMany({
      include: { states: { where: { operatorId: op } } }
    });
    const now = Date.now();
    const live = rows.filter((r) => isLive(r.states[0], now) && !(r.states[0]?.read ?? false));
    await prisma.$transaction(live.map((r) => setState(op, r.id, { read: true })));
    return { ok: true, count: live.length };
  });

  // Apply a suggested action — the mutating fix the AI proposes. The UI's
  // two-step confirm is UX; the real gate is here (AGENTS rule 4): manager-only,
  // idempotent on `idempotencyKey`, audit-logged. The actual cross-domain effect
  // (e.g. 86 an item) lands per-action with its producer; today the audit row is
  // the durable record + the idempotency anchor.
  app.post(
    "/api/notifications/:id/actions/apply",
    async (request, reply): Promise<ApplyActionResult | void> => {
      const op = requireOperator(request, reply);
      if (!op) return;
      const role = requireManagerRole(request, reply);
      if (!role) return;

      const { id } = request.params as { id: string };
      const parsed = ApplyActionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid action request", issues: parsed.error.issues });
      }
      const { notificationId, actionId, idempotencyKey } = parsed.data;
      // The path id addresses the notification; the body must agree.
      if (notificationId !== id) {
        return reply.code(400).send({ error: "notificationId does not match the route" });
      }

      const notification = await prisma.notification.findUnique({
        where: { id },
        select: { id: true, ai: true }
      });
      if (!notification) {
        reply.code(404).send({ error: "Notification not found" });
        return;
      }

      // The notification must actually carry this suggested action, and the
      // request's actionId + idempotencyKey must match what the producer attached
      // — so a caller can't mint an arbitrary action against a notification.
      const ai = AiInvestigationSchema.safeParse(notification.ai);
      const block = ai.success && ai.data.block?.kind === "action" ? ai.data.block : null;
      if (!block) {
        return reply.code(409).send({ error: "Notification has no suggested action" });
      }
      if (block.action.id !== actionId || block.action.idempotencyKey !== idempotencyKey) {
        return reply
          .code(409)
          .send({ error: "Action does not match the notification's suggested action" });
      }

      // Idempotent: the UNIQUE idempotencyKey makes a repeated confirm a no-op.
      // Insert the audit row; a duplicate key (already applied) returns
      // already_applied instead of double-applying.
      try {
        await prisma.notificationActionAudit.create({
          data: { notificationId: id, actionId, idempotencyKey, operatorId: op, operatorRole: role }
        });
        return { status: "applied", doneLabel: block.action.doneLabel };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { status: "already_applied", doneLabel: block.action.doneLabel };
        }
        throw err;
      }
    }
  );

  // Archive (dismiss) every live notification this operator has already read.
  app.post("/api/notifications/archive-read", async (request, reply) => {
    const op = requireOperator(request, reply);
    if (!op) return;
    const rows = await prisma.notification.findMany({
      include: { states: { where: { operatorId: op } } }
    });
    const now = Date.now();
    const readLive = rows.filter((r) => isLive(r.states[0], now) && (r.states[0]?.read ?? false));
    const dismissedAt = new Date();
    await prisma.$transaction(readLive.map((r) => setState(op, r.id, { dismissedAt })));
    return { ok: true, count: readLive.length };
  });
}
