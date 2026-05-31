import { v4 as uuidv4 } from "uuid";
import { createComplianceScreeningLog } from "./db";

export type ComplianceCheckType = "merchant_wallet" | "sub_wallet" | "payer_wallet" | "recipient_wallet";
export type ComplianceStatus = "clear" | "blocked" | "unavailable" | "skipped";

export interface ComplianceScreeningResult {
  provider: "chainalysis-sanctions";
  address: string;
  checkType: ComplianceCheckType;
  status: ComplianceStatus;
  blocked: boolean;
  identifications: unknown[];
  message: string;
}

const CHAINALYSIS_BASE_URL = "https://public.chainalysis.com/api/v1";

function isEnabled() {
  return process.env.CHAINALYSIS_ENABLED === "true";
}

function shouldBlockOnUnavailable() {
  return process.env.CHAINALYSIS_BLOCK_ON_UNAVAILABLE === "true";
}

async function logScreening(input: {
  merchantId?: string | null;
  address: string;
  checkType: ComplianceCheckType;
  status: ComplianceStatus;
  responseStatus?: number | null;
  responseBody?: unknown;
  errorMessage?: string | null;
}) {
  await createComplianceScreeningLog({
    id: uuidv4(),
    merchantId: input.merchantId ?? null,
    address: input.address.toLowerCase(),
    provider: "chainalysis-sanctions",
    checkType: input.checkType,
    status: input.status,
    responseStatus: input.responseStatus ?? null,
    responseBody: input.responseBody === undefined ? null : JSON.stringify(input.responseBody),
    errorMessage: input.errorMessage ?? null,
  });
}

export async function screenWalletAddress(
  address: string,
  checkType: ComplianceCheckType,
  merchantId?: string | null
): Promise<ComplianceScreeningResult> {
  const normalizedAddress = address.toLowerCase();
  const apiKey = process.env.CHAINALYSIS_API_KEY;

  if (!isEnabled()) {
    await logScreening({ merchantId, address: normalizedAddress, checkType, status: "skipped" });
    return {
      provider: "chainalysis-sanctions",
      address: normalizedAddress,
      checkType,
      status: "skipped",
      blocked: false,
      identifications: [],
      message: "Chainalysis screening is disabled.",
    };
  }

  if (!apiKey) {
    const status = shouldBlockOnUnavailable() ? "blocked" : "unavailable";
    await logScreening({
      merchantId,
      address: normalizedAddress,
      checkType,
      status,
      errorMessage: "CHAINALYSIS_API_KEY is not configured.",
    });
    return {
      provider: "chainalysis-sanctions",
      address: normalizedAddress,
      checkType,
      status,
      blocked: shouldBlockOnUnavailable(),
      identifications: [],
      message: "Chainalysis API key is not configured.",
    };
  }

  try {
    const response = await fetch(`${CHAINALYSIS_BASE_URL}/address/${encodeURIComponent(address)}`, {
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    const identifications = Array.isArray(body.identifications) ? body.identifications : [];
    const status: ComplianceStatus = identifications.length > 0 ? "blocked" : "clear";
    await logScreening({
      merchantId,
      address: normalizedAddress,
      checkType,
      status,
      responseStatus: response.status,
      responseBody: body,
    });

    if (!response.ok) {
      return {
        provider: "chainalysis-sanctions",
        address: normalizedAddress,
        checkType,
        status: shouldBlockOnUnavailable() ? "blocked" : "unavailable",
        blocked: shouldBlockOnUnavailable(),
        identifications: [],
        message: `Chainalysis returned ${response.status}.`,
      };
    }

    return {
      provider: "chainalysis-sanctions",
      address: normalizedAddress,
      checkType,
      status,
      blocked: identifications.length > 0,
      identifications,
      message: identifications.length > 0 ? "Address matched sanctions data." : "No sanctions identifications found.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chainalysis screening failed.";
    const status = shouldBlockOnUnavailable() ? "blocked" : "unavailable";
    await logScreening({ merchantId, address: normalizedAddress, checkType, status, errorMessage: message });
    return {
      provider: "chainalysis-sanctions",
      address: normalizedAddress,
      checkType,
      status,
      blocked: shouldBlockOnUnavailable(),
      identifications: [],
      message,
    };
  }
}
