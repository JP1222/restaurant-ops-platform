import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import type { Prisma, PrismaClient } from "@rop/db-auth";

export type WebAuthnCredentialSummary = {
  credentialId: string;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: string;
  backedUp: boolean;
  transports: AuthenticatorTransportFuture[];
};

type StoredCredentialRecord = Awaited<ReturnType<PrismaClient["webAuthnCredential"]["findUnique"]>>;

function transportList(value: Prisma.JsonValue | null | undefined): AuthenticatorTransportFuture[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is AuthenticatorTransportFuture => typeof item === "string");
}

function toCredentialSummary(record: {
  credentialId: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  deviceType: string;
  backedUp: boolean;
  transports: Prisma.JsonValue | null;
}): WebAuthnCredentialSummary {
  return {
    credentialId: record.credentialId,
    createdAt: record.createdAt.toISOString(),
    lastUsedAt: record.lastUsedAt ? record.lastUsedAt.toISOString() : null,
    deviceType: record.deviceType,
    backedUp: record.backedUp,
    transports: transportList(record.transports)
  };
}

export async function getPasskeyCount(prisma: PrismaClient, accountId: string) {
  return prisma.webAuthnCredential.count({
    where: {
      accountId
    }
  });
}

export async function listPasskeys(prisma: PrismaClient, accountId: string) {
  const credentials = await prisma.webAuthnCredential.findMany({
    where: {
      accountId
    },
    orderBy: {
      createdAt: "asc"
    },
    select: {
      credentialId: true,
      createdAt: true,
      lastUsedAt: true,
      deviceType: true,
      backedUp: true,
      transports: true
    }
  });

  return credentials.map(toCredentialSummary);
}

export async function savePasskeyCredential(
  prisma: PrismaClient,
  input: {
    accountId: string;
    credentialId: string;
    webauthnUserId: string;
    publicKey: Uint8Array;
    counter: number;
    deviceType: string;
    backedUp: boolean;
    transports: AuthenticatorTransportFuture[];
  }
) {
  const data: Prisma.WebAuthnCredentialUncheckedCreateInput = {
    accountId: input.accountId,
    credentialId: input.credentialId,
    webauthnUserId: input.webauthnUserId,
    publicKey: Buffer.from(input.publicKey),
    counter: input.counter,
    deviceType: input.deviceType,
    backedUp: input.backedUp
  };

  if (input.transports.length > 0) {
    data.transports = input.transports as Prisma.InputJsonValue;
  }

  return prisma.webAuthnCredential.create({
    data
  });
}

export async function deletePasskey(prisma: PrismaClient, accountId: string, credentialId: string) {
  const deleted = await prisma.webAuthnCredential.deleteMany({
    where: {
      accountId,
      credentialId
    }
  });
  return deleted.count > 0;
}

export async function findCredentialByCredentialId(prisma: PrismaClient, credentialId: string) {
  return prisma.webAuthnCredential.findUnique({
    where: {
      credentialId
    },
    include: {
      account: true
    }
  });
}

export async function updateCredentialUsage(
  prisma: PrismaClient,
  credentialId: string,
  input: {
    counter: number;
    deviceType: string;
    backedUp: boolean;
    lastUsedAt: Date;
  }
) {
  return prisma.webAuthnCredential.update({
    where: {
      credentialId
    },
    data: {
      counter: input.counter,
      deviceType: input.deviceType,
      backedUp: input.backedUp,
      lastUsedAt: input.lastUsedAt
    }
  });
}

export function toWebAuthnCredential(record: StoredCredentialRecord) {
  if (!record) {
    return null;
  }

  return {
    id: record.credentialId,
    publicKey: new Uint8Array(record.publicKey),
    counter: record.counter,
    transports: transportList(record.transports)
  };
}
