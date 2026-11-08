import { describe, it, expect } from "vitest";
import {
  ADDRESS_ALREADY_CLAIMED_MESSAGE,
  AddressClaimError,
  type AddressClaim,
  assertAddressClaimable,
  findForeignAddressClaim,
  isAddressClaimConflict,
  normalizeClaimAddress,
} from "./address-claims";

const MERCHANT_ID = "merchant-1";
const OTHER_MERCHANT_ID = "merchant-2";
const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

function claim(kind: AddressClaim["kind"], merchantId: string): AddressClaim {
  return kind === "sub_wallet"
    ? { kind, merchantId, subWalletId: "sub-1" }
    : { kind, merchantId };
}

describe("normalizeClaimAddress", () => {
  it("lowercases and trims, so a checksummed address is the same claim", () => {
    expect(normalizeClaimAddress(` ${ADDRESS.toUpperCase()} `)).toBe(ADDRESS);
  });

  it("returns empty for absent input", () => {
    expect(normalizeClaimAddress(undefined as unknown as string)).toBe("");
  });
});

describe("findForeignAddressClaim", () => {
  it("finds a claim held by another merchant", () => {
    const found = findForeignAddressClaim([claim("sub_wallet", OTHER_MERCHANT_ID)], MERCHANT_ID);
    expect(found?.merchantId).toBe(OTHER_MERCHANT_ID);
  });

  it("ignores the caller's own claims", () => {
    const own = [claim("merchant_wallet", MERCHANT_ID), claim("sub_wallet", MERCHANT_ID)];
    expect(findForeignAddressClaim(own, MERCHANT_ID)).toBeUndefined();
  });
});

describe("assertAddressClaimable", () => {
  it("allows an address nobody holds", () => {
    expect(() => assertAddressClaimable([], MERCHANT_ID, "sub_wallet")).not.toThrow();
    expect(() => assertAddressClaimable([], MERCHANT_ID, "store_address")).not.toThrow();
  });

  // The vulnerability itself: a receiving address is public, so any merchant
  // could register another merchant's address and take over the attribution
  // of payments made to it.
  it.each(["merchant_wallet", "merchant_store", "sub_wallet"] as const)(
    "rejects an address held by another merchant as %s",
    (kind) => {
      for (const purpose of ["sub_wallet", "store_address"] as const) {
        const error = (() => {
          try {
            assertAddressClaimable([claim(kind, OTHER_MERCHANT_ID)], MERCHANT_ID, purpose);
            return null;
          } catch (thrown) {
            return thrown;
          }
        })();
        expect(error).toBeInstanceOf(AddressClaimError);
        expect((error as AddressClaimError).status).toBe(409);
        expect((error as AddressClaimError).message).toBe(ADDRESS_ALREADY_CLAIMED_MESSAGE);
      }
    },
  );

  it("does not name the merchant holding the address", () => {
    try {
      assertAddressClaimable([claim("sub_wallet", OTHER_MERCHANT_ID)], MERCHANT_ID, "sub_wallet");
      throw new Error("expected a conflict");
    } catch (error) {
      expect((error as Error).message).not.toContain(OTHER_MERCHANT_ID);
    }
  });

  it("rejects registering the same address as a second sub-wallet of the same merchant", () => {
    expect(() => assertAddressClaimable([claim("sub_wallet", MERCHANT_ID)], MERCHANT_ID, "sub_wallet"))
      .toThrow(AddressClaimError);
  });

  // Pointing the settlement override at your own wallet or your own sub-wallet
  // is what the override is for.
  it("allows the caller's own addresses as a settlement override", () => {
    const own = [claim("merchant_wallet", MERCHANT_ID), claim("sub_wallet", MERCHANT_ID)];
    expect(() => assertAddressClaimable(own, MERCHANT_ID, "store_address")).not.toThrow();
  });

  it("allows a merchant to add their own wallet address as a sub-wallet", () => {
    expect(() => assertAddressClaimable([claim("merchant_wallet", MERCHANT_ID)], MERCHANT_ID, "sub_wallet"))
      .not.toThrow();
  });
});

describe("isAddressClaimConflict", () => {
  it("recognises a unique violation on either claim index", () => {
    for (const constraint of ["uq_sub_wallets_active_address", "uq_merchants_store_address"]) {
      expect(isAddressClaimConflict({ code: "23505", constraint })).toBe(true);
    }
  });

  it("leaves other unique violations as server faults", () => {
    expect(isAddressClaimConflict({ code: "23505", constraint: "merchants_apiKey_unique" })).toBe(false);
    expect(isAddressClaimConflict({ code: "23503", constraint: "uq_merchants_store_address" })).toBe(false);
    expect(isAddressClaimConflict(new Error("boom"))).toBe(false);
    expect(isAddressClaimConflict(null)).toBe(false);
  });
});
