import { describe, it, expect } from "vitest";
import { issueDashboardSession, verifyDashboardSession } from "./dashboard-session";

describe("dashboard session tokens", () => {
  it("round-trips an issued session to its merchant id", async () => {
    const token = await issueDashboardSession("merchant-1", "0x1234567890abcdef1234567890abcdef12345678");
    const verified = await verifyDashboardSession(token);
    expect(verified).not.toBeNull();
    expect(verified?.merchantId).toBe("merchant-1");
  });

  it("rejects a token signed for a different purpose or tampered", async () => {
    const token = await issueDashboardSession("merchant-1", "0x1234567890abcdef1234567890abcdef12345678");
    const [header, payload, signature] = token.split(".");
    expect(await verifyDashboardSession(`${header}.${payload}.${signature.slice(0, -2)}aa`)).toBeNull();
  });

  it("rejects garbage and empty input", async () => {
    expect(await verifyDashboardSession("")).toBeNull();
    expect(await verifyDashboardSession("not-a-jwt")).toBeNull();
    expect(await verifyDashboardSession("a.b.c")).toBeNull();
  });

  it("honours a short lifetime so expiry is server-enforced", async () => {
    const token = await issueDashboardSession("merchant-1", "0x1234567890abcdef1234567890abcdef12345678", 1);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await verifyDashboardSession(token)).toBeNull();
  }, 10_000);
});
