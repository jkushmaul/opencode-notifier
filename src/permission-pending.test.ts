import { describe, test, expect } from "bun:test"
import { getPermissionIDFromEvent, isPermissionStillPending } from "./index"

describe("getPermissionIDFromEvent", () => {
  test("reads data.id", () => {
    expect(getPermissionIDFromEvent({ data: { id: "per_123" } })).toBe("per_123")
  })

  test("reads data.request.id", () => {
    expect(getPermissionIDFromEvent({ data: { request: { id: "per_456" } } })).toBe("per_456")
  })

  test("returns null when no id is present", () => {
    expect(getPermissionIDFromEvent({ data: {} })).toBe(null)
    expect(getPermissionIDFromEvent({})).toBe(null)
  })
})

describe("isPermissionStillPending", () => {
  const mockCtx = (pendingIds: string[]) => ({
    permission: { list: async () => pendingIds.map((id) => ({ id })) },
  })

  test("true when the request is still pending", async () => {
    await expect(isPermissionStillPending(mockCtx(["per_1", "per_2"]), "ses_1", "per_2")).resolves.toBe(true)
  })

  test("false when the request was auto-approved (no longer pending)", async () => {
    await expect(isPermissionStillPending(mockCtx(["per_1"]), "ses_1", "per_2")).resolves.toBe(false)
    await expect(isPermissionStillPending(mockCtx([]), "ses_1", "per_2")).resolves.toBe(false)
  })

  test("fails open on every lookup failure", async () => {
    const badCtx = { permission: { list: async () => { throw new Error("down") } } }
    await expect(isPermissionStillPending(badCtx, "ses_1", "per_1")).resolves.toBe(true)
  })

  test("fails open when no sessionID is provided", async () => {
    await expect(isPermissionStillPending(mockCtx(["per_1"]), "", "per_1")).resolves.toBe(true)
    await expect(isPermissionStillPending(mockCtx(["per_1"]), null as any, "per_1")).resolves.toBe(true)
  })

  test("handles array response shape", async () => {
    const ctx = { permission: { list: async () => [{ id: "per_3" }] } }
    await expect(isPermissionStillPending(ctx, "ses_1", "per_3")).resolves.toBe(true)
    await expect(isPermissionStillPending(ctx, "ses_1", "per_other")).resolves.toBe(false)
  })
})
