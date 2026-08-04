import { Redis } from "ioredis";
import { createPrismaClient } from "@rop/db-kds";
import { createPrismaClient as createAuthPrismaClient } from "@rop/db-auth";
import { type AppConfig } from "../config.js";
import { CloverClient } from "./clover-client.js";
import { CloverEcommerceClient } from "./clover-ecommerce.js";
import { CloverRateLimiter } from "./clover-rate-limiter.js";
import { DeliverectClient } from "./deliverect-client.js";
import { SquareClient } from "./square-client.js";
import { SyncQueue } from "./queue.js";
import { RealtimeHub } from "./realtime-hub.js";
import { createWebAuthService } from "./web-auth.js";

export function createServices(config: AppConfig) {
  const prisma = createPrismaClient(config.databaseUrl);
  const prismaAuth = createAuthPrismaClient(config.databaseUrl);
  const redisPublisher = new Redis(config.redisUrl);
  const redisSubscriber = new Redis(config.redisUrl);
  const queue = new SyncQueue(config);
  const rateLimiter = new CloverRateLimiter(redisPublisher, config);
  const hub = new RealtimeHub(prisma, redisPublisher, redisSubscriber);
  const clover = new CloverClient(prisma, config, rateLimiter);
  const cloverEcommerce = new CloverEcommerceClient(config);
  const deliverect = new DeliverectClient(prisma, config);
  const square = new SquareClient();
  const auth = createWebAuthService(prismaAuth, redisPublisher, config);

  return {
    prisma,
    prismaAuth,
    redisPublisher,
    redisSubscriber,
    queue,
    hub,
    clover,
    cloverEcommerce,
    rateLimiter,
    deliverect,
    square,
    auth,
    config
  };
}

export type AppServices = ReturnType<typeof createServices>;
