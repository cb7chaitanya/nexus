import { ApiError } from "@raas/shared";
import { describe, expect, it } from "vitest";

import { assertCanRemoveMember, assertCanSetRole, hasAtLeastRole } from "./roles.js";

describe("hasAtLeastRole", () => {
  it("ranks OWNER > ADMIN > MEMBER", () => {
    expect(hasAtLeastRole("OWNER", "ADMIN")).toBe(true);
    expect(hasAtLeastRole("ADMIN", "OWNER")).toBe(false);
    expect(hasAtLeastRole("ADMIN", "MEMBER")).toBe(true);
    expect(hasAtLeastRole("MEMBER", "ADMIN")).toBe(false);
  });

  it("is true when equal", () => {
    expect(hasAtLeastRole("ADMIN", "ADMIN")).toBe(true);
  });
});

describe("assertCanSetRole", () => {
  it("allows OWNER to promote a MEMBER to ADMIN", () => {
    expect(() =>
      assertCanSetRole({
        callerRole: "OWNER",
        targetCurrentRole: "MEMBER",
        newRole: "ADMIN",
        isLastOwner: false,
      }),
    ).not.toThrow();
  });

  it("allows ADMIN to promote a MEMBER to ADMIN", () => {
    expect(() =>
      assertCanSetRole({
        callerRole: "ADMIN",
        targetCurrentRole: "MEMBER",
        newRole: "ADMIN",
        isLastOwner: false,
      }),
    ).not.toThrow();
  });

  it("allows ADMIN to demote another ADMIN to MEMBER", () => {
    expect(() =>
      assertCanSetRole({
        callerRole: "ADMIN",
        targetCurrentRole: "ADMIN",
        newRole: "MEMBER",
        isLastOwner: false,
      }),
    ).not.toThrow();
  });

  it("forbids an ADMIN from granting OWNER", () => {
    expect(() =>
      assertCanSetRole({
        callerRole: "ADMIN",
        targetCurrentRole: "MEMBER",
        newRole: "OWNER",
        isLastOwner: false,
      }),
    ).toThrow(ApiError);
  });

  it("allows OWNER to grant OWNER", () => {
    expect(() =>
      assertCanSetRole({
        callerRole: "OWNER",
        targetCurrentRole: "MEMBER",
        newRole: "OWNER",
        isLastOwner: false,
      }),
    ).not.toThrow();
  });

  it("forbids an ADMIN from demoting an OWNER", () => {
    expect(() =>
      assertCanSetRole({
        callerRole: "ADMIN",
        targetCurrentRole: "OWNER",
        newRole: "ADMIN",
        isLastOwner: false,
      }),
    ).toThrow(ApiError);
  });

  it("allows OWNER to demote another OWNER when not the last one", () => {
    expect(() =>
      assertCanSetRole({
        callerRole: "OWNER",
        targetCurrentRole: "OWNER",
        newRole: "ADMIN",
        isLastOwner: false,
      }),
    ).not.toThrow();
  });

  it("forbids demoting the last remaining owner, even by another owner", () => {
    expect(() =>
      assertCanSetRole({
        callerRole: "OWNER",
        targetCurrentRole: "OWNER",
        newRole: "ADMIN",
        isLastOwner: true,
      }),
    ).toThrow(ApiError);
  });

  it("the last-owner check does not block a no-op OWNER -> OWNER change", () => {
    expect(() =>
      assertCanSetRole({
        callerRole: "OWNER",
        targetCurrentRole: "OWNER",
        newRole: "OWNER",
        isLastOwner: true,
      }),
    ).not.toThrow();
  });
});

describe("assertCanRemoveMember", () => {
  it("allows a MEMBER to remove themselves", () => {
    expect(() =>
      assertCanRemoveMember({
        callerRole: "MEMBER",
        targetRole: "MEMBER",
        isSelf: true,
        isLastOwner: false,
      }),
    ).not.toThrow();
  });

  it("forbids a MEMBER from removing someone else", () => {
    expect(() =>
      assertCanRemoveMember({
        callerRole: "MEMBER",
        targetRole: "MEMBER",
        isSelf: false,
        isLastOwner: false,
      }),
    ).toThrow(ApiError);
  });

  it("allows ADMIN to remove a MEMBER", () => {
    expect(() =>
      assertCanRemoveMember({
        callerRole: "ADMIN",
        targetRole: "MEMBER",
        isSelf: false,
        isLastOwner: false,
      }),
    ).not.toThrow();
  });

  it("forbids ADMIN from removing an OWNER", () => {
    expect(() =>
      assertCanRemoveMember({
        callerRole: "ADMIN",
        targetRole: "OWNER",
        isSelf: false,
        isLastOwner: false,
      }),
    ).toThrow(ApiError);
  });

  it("allows OWNER to remove another OWNER when not the last one", () => {
    expect(() =>
      assertCanRemoveMember({
        callerRole: "OWNER",
        targetRole: "OWNER",
        isSelf: false,
        isLastOwner: false,
      }),
    ).not.toThrow();
  });

  it("forbids removing the last owner, even by themselves", () => {
    expect(() =>
      assertCanRemoveMember({
        callerRole: "OWNER",
        targetRole: "OWNER",
        isSelf: true,
        isLastOwner: true,
      }),
    ).toThrow(ApiError);
  });

  it("forbids removing the last owner, even by another owner", () => {
    expect(() =>
      assertCanRemoveMember({
        callerRole: "OWNER",
        targetRole: "OWNER",
        isSelf: false,
        isLastOwner: true,
      }),
    ).toThrow(ApiError);
  });
});
