import type { AppServices } from "../lib/services.js";
import { resolveNightlyResetSettings } from "../lib/board-settings.js";

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  ) as Record<string, number>;

  const read = (key: string) => values[key] ?? 0;

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute")
  };
}

function zonedDateKey(date: Date, timeZone: string) {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function shouldRunNightlyReset(
  now: Date,
  lastResetAt: Date | null | undefined,
  timeZone: string,
  resetHour: number,
  resetMinute = 0
) {
  const nowParts = zonedParts(now, timeZone);
  if (nowParts.hour < resetHour) {
    return false;
  }

  if (nowParts.hour === resetHour && nowParts.minute < resetMinute) {
    return false;
  }

  if (!lastResetAt) {
    return true;
  }

  return zonedDateKey(now, timeZone) !== zonedDateKey(lastResetAt, timeZone);
}

export async function clearMerchantOrderData(services: AppServices, merchantId: string, resetAt = new Date()) {
  await services.queue.clearForMerchant(merchantId);

  await services.prisma.$transaction(async (tx) => {
    await tx.kdsTicket.deleteMany({
      where: { merchantId }
    });

    await tx.cloverOrder.deleteMany({
      where: { merchantId }
    });

    await tx.cloverWebhookEvent.deleteMany({
      where: { merchantId }
    });

    await tx.kdsProviderEvent.deleteMany({
      where: { merchantId }
    });

    await tx.kdsRealtimeEvent.deleteMany({
      where: { merchantId }
    });

    await tx.deadLetterJob.deleteMany({
      where: { merchantId }
    });

    await tx.cloverMerchant.update({
      where: { id: merchantId },
      data: {
        resetCutoffAt: resetAt,
        lastReconciledAt: resetAt
      }
    });
  });

  await services.hub.publishSnapshotRequired(merchantId, "nightly-reset");
}

export async function runNightlyResetOnce(services: AppServices) {
  const merchants = await services.prisma.cloverMerchant.findMany({
    where: {
      authStatus: "ACTIVE"
    },
    select: {
      id: true,
      resetCutoffAt: true,
      filter: {
        select: {
          boardSettings: true
        }
      }
    }
  });

  const now = new Date();
  for (const merchant of merchants) {
    const resetSettings = resolveNightlyResetSettings(merchant.filter, services.config);
    try {
      if (!resetSettings.enabled) {
        continue;
      }

      if (
        !shouldRunNightlyReset(
          now,
          merchant.resetCutoffAt,
          resetSettings.timeZone,
          resetSettings.hour,
          resetSettings.minute
        )
      ) {
        continue;
      }

      await clearMerchantOrderData(services, merchant.id, now);
    } catch (error) {
      await services.prisma.deadLetterJob.create({
        data: {
          merchantId: merchant.id,
          jobType: "nightly-reset",
          reason: error instanceof Error ? error.message : "Unknown nightly reset failure",
          payload: {
            merchantId: merchant.id,
            resetHour: resetSettings.hour,
            resetMinute: resetSettings.minute,
            resetTimezone: resetSettings.timeZone,
            attemptedAt: now.toISOString()
          }
        }
      });
    }
  }
}
