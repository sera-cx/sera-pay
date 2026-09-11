import { afterEach, describe, expect, it, vi } from "vitest";

const receiverAddress = "0x1234567890abcdef1234567890abcdef12345678";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("client conversion QR preflight", () => {
  it("preflights the exact cross-currency request before signing it", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        executable: true,
        requiresCustomerRequote: true,
        chainId: 1,
        toAddress: receiverAddress,
        payCoin: "IDRT",
        receiveCoin: "USDC",
        requestedPayAmount: "2000",
        quotedPayAmount: "2000",
        maximumPayAmount: "2005",
        targetReceiveAmount: "0.113334",
        minimumReceiveAmount: "0.113",
      }))
      .mockResolvedValueOnce(jsonResponse({
        encoded: "signed-payload",
        paymentUrl: "https://pay.sera.cx/pay/signed-payload",
      }));
    vi.stubGlobal("fetch", fetchMock);

    const { requestSignedPaymentUrl } = await import("../client/src/lib/payment");
    const paymentUrl = await requestSignedPaymentUrl({
      receiverAddress,
      receiveCoin: "USDC",
      amount: "0.113334",
      payCoin: "IDRT",
      payAmount: "2000",
      chainId: 1,
    });

    expect(paymentUrl).toBe("https://pay.sera.cx/pay/signed-payload");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/payment/swap/preflight");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/payment/checkout/sign");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      receiverAddress,
      payCoin: "IDRT",
      receiveCoin: "USDC",
      receiveAmount: "0.113334",
      estimatedPayAmount: "2000",
      chainId: 1,
    });
  });

  it("does not sign or expose a conversion when Sera reports no liquidity", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      error: "Sera has no executable route for this direction and amount",
      errorCode: "no_liquidity",
    }, 422));
    vi.stubGlobal("fetch", fetchMock);

    const { requestSignedPaymentUrl } = await import("../client/src/lib/payment");
    await expect(requestSignedPaymentUrl({
      receiverAddress,
      receiveCoin: "ZARP",
      amount: "10",
      payCoin: "IDRT",
      payAmount: "2000",
      chainId: 1,
    })).rejects.toThrow(/no executable route/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/payment/swap/preflight");
  });

  it("does not sign when a preflight response is for different amounts", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      executable: true,
      requiresCustomerRequote: true,
      chainId: 1,
      toAddress: receiverAddress,
      payCoin: "IDRT",
      receiveCoin: "USDC",
      requestedPayAmount: "2000",
      maximumPayAmount: "2005",
      targetReceiveAmount: "0.2",
      minimumReceiveAmount: "0.19",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { requestSignedPaymentUrl } = await import("../client/src/lib/payment");
    await expect(requestSignedPaymentUrl({
      receiverAddress,
      receiveCoin: "USDC",
      amount: "0.113334",
      payCoin: "IDRT",
      payAmount: "2000",
      chainId: 1,
    })).rejects.toThrow(/different payment request/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps same-token checkout signing on the direct path", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      encoded: "signed-direct-payload",
      paymentUrl: "https://pay.sera.cx/pay/signed-direct-payload",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { requestSignedPaymentUrl } = await import("../client/src/lib/payment");
    await requestSignedPaymentUrl({
      receiverAddress,
      receiveCoin: "USDC",
      amount: "5",
      payCoin: "USDC",
      payAmount: "5",
      chainId: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/payment/checkout/sign");
  });
});
