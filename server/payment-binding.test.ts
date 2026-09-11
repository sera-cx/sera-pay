import { describe, it, expect } from "vitest";
import type { MenuOrder, PaymentIntent } from "../drizzle/schema";
import {
  PaymentBindingError,
  amountAtLeast,
  assertAmountMatchesReference,
  assertMenuOrderBindable,
  assertPaymentIntentBindable,
  sameMicroAmount,
} from "./payment-binding";

const MERCHANT_ID = "merchant-1";
const OTHER_MERCHANT_ID = "merchant-2";
const RECEIVER_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const INTENT_BINDING = {
  merchantId: MERCHANT_ID,
  receiveCoin: "XSGD",
  receiverAddress: RECEIVER_ADDRESS,
  chainId: 1,
};

function makeIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: "intent-1",
    merchantId: MERCHANT_ID,
    subWalletId: null,
    amount: "100.5",
    coin: "XSGD",
    receiverAddress: RECEIVER_ADDRESS,
    chainId: 1,
    customerEmail: null,
    customerName: null,
    description: null,
    metadata: null,
    checkoutUrl: "https://pay.sera.cx/pay/abc",
    status: "open",
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PaymentIntent;
}

function makeOrder(overrides: Partial<MenuOrder> = {}): MenuOrder {
  return {
    id: "order-1",
    merchantId: MERCHANT_ID,
    menuId: "menu-1",
    paymentId: null,
    paymentIntentId: null,
    transactionId: null,
    status: "created",
    pax: 1,
    businessCategory: null,
    category1: null,
    category2: null,
    category3: null,
    category4: null,
    category5: null,
    category6: null,
    items: "[]",
    amount: "42.25",
    coin: "MYRT",
    customerName: null,
    orderedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as MenuOrder;
}

function expectBindingError(fn: () => unknown, status: number, message: string) {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(PaymentBindingError);
  expect((error as PaymentBindingError).status).toBe(status);
  expect((error as PaymentBindingError).message).toContain(message);
}

describe("amount comparison", () => {
  it("treats differently formatted decimals of the same value as equal", () => {
    expect(sameMicroAmount("10", "10.000000")).toBe(true);
    expect(sameMicroAmount("10.5", "10.500000")).toBe(true);
    expect(sameMicroAmount("1,000.123456", "1000.123456")).toBe(true);
  });

  it("rejects amounts that differ below the displayed precision", () => {
    expect(sameMicroAmount("100.5", "100.500001")).toBe(false);
    expect(sameMicroAmount("0.01", "0.02")).toBe(false);
    expect(sameMicroAmount("1000", "999.999999")).toBe(false);
  });

  it("refuses to compare malformed amounts as equal", () => {
    expect(sameMicroAmount("abc", "10")).toBe(false);
    expect(sameMicroAmount("", "")).toBe(false);
    expect(sameMicroAmount("-5", "-5")).toBe(false);
  });

  it("amountAtLeast covers equal and larger amounts only", () => {
    expect(amountAtLeast("100.5", "100.5")).toBe(true);
    expect(amountAtLeast("100.500001", "100.5")).toBe(true);
    expect(amountAtLeast("100.499999", "100.5")).toBe(false);
  });
});

describe("assertPaymentIntentBindable", () => {
  it("accepts a payable intent and returns its amount", () => {
    expect(assertPaymentIntentBindable(makeIntent(), { ...INTENT_BINDING, receiveCoin: "xsgd" })).toBe("100.5");
  });

  it("returns 404 for a missing intent without leaking ownership", () => {
    expectBindingError(() => assertPaymentIntentBindable(undefined, INTENT_BINDING), 404, "not found");
  });

  it("rejects an intent owned by another merchant", () => {
    expectBindingError(
      () => assertPaymentIntentBindable(makeIntent({ merchantId: OTHER_MERCHANT_ID }), INTENT_BINDING),
      403,
      "does not belong to this merchant",
    );
  });

  it.each([
    ["paid", "already been paid"],
    ["canceled", "no longer be paid"],
    ["expired", "no longer be paid"],
  ] as const)("rejects a %s intent", (status, message) => {
    expectBindingError(
      () => assertPaymentIntentBindable(makeIntent({ status }), INTENT_BINDING),
      409,
      message,
    );
  });

  it("allows a retry after a failed attempt and honours an explicit open status", () => {
    for (const status of ["created", "open", "failed"] as const) {
      expect(assertPaymentIntentBindable(makeIntent({ status }), INTENT_BINDING)).toBe("100.5");
    }
  });

  it("rejects an intent past its expiry timestamp", () => {
    const intent = makeIntent({ expiresAt: new Date(Date.now() - 1000) });
    expectBindingError(() => assertPaymentIntentBindable(intent, INTENT_BINDING), 410, "expired");
  });

  it("rejects a payment in a different currency than the intent", () => {
    expectBindingError(
      () => assertPaymentIntentBindable(makeIntent(), { ...INTENT_BINDING, receiveCoin: "USDC" }),
      400,
      "does not match",
    );
  });

  it("rejects a different receiver or network", () => {
    expectBindingError(
      () => assertPaymentIntentBindable(makeIntent(), {
        ...INTENT_BINDING,
        receiverAddress: "0x9999999999999999999999999999999999999999",
      }),
      400,
      "receiver",
    );
    expectBindingError(
      () => assertPaymentIntentBindable(makeIntent(), { ...INTENT_BINDING, chainId: 11155111 }),
      400,
      "network",
    );
  });
});

describe("assertMenuOrderBindable", () => {
  it("accepts a payable order and returns its total", () => {
    expect(assertMenuOrderBindable(makeOrder(), { merchantId: MERCHANT_ID, receiveCoin: "MYRT" })).toBe("42.25");
  });

  it("returns 404 for a missing order", () => {
    expectBindingError(() => assertMenuOrderBindable(null, { merchantId: MERCHANT_ID, receiveCoin: "MYRT" }), 404, "not found");
  });

  it("rejects an order owned by another merchant", () => {
    expectBindingError(
      () => assertMenuOrderBindable(makeOrder({ merchantId: OTHER_MERCHANT_ID }), { merchantId: MERCHANT_ID, receiveCoin: "MYRT" }),
      403,
      "does not belong to this merchant",
    );
  });

  it.each([
    ["paid", "already been paid"],
    ["canceled", "no longer be paid"],
    ["payment_submitted", "already being confirmed"],
  ] as const)("rejects an order that is %s", (status, message) => {
    expectBindingError(
      () => assertMenuOrderBindable(makeOrder({ status }), { merchantId: MERCHANT_ID, receiveCoin: "MYRT" }),
      409,
      message,
    );
  });

  it("lets a MIXED order be paid in the merchant's receive coin", () => {
    expect(
      assertMenuOrderBindable(
        makeOrder({ coin: "MIXED" }),
        { merchantId: MERCHANT_ID, receiveCoin: "USDC", merchantReceiveCoin: "USDC" },
      ),
    ).toBe("42.25");
  });

  it("rejects a MIXED order paid in a coin the merchant does not receive", () => {
    expectBindingError(
      () => assertMenuOrderBindable(
        makeOrder({ coin: "MIXED" }),
        { merchantId: MERCHANT_ID, receiveCoin: "XSGD", merchantReceiveCoin: "USDC" },
      ),
      400,
      "does not match",
    );
  });
});

describe("assertAmountMatchesReference", () => {
  it("exact mode requires equality", () => {
    expect(() => assertAmountMatchesReference("10.000000", "10", { exact: true, label: "menu order" })).not.toThrow();
    expectBindingError(
      () => assertAmountMatchesReference("10.000001", "10", { exact: true, label: "menu order" }),
      400,
      "does not match",
    );
  });

  it("non-exact mode requires coverage, not equality", () => {
    expect(() => assertAmountMatchesReference("10.000001", "10", { exact: false, label: "payment intent" })).not.toThrow();
    expectBindingError(
      () => assertAmountMatchesReference("9.999999", "10", { exact: false, label: "payment intent" }),
      400,
      "less than",
    );
  });
});
