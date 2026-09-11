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

// A screening body we could not parse still has to reach the audit trail, but an
// upstream HTML error page must not become an unbounded row in the log table.
const MAX_LOGGED_BODY_CHARS = 2_000;

function isEnabled() {
  return process.env.CHAINALYSIS_ENABLED === "true";
}

function shouldBlockOnUnavailable() {
  return process.env.CHAINALYSIS_BLOCK_ON_UNAVAILABLE === "true";
}

// `status` and `blocked` are two views of the same decision, so they are read
// from the environment once and returned together. Deriving them from separate
// calls allows them to disagree if the variable changes mid-request.
function unavailableOutcome(): { status: ComplianceStatus; blocked: boolean } {
  const blocked = shouldBlockOnUnavailable();
  return { status: blocked ? "blocked" : "unavailable", blocked };
}

// A screening only counts as an answer when the provider returned a JSON object
// carrying an `identifications` array. Anything else — a 204, an empty body,
// `{}`, `{"message": "upstream degraded"}`, `{"identifications": null}`, or a
// top-level array — is missing data, not an all-clear, and returns null so the
// caller can route it through the unavailable path.
function readIdentifications(value: unknown): unknown[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>).identifications;
  return Array.isArray(candidate) ? candidate : null;
}

type ParsedBody =
  | { parsed: true; value: unknown }
  | { parsed: false; raw: string };

function parseBody(text: string): ParsedBody {
  if (!text) return { parsed: false, raw: "" };
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch {
    return { parsed: false, raw: text.slice(0, MAX_LOGGED_BODY_CHARS) };
  }
}

// Whatever we managed to read is what gets logged: the decoded JSON when the
// body parsed, otherwise the raw text. Either way the HTTP status travels with
// it, so an operator reading the audit trail can tell a sanctions hit apart
// from a provider outage.
function loggableBody(body: ParsedBody): unknown {
  return body.parsed ? body.value : body.raw;
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
    const { status, blocked } = unavailableOutcome();
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
      blocked,
      identifications: [],
      message: "Chainalysis API key is not configured.",
    };
  }

  try {
    const response = await fetch(`${CHAINALYSIS_BASE_URL}/address/${encodeURIComponent(address)}`, {
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    const body = parseBody(await response.text());

    if (!response.ok) {
      const { status, blocked } = unavailableOutcome();
      const message = `Chainalysis returned ${response.status}.`;
      await logScreening({
        merchantId,
        address: normalizedAddress,
        checkType,
        status,
        responseStatus: response.status,
        responseBody: loggableBody(body),
        errorMessage: message,
      });
      return {
        provider: "chainalysis-sanctions",
        address: normalizedAddress,
        checkType,
        status,
        blocked,
        identifications: [],
        message,
      };
    }

    const identifications = body.parsed ? readIdentifications(body.value) : null;

    // A 2xx we cannot read is an absent screening. Reporting it as "clear" is
    // the failure mode this module exists to prevent, so it takes the same
    // route as an outage and honours CHAINALYSIS_BLOCK_ON_UNAVAILABLE.
    if (identifications === null) {
      const { status, blocked } = unavailableOutcome();
      const message = body.parsed
        ? `Chainalysis returned ${response.status} without an identifications array.`
        : `Chainalysis returned ${response.status} with a body that is not valid JSON.`;
      await logScreening({
        merchantId,
        address: normalizedAddress,
        checkType,
        status,
        responseStatus: response.status,
        responseBody: loggableBody(body),
        errorMessage: message,
      });
      return {
        provider: "chainalysis-sanctions",
        address: normalizedAddress,
        checkType,
        status,
        blocked,
        identifications: [],
        message,
      };
    }

    const blocked = identifications.length > 0;
    const status: ComplianceStatus = blocked ? "blocked" : "clear";
    await logScreening({
      merchantId,
      address: normalizedAddress,
      checkType,
      status,
      responseStatus: response.status,
      responseBody: loggableBody(body),
    });

    return {
      provider: "chainalysis-sanctions",
      address: normalizedAddress,
      checkType,
      status,
      blocked,
      identifications,
      message: blocked ? "Address matched sanctions data." : "No sanctions identifications found.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chainalysis screening failed.";
    const { status, blocked } = unavailableOutcome();
    await logScreening({ merchantId, address: normalizedAddress, checkType, status, errorMessage: message });
    return {
      provider: "chainalysis-sanctions",
      address: normalizedAddress,
      checkType,
      status,
      blocked,
      identifications: [],
      message,
    };
  }
}
