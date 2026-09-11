import crypto from "crypto";

/**
 * Durable ownership key for one payer using one signed checkout snapshot.
 *
 * The signed payload already binds merchant, recipient, amounts, currencies,
 * chain, expiry and a server-generated nonce. Adding the payer lets a reusable
 * merchant QR serve different customers concurrently while ensuring a rescan
 * by the same wallet cannot create payment B while payment A is unresolved.
 */
export function deriveSeraCheckoutAttemptKey(
  signedCheckoutPayload: string,
  payerAddress: string,
): string {
  const payload = signedCheckoutPayload.trim();
  const payer = payerAddress.trim().toLowerCase();
  if (!payload) throw new Error("signedCheckoutPayload cannot be empty");
  if (!/^0x[0-9a-f]{40}$/.test(payer)) throw new Error("payerAddress must be a normalized EVM address");
  return `0x${crypto.createHash("sha256")
    .update("serapay:sera-checkout-attempt:v1\0", "utf8")
    .update(payload, "utf8")
    .update("\0", "utf8")
    .update(payer, "utf8")
    .digest("hex")}`;
}
