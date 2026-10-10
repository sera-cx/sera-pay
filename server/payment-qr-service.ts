import { randomUUID } from "node:crypto";
import type { Merchant } from "../drizzle/schema";
import { buildAppUrl } from "../shared/app-url";
import type { GeneratePaymentQrInput, GeneratePaymentQrResponse } from "../shared/payment-qr";
import { buildWalletPaymentUri } from "../shared/wallet-payment-uri";
import { ENV } from "./_core/env";
import { createPaymentIntent, getApiKeyConfigRecord } from "./db";
import { screenWalletAddress } from "./compliance";
import { isCheckoutSigningReady, signCheckoutPayload } from "./checkout-payload";
import { getSeraApiBaseUrlForChain, resolveSeraSwapToken, toRawTokenAmount, preflightSeraConversion } from "./payment-routes";
import { SERA_UINT256_MAX, SeraQuoteValidationError } from "./sera-swap-quote";
import { renderPaymentQrPng } from "./qr-image";
import { assertQrTokenDecimals, estimateQrPayAmount } from "./payment-qr-amount";

export type PaymentQrExchangeRate = (from: string, to: string, chainId: number) => Promise<{ rate: number }>;

export class PaymentQrError extends Error {
  constructor(readonly status: number, readonly errorCode: string, message: string) {
    super(message);
    this.name = "PaymentQrError";
  }
}

export async function generatePaymentQr(
  merchant: Merchant,
  input: GeneratePaymentQrInput,
  getExchangeRate: PaymentQrExchangeRate,
): Promise<GeneratePaymentQrResponse> {
  if (!isCheckoutSigningReady()) {
    throw new PaymentQrError(503, "signing_unavailable", "Checkout link signing is unavailable");
  }
  const receiverAddress = (merchant.storeAddress || merchant.walletAddress).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(receiverAddress)) {
    throw new PaymentQrError(400, "invalid_receiver", "Configure a valid receiving wallet before generating a QR");
  }
  const compliance = await screenWalletAddress(receiverAddress, "recipient_wallet", merchant.id);
  if (compliance.blocked) {
    throw new PaymentQrError(403, "recipient_blocked", "Recipient address failed compliance screening");
  }

  const config = await getApiKeyConfigRecord(merchant.id);
  const chainId = config?.mode === "test" && ENV.seraEnableTestnet ? 11155111 : 1;
  const baseUrl = getSeraApiBaseUrlForChain(chainId);
  const [baseToken, targetToken] = await Promise.all([
    resolveSeraSwapToken(baseUrl, input.baseCurrency),
    resolveSeraSwapToken(baseUrl, input.targetCurrency),
  ]);
  assertQrTokenDecimals(baseToken.decimals);
  assertQrTokenDecimals(targetToken.decimals);
  if ((input.baseAmount.split(".")[1]?.length ?? 0) > baseToken.decimals) {
    throw new SeraQuoteValidationError("invalid_request", `${input.baseCurrency} supports at most ${baseToken.decimals} decimal places`, { field: "baseAmount" });
  }
  if (BigInt(toRawTokenAmount(input.baseAmount, baseToken.decimals)) > SERA_UINT256_MAX) {
    throw new SeraQuoteValidationError("invalid_request", "Base amount exceeds the token's on-chain limit", { field: "baseAmount" });
  }

  const conversion = input.baseCurrency !== input.targetCurrency;
  let targetAmount = input.baseAmount;
  if (conversion) {
    const { rate } = await getExchangeRate(input.baseCurrency, input.targetCurrency, chainId);
    const estimate = estimateQrPayAmount(input.baseAmount, rate, targetToken.decimals);
    const preflight = await preflightSeraConversion({
      merchantId: merchant.id,
      receiverAddress,
      payCoin: input.targetCurrency,
      receiveCoin: input.baseCurrency,
      receiveAmount: input.baseAmount,
      estimatedPayAmount: estimate,
      chainId,
    });
    targetAmount = estimateQrPayAmount(preflight.maximumPayAmount, 1, targetToken.decimals);
  }

  const id = randomUUID();
  const payload = {
    receiverAddress,
    receiveCoin: input.baseCurrency,
    amount: input.baseAmount,
    payCoin: input.targetCurrency,
    payAmount: targetAmount,
    chainId,
    singleUse: input.singleUse,
    ...(input.singleUse ? { paymentIntentId: id } : {}),
    _n: id.slice(0, 8),
  };
  // Checkout loads the current merchant name/logo by receiver address. Keep
  // them out of the signed URL so large uploaded logos cannot bloat the QR.
  const checkoutUrl = buildAppUrl(`/pay/${signCheckoutPayload(payload)}`, ENV.paymentBaseUrl);
  const qrValue = !conversion && !input.singleUse
    ? buildWalletPaymentUri({
        receiverAddress,
        coin: input.targetCurrency,
        amount: targetAmount,
        chainId,
        tokenAddress: targetToken.address,
        tokenDecimals: targetToken.decimals,
      })
    : checkoutUrl;
  if (!qrValue) {
    throw new SeraQuoteValidationError("invalid_config", "Unable to generate a wallet QR for this token");
  }
  const qrCodeDataUrl = await renderPaymentQrPng(qrValue, merchant, {
    amount: targetAmount,
    coin: input.targetCurrency,
  });

  // Persist only after rendering succeeds, so failed generation leaves no
  // single-use payment behind. Existing checkout reservation enforces use.
  if (input.singleUse) {
    await createPaymentIntent({
      id,
      merchantId: merchant.id,
      amount: input.baseAmount,
      coin: input.baseCurrency,
      receiverAddress,
      chainId,
      checkoutUrl,
      status: "open",
      metadata: JSON.stringify({ source: "qr_api", targetCurrency: input.targetCurrency }),
      expiresAt: null,
    });
  }
  return {
    checkoutUrl,
    qrValue,
    qrCodeDataUrl,
    ...input,
    targetAmount,
    receiverAddress,
    chainId,
    paymentIntentId: input.singleUse ? id : null,
    requiresCustomerRequote: conversion,
  };
}
