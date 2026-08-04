import type { FastifyInstance } from "fastify";
import {
  InventoryEmployeeCreateRequestSchema,
  InventoryEmployeePinResetRequestSchema,
  InventoryEmployeeUpdateRequestSchema,
  InventorySecuritySettingsSaveSchema
} from "@rop/contracts";

import * as crewAdmin from "../lib/crew-admin.js";
import * as store from "../lib/inventory-store.js";
import type { AppServices } from "../lib/services.js";

// Manager-only crew management. The `/api/admin/*` bearer guard in app.ts gates
// every route here; a crew session never reaches these handlers.
export async function registerCrewAdminRoutes(app: FastifyInstance, services: AppServices) {
  const { prisma, config } = services;

  // Floor-auth security settings (crew IP allowlist). Manager-only (bearer), edited
  // from Backoffice. The allowlist is enforced in crew-web, not here — inventory-api
  // is internal-only and no longer sees the cook's real IP.
  app.get("/api/admin/crew/security", async () => store.getSecuritySettings(prisma));

  app.put("/api/admin/crew/security", async (request, reply) => {
    const parsed = InventorySecuritySettingsSaveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid security settings", details: parsed.error.issues });
    }
    return store.saveSecuritySettings(prisma, parsed.data);
  });

  app.get<{ Querystring: { location?: string } }>("/api/admin/crew", async (request) => ({
    employees: await crewAdmin.listEmployees(prisma, request.query.location)
  }));

  app.post<{ Querystring: { location?: string } }>("/api/admin/crew", async (request, reply) => {
    if (!config.crewPinPepper) {
      return reply.code(503).send({ error: "Crew auth not configured" });
    }
    const parsed = InventoryEmployeeCreateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid employee" });
    }
    // New hires belong to the store the manager is currently managing (the
    // StoreSwitcher forwards it as ?location=); fall back to the single-store
    // default when none is selected. Scopes the hire's location at creation.
    const locationId = request.query.location ?? store.DEFAULT_LOCATION_ID;
    try {
      const employee = await crewAdmin.createEmployee(
        prisma,
        config.crewPinPepper,
        parsed.data,
        locationId
      );
      return reply.code(201).send({ employee });
    } catch (err) {
      if (err instanceof crewAdmin.PinConflictError) {
        return reply.code(409).send({ error: "PIN already in use" });
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/admin/crew/:id", async (request, reply) => {
    const parsed = InventoryEmployeeUpdateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid update" });
    }
    const employee = await crewAdmin.updateEmployee(prisma, request.params.id, parsed.data);
    if (!employee) {
      return reply.code(404).send({ error: "Employee not found" });
    }
    return { employee };
  });

  app.post<{ Params: { id: string } }>("/api/admin/crew/:id/pin", async (request, reply) => {
    if (!config.crewPinPepper) {
      return reply.code(503).send({ error: "Crew auth not configured" });
    }
    const parsed = InventoryEmployeePinResetRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid PIN" });
    }
    try {
      const employee = await crewAdmin.setEmployeePin(
        prisma,
        config.crewPinPepper,
        request.params.id,
        parsed.data.pin
      );
      if (!employee) {
        return reply.code(404).send({ error: "Employee not found" });
      }
      return { employee };
    } catch (err) {
      if (err instanceof crewAdmin.PinConflictError) {
        return reply.code(409).send({ error: "PIN already in use" });
      }
      throw err;
    }
  });
}
