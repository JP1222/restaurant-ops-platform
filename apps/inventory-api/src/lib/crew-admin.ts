import { randomUUID } from "node:crypto";

import { hashPin, pinLookupHash } from "@rop/auth/crew";
import type { PrismaClient } from "@rop/db-inventory";
import type {
  InventoryEmployee,
  InventoryEmployeeCreateRequest,
  InventoryEmployeeUpdateRequest
} from "@rop/contracts";

import * as serialize from "./serialize.js";

const DEFAULT_COLOR = "#64748b";

// Thrown when a PIN collides with another employee. `pin_lookup` is the only
// unique constraint on the table (besides the generated id), so any P2002 here
// is a PIN clash.
export class PinConflictError extends Error {
  constructor() {
    super("PIN already in use");
    this.name = "PinConflictError";
  }
}

function isPinConflict(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0] ?? "").join("");
  return (letters || name.slice(0, 2)).toUpperCase();
}

// `locationId` (optional) scopes the roster to one store. The backoffice
// StoreSwitcher forwards the active store as `?location=`; without it the roster
// spans all stores (the manager's "All stores" / single-store view).
export async function listEmployees(
  prisma: PrismaClient,
  locationId?: string
): Promise<InventoryEmployee[]> {
  const rows = await prisma.inventoryEmployee.findMany({
    ...(locationId ? { where: { locationId } } : {}),
    orderBy: [{ active: "desc" }, { name: "asc" }]
  });
  return rows.map(serialize.toEmployeeAdmin);
}

export async function createEmployee(
  prisma: PrismaClient,
  pepper: string,
  input: InventoryEmployeeCreateRequest,
  // The store this hire belongs to. This is what scopes their crew session — and
  // thus every inventory read/write they make (locationFor() in routes/inventory.ts)
  // — to their store, so it must be set at create time, not left at the column
  // default that would silently file store #2's crew under store #1.
  locationId: string
): Promise<InventoryEmployee> {
  const pinHash = await hashPin(input.pin);
  const pinLookup = pinLookupHash(input.pin, pepper);
  try {
    const row = await prisma.inventoryEmployee.create({
      data: {
        id: `emp-${randomUUID()}`,
        locationId,
        name: input.name,
        role: input.role,
        shift: input.shift,
        initials: input.initials?.toUpperCase() ?? deriveInitials(input.name),
        color: input.color ?? DEFAULT_COLOR,
        pinHash,
        pinLookup,
        active: true
      }
    });
    return serialize.toEmployeeAdmin(row);
  } catch (err) {
    if (isPinConflict(err)) {
      throw new PinConflictError();
    }
    throw err;
  }
}

export async function updateEmployee(
  prisma: PrismaClient,
  id: string,
  input: InventoryEmployeeUpdateRequest
): Promise<InventoryEmployee | null> {
  const existing = await prisma.inventoryEmployee.findUnique({ where: { id } });
  if (!existing) {
    return null;
  }
  const row = await prisma.inventoryEmployee.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.role !== undefined && { role: input.role }),
      ...(input.shift !== undefined && { shift: input.shift }),
      ...(input.initials !== undefined && { initials: input.initials.toUpperCase() }),
      ...(input.color !== undefined && { color: input.color }),
      ...(input.active !== undefined && { active: input.active })
    }
  });
  return serialize.toEmployeeAdmin(row);
}

export async function setEmployeePin(
  prisma: PrismaClient,
  pepper: string,
  id: string,
  pin: string
): Promise<InventoryEmployee | null> {
  const existing = await prisma.inventoryEmployee.findUnique({ where: { id } });
  if (!existing) {
    return null;
  }
  const pinHash = await hashPin(pin);
  const pinLookup = pinLookupHash(pin, pepper);
  try {
    const row = await prisma.inventoryEmployee.update({
      where: { id },
      data: { pinHash, pinLookup }
    });
    return serialize.toEmployeeAdmin(row);
  } catch (err) {
    if (isPinConflict(err)) {
      throw new PinConflictError();
    }
    throw err;
  }
}
