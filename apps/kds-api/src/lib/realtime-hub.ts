import { randomUUID } from "node:crypto";
import type { RealtimeEvent } from "@rop/contracts";
import type { Prisma, PrismaClient } from "@rop/db-kds";
import type { Redis } from "ioredis";
import type { RawData, WebSocket } from "ws";
import { toDisplayEvent } from "./display.js";

export type SnapshotRequiredEvent = {
  id?: string;
  type: "snapshot.required";
  merchantId: string;
  occurredAt: string;
  seq?: number;
  publishedAt?: string;
  reason: string;
};

export type RealtimeMessage = RealtimeEvent | SnapshotRequiredEvent;

function withPublishedTrace<TEvent extends RealtimeMessage>(event: TEvent, publishedAt: string): TEvent {
  if (!("trace" in event) || !event.trace) {
    return event;
  }

  return {
    ...event,
    trace: {
      ...event.trace,
      realtimePublishedAt: event.trace.realtimePublishedAt ?? publishedAt
    }
  };
}

function channelFor(merchantId: string) {
  return `merchant:${merchantId}:kds`;
}

export class RealtimeHub {
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private readonly displaySockets = new Map<string, Set<WebSocket>>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly publisher: Redis,
    private readonly subscriber: Redis
  ) {}

  async start() {
    await this.subscriber.psubscribe("merchant:*:kds");
    this.subscriber.on("pmessage", (_pattern, channel, payload) => {
      const merchantId = channel.split(":")[1];
      if (!merchantId) {
        return;
      }
      const event = JSON.parse(payload) as RealtimeMessage;
      this.broadcastLocal(merchantId, event);
    });
  }

  attach(merchantId: string, socket: WebSocket) {
    const bucket = this.sockets.get(merchantId) ?? new Set<WebSocket>();
    bucket.add(socket);
    this.sockets.set(merchantId, bucket);

    socket.on("close", () => {
      const current = this.sockets.get(merchantId);
      current?.delete(socket);
      if (current && current.size === 0) {
        this.sockets.delete(merchantId);
      }
    });

    socket.on("message", (raw: RawData) => {
      if (raw.toString() === "ping") {
        socket.send("pong");
      }
    });
  }

  attachDisplay(merchantId: string, socket: WebSocket) {
    const bucket = this.displaySockets.get(merchantId) ?? new Set<WebSocket>();
    bucket.add(socket);
    this.displaySockets.set(merchantId, bucket);

    socket.on("close", () => {
      const current = this.displaySockets.get(merchantId);
      current?.delete(socket);
      if (current && current.size === 0) {
        this.displaySockets.delete(merchantId);
      }
    });

    socket.on("message", (raw: RawData) => {
      if (raw.toString() === "ping") {
        socket.send("pong");
      }
    });
  }

  async publish(merchantId: string, event: RealtimeEvent) {
    const persisted = await this.persistEvent(merchantId, event);
    await this.publishStoredEvent(persisted.id, merchantId, persisted.event);
    return persisted.event;
  }

  async publishSnapshotRequired(merchantId: string, reason: string) {
    const event: SnapshotRequiredEvent = {
      type: "snapshot.required",
      merchantId,
      occurredAt: new Date().toISOString(),
      reason
    };
    const persisted = await this.persistEvent(merchantId, event);
    await this.publishStoredEvent(persisted.id, merchantId, persisted.event);
    return persisted.event;
  }

  async currentSeq(merchantId: string) {
    const state = await this.prisma.kdsRealtimeState.findUnique({
      where: { merchantId },
      select: { seq: true }
    });
    return Number(state?.seq ?? 0n);
  }

  async dispatchPending(limit = 100) {
    const pending = await this.prisma.kdsRealtimeEvent.findMany({
      where: { publishedAt: null },
      orderBy: [{ createdAt: "asc" }],
      take: limit
    });

    for (const event of pending) {
      await this.publishStoredEvent(event.id, event.merchantId, event.payload as Prisma.JsonObject as RealtimeMessage);
    }

    return pending.length;
  }

  private async persistEvent<TEvent extends RealtimeMessage>(merchantId: string, event: TEvent) {
    const eventId = event.id ?? randomUUID();
    const publishedAt = event.publishedAt ?? new Date().toISOString();

    const persisted = await this.prisma.$transaction(async (tx) => {
      const state = await tx.kdsRealtimeState.upsert({
        where: { merchantId },
        create: {
          merchantId,
          seq: 1n
        },
        update: {
          seq: {
            increment: 1
          }
        }
      });
      const enriched: TEvent = withPublishedTrace({
        ...event,
        id: eventId,
        seq: Number(state.seq),
        publishedAt
      }, publishedAt);

      await tx.kdsRealtimeEvent.create({
        data: {
          id: eventId,
          merchantId,
          seq: state.seq,
          type: event.type,
          payload: enriched as unknown as Prisma.InputJsonValue
        }
      });

      return { id: eventId, event: enriched };
    });

    return persisted;
  }

  private async publishStoredEvent(id: string, merchantId: string, event: RealtimeMessage) {
    await this.publisher.publish(channelFor(merchantId), JSON.stringify(event));
    await this.prisma.kdsRealtimeEvent.updateMany({
      where: {
        id,
        publishedAt: null
      },
      data: {
        publishedAt: event.publishedAt ? new Date(event.publishedAt) : new Date()
      }
    });
  }

  private broadcastLocal(merchantId: string, event: RealtimeMessage) {
    const sockets = this.sockets.get(merchantId);
    if (sockets) {
      for (const socket of sockets) {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(event));
        }
      }
    }

    const displaySockets = this.displaySockets.get(merchantId);
    if (displaySockets) {
      const displayEvent = JSON.stringify(event.type === "snapshot.required" ? event : toDisplayEvent(event));
      for (const socket of displaySockets) {
        if (socket.readyState === socket.OPEN) {
          socket.send(displayEvent);
        }
      }
    }
  }
}
