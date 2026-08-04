import { describe, expect, it } from "vitest";
import { deleteGuardFor } from "@/lib/admin/delete-guard";

const owner = (id: string) => ({ id, role: "OWNER" as const });
const manager = (id: string) => ({ id, role: "MANAGER" as const });

describe("deleteGuardFor", () => {
  it("enables delete for another user when more than one owner remains", () => {
    expect(deleteGuardFor(manager("u2"), { currentUserId: "u1", ownerCount: 2 })).toEqual({
      disabled: false
    });
  });

  it("disables deleting your own account", () => {
    expect(deleteGuardFor(manager("u1"), { currentUserId: "u1", ownerCount: 2 })).toEqual({
      disabled: true,
      reason: "you can't delete your own account"
    });
  });

  it("disables removing the last remaining owner", () => {
    expect(deleteGuardFor(owner("u2"), { currentUserId: "u1", ownerCount: 1 })).toEqual({
      disabled: true,
      reason: "the last Owner can't be removed"
    });
  });

  it("allows removing an owner when another owner remains", () => {
    expect(deleteGuardFor(owner("u2"), { currentUserId: "u1", ownerCount: 2 })).toEqual({
      disabled: false
    });
  });

  it("prefers the self reason when both self and last-owner would apply", () => {
    // The current user is the sole owner: the self-delete check is evaluated
    // first, so its reason wins over the last-owner one.
    expect(deleteGuardFor(owner("u1"), { currentUserId: "u1", ownerCount: 1 })).toEqual({
      disabled: true,
      reason: "you can't delete your own account"
    });
  });

  it("does not flag self when there is no current user in context", () => {
    expect(deleteGuardFor(manager("u1"), { ownerCount: 2 })).toEqual({ disabled: false });
  });
});
