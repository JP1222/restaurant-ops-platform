import type { FastifyInstance } from "fastify";

import {
  UpdatePrefsRequestSchema,
  type MinSeverity,
  type NotificationCategory,
  type NotificationPrefs
} from "@rop/contracts";

import { requireOperator } from "../lib/operator.js";
import type { AppServices } from "../lib/services.js";
import { DEFAULT_CATEGORY_TOGGLES, DEFAULT_QUIET } from "../domain/defaults.js";
import { assemblePrefs } from "../domain/map.js";

type CategoryData = { inapp?: boolean; email?: boolean; push?: boolean; minSeverity?: MinSeverity };

export async function registerPrefsRoutes(app: FastifyInstance, services: AppServices) {
  const { prisma } = services;

  async function loadPrefs(operator: string): Promise<NotificationPrefs> {
    const pref = await prisma.notificationPref.findUnique({
      where: { operatorId: operator },
      include: { categories: true }
    });
    return assemblePrefs(pref, pref?.categories ?? []);
  }

  // Returns the operator's stored preferences, or the suite defaults if they
  // have never saved one (the response always carries every category).
  app.get("/api/notifications/prefs", async (request, reply): Promise<NotificationPrefs | void> => {
    const op = requireOperator(request, reply);
    if (!op) return;
    return loadPrefs(op);
  });

  // Partial patch — only the changed cells travel. Upserts the quiet-hours row
  // and any touched category row, then returns the fully-assembled prefs.
  app.patch("/api/notifications/prefs", async (request, reply): Promise<NotificationPrefs | void> => {
    const op = requireOperator(request, reply);
    if (!op) return;
    const parsed = UpdatePrefsRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid preferences", issues: parsed.error.issues });
    }
    const patch = parsed.data;

    const quietData: { quiet?: boolean; quietFrom?: string; quietTo?: string } = {};
    if (patch.quiet !== undefined) quietData.quiet = patch.quiet;
    if (patch.quietFrom !== undefined) quietData.quietFrom = patch.quietFrom;
    if (patch.quietTo !== undefined) quietData.quietTo = patch.quietTo;

    // The category rows FK to the pref row, so it must exist first.
    await prisma.notificationPref.upsert({
      where: { operatorId: op },
      create: { operatorId: op, ...DEFAULT_QUIET, ...quietData },
      update: quietData
    });

    if (patch.cats) {
      const upserts = Object.entries(patch.cats)
        .filter(([, cell]) => cell !== undefined)
        .map(([rawCategory, cell]) => {
          const category = rawCategory as NotificationCategory;
          const c = cell as NonNullable<typeof cell>;
          const data: CategoryData = {};
          if (c.inapp !== undefined) data.inapp = c.inapp;
          if (c.email !== undefined) data.email = c.email;
          if (c.push !== undefined) data.push = c.push;
          if (c.sev !== undefined) data.minSeverity = c.sev;
          const def = DEFAULT_CATEGORY_TOGGLES[category];
          return prisma.notificationCategoryPref.upsert({
            where: { operatorId_category: { operatorId: op, category } },
            create: {
              operatorId: op,
              category,
              inapp: def.inapp,
              email: def.email,
              push: def.push,
              minSeverity: def.sev,
              ...data
            },
            update: data
          });
        });
      if (upserts.length > 0) await prisma.$transaction(upserts);
    }

    return loadPrefs(op);
  });
}
