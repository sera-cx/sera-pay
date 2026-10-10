import { renderPaymentQrCard as renderCard, type PaymentQrCardOptions } from "@shared/qr-card";
import { browserQrCanvas } from "./qrCanvas";

export type PaymentQrDownloadOptions = PaymentQrCardOptions & { filename?: string };
export const renderPaymentQrCard = (options: PaymentQrCardOptions) => renderCard(options, browserQrCanvas);

function safeFilename(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "payment";
}

export async function downloadPaymentQrCard(options: PaymentQrDownloadOptions) {
  const a = document.createElement("a");
  a.href = await renderPaymentQrCard(options);
  a.download = options.filename || `serapay-qr-${safeFilename(options.merchantName || "SeraPay")}-${safeFilename(options.coin || "payment")}.png`;
  a.click();
}
