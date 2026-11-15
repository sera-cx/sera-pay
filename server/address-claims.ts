/**
 * Who may claim a receiving address.
 *
 * Three fields decide where a merchant is paid and who a payment is credited
 * to: "merchants.walletAddress", "merchants.storeAddress" and
 * "sub_wallets.address". The first is proven at registration — Privy wallet
 * linkage, or an EIP-712 signature as the documented fallback — but the other
 * two were only asserted. POST /sub-wallets, PUT /merchant/settings and PUT
 * /merchant/profile each took any well-formed address, screened it for
 * compliance and stored it, with no check that another merchant had already
 * registered the same one.
 *
 * That matters because the resolution runs the other way. A transfer arrives
 * with nothing but a recipient address, and getSubWalletByAddress() and
 * getMerchantByStoreAddress() turn that address back into one merchant with a
 * LIMIT 1 read. Two merchants holding the same address made the answer a race
 * the earlier row won: transfers to one merchant's address could be credited
 * to the other, whose dashboard then showed the payer, amount and time; and
 * the merchant who lost the race could no longer be paid through their own
 * checkout links, since assertPaymentIntentBindable() rejects an intent whose
 * receiver resolves to a different merchant with 403. Receiving addresses are
 * printed in every QR code, so claiming someone else's took nothing but a
 * merchant API key.
 *
 * Note what this is not: the stored recipient is always re-derived server-side
 * from the resolved merchant, so a claim never moved money to the claimer. It
 * took over the bookkeeping, not the funds.
 *
 * The rule here is that an address belongs to one merchant. Within a table the
 * unique indexes added in drizzle/0010_unique_receiving_address_claims.sql
 * enforce it; across tables these checks do, since no index can span them.
 * Proof beats claim: where a claim collides with a walletAddress someone
 * proved at registration, the claim is the one released.
 */

export type AddressClaimKind = "merchant_wallet" | "merchant_store" | "sub_wallet";

export interface AddressClaim {
  kind: AddressClaimKind;
  merchantId: string;
  /** Set only for "sub_wallet", so a released claim can be archived by id. */
  subWalletId?: string | null;
}

/** What the address is about to be used for, which decides which of a merchant's own claims are a conflict. */
export type AddressClaimPurpose = "sub_wallet" | "store_address";

/** One message for a foreign claim, whether the check caught it or the index did. */
export const ADDRESS_ALREADY_CLAIMED_MESSAGE = "This address is already registered to another account.";

export class AddressClaimError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "AddressClaimError";
  }
}

/** Addresses are compared and stored lowercased; every write path normalizes before this. */
export function normalizeClaimAddress(address: string): string {
  return String(address ?? "").trim().toLowerCase();
}

/** A claim on this address held by any merchant other than `merchantId`. */
export function findForeignAddressClaim(
  claims: readonly AddressClaim[],
  merchantId: string,
): AddressClaim | undefined {
  return claims.find((claim) => claim.merchantId !== merchantId);
}

/**
 * Whether this merchant may claim the address for `purpose`.
 *
 * Another merchant's claim of any kind blocks it. The merchant's own claims
 * mostly do not: a settlement override is normally pointed at one of their own
 * sub-wallets or at their own wallet, which is the intended use. The one
 * exception is registering the same address as a second active sub-wallet,
 * which the unique index would reject anyway and which means nothing beyond a
 * duplicate row.
 *
 * The message never names the merchant holding the address. Which addresses
 * belong to which merchant is exactly what a claim attempt is probing for.
 */
export function assertAddressClaimable(
  claims: readonly AddressClaim[],
  merchantId: string,
  purpose: AddressClaimPurpose,
): void {
  if (findForeignAddressClaim(claims, merchantId)) {
    throw new AddressClaimError(ADDRESS_ALREADY_CLAIMED_MESSAGE, 409);
  }
  if (purpose === "sub_wallet" && claims.some((claim) => claim.kind === "sub_wallet")) {
    throw new AddressClaimError("This address is already one of your sub-wallets.", 409);
  }
}

const CLAIM_UNIQUE_CONSTRAINTS = new Set([
  "uq_sub_wallets_active_address",
  "uq_merchants_store_address",
]);

/**
 * Whether a write failed on one of the claim indexes.
 *
 * assertAddressClaimable() reads before writing, so two requests racing on the
 * same free address both pass the check and the index rejects the loser. That
 * is a conflict, not a server fault, and it reads to the caller as the same
 * 409 the check would have produced.
 */
export function isAddressClaimConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code !== "23505") return false;
  const constraint = (error as { constraint?: unknown }).constraint;
  return typeof constraint === "string" && CLAIM_UNIQUE_CONSTRAINTS.has(constraint);
}
