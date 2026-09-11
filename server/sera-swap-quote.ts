/**
 * Runtime validation and fixed-output solving for Sera swap quotes.
 *
 * This module deliberately has no database, HTTP, cache, or logging imports.
 * Callers inject the quote transport, which lets merchant preflight and the
 * payer checkout share exactly the same validation and quote economics without
 * either path inheriting the other's persistence side effects.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const QUOTE_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UINT_RE = /^(0|[1-9]\d*)$/;
const DECIMAL_RE = /^(0|[1-9]\d*)(?:\.(\d+))?$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const SERA_UINT256_MAX = (1n << 256n) - 1n;
export const SERA_UINT48_MAX = (1n << 48n) - 1n;

export type SeraAddress = `0x${string}`;
export type SeraGasMode = "pay_more" | "receive_less";

export type SeraQuoteErrorCode =
  | "invalid_request"
  | "unsupported_token"
  | "unsupported_chain"
  | "invalid_config"
  | "invalid_quote"
  | "amount_below_min"
  | "no_liquidity"
  | "output_below_target"
  | "fee_too_high"
  | "price_deviation"
  | "sera_rate_limited"
  | "sera_unavailable";

const ERROR_STATUS: Record<SeraQuoteErrorCode, number> = {
  invalid_request: 400,
  unsupported_token: 400,
  unsupported_chain: 400,
  invalid_config: 503,
  invalid_quote: 502,
  amount_below_min: 400,
  no_liquidity: 409,
  output_below_target: 409,
  fee_too_high: 409,
  price_deviation: 409,
  sera_rate_limited: 429,
  sera_unavailable: 503,
};

export class SeraQuoteValidationError extends Error {
  readonly code: SeraQuoteErrorCode;
  readonly status: number;
  readonly field: string | null;
  readonly detail: Readonly<Record<string, unknown>> | null;

  constructor(
    code: SeraQuoteErrorCode,
    message: string,
    options: { field?: string; detail?: Record<string, unknown>; status?: number } = {},
  ) {
    super(message);
    this.name = "SeraQuoteValidationError";
    this.code = code;
    this.status = options.status ?? ERROR_STATUS[code];
    this.field = options.field ?? null;
    this.detail = options.detail ? Object.freeze({ ...options.detail }) : null;
  }
}

export interface SeraQuoteErrorResponse {
  status: number;
  body: {
    error: string;
    errorCode: SeraQuoteErrorCode;
    field?: string;
    detail?: Readonly<Record<string, unknown>>;
  };
}

/** Converts only errors owned by this module into a stable HTTP response. */
export function serializeSeraQuoteError(error: unknown): SeraQuoteErrorResponse | null {
  if (!(error instanceof SeraQuoteValidationError)) return null;
  return {
    status: error.status,
    body: {
      error: error.message,
      errorCode: error.code,
      ...(error.field ? { field: error.field } : {}),
      ...(error.detail ? { detail: error.detail } : {}),
    },
  };
}

export interface SeraEip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: SeraAddress;
}

export interface SeraDeploymentConfig {
  chainId: number;
  seraAddress: SeraAddress;
  vaultAddress: SeraAddress;
  sorAddress: SeraAddress;
  domainSeparator: `0x${string}` | null;
  eip712Domain: SeraEip712Domain;
}

export interface SeraSwapQuoteRequest {
  from_token: SeraAddress;
  to_token: SeraAddress;
  from_amount: string;
  owner_address: SeraAddress;
  recipient: SeraAddress;
  expiration: number;
  gas_mode: SeraGasMode;
}

export interface SeraValidatedRouteParams {
  taker: SeraAddress;
  inputToken: SeraAddress;
  outputToken: SeraAddress;
  maxInputAmount: string;
  minOutputAmount: string;
  recipient: SeraAddress;
  initialDepositAmount: string;
  uuid: string;
  deadline: string;
}

export interface SeraQuoteFeeBreakdown {
  gasCostUsd: string;
  gasCostFromToken: string;
}

export interface SeraPermitTypedData {
  domain: SeraEip712Domain;
  primaryType: "Permit";
  types: {
    Permit: Array<{ name: string; type: string }>;
  };
  message: {
    owner: SeraAddress;
    spender: SeraAddress;
    value: string;
    nonce: string;
    deadline: string;
  };
}

export type SeraAuthorizationKind = "permit" | "approval" | "none";

export interface SeraPermitMetadata {
  permitSupported: boolean;
  permitRequired: boolean;
  authorizationKind: SeraAuthorizationKind;
  token: SeraAddress;
  spender: SeraAddress;
  owner: SeraAddress;
  valueRaw: string;
  currentAllowanceRaw: string;
  nonce: string | null;
  suggestedDeadline: string | null;
  domain: SeraEip712Domain | null;
  typedData: SeraPermitTypedData | null;
}

export interface SeraValidatedSwapQuote {
  /** Quote-record UUID used only when submitting POST /swap. */
  uuid: string;
  /** Composite uint256 Intent UUID is separately available at routeParams.uuid. */
  routeParams: SeraValidatedRouteParams;
  feeBreakdown: SeraQuoteFeeBreakdown;
  expiresAt: number;
  permit: SeraPermitMetadata | null;
}

export interface SeraPriceReference {
  inputAmountRaw: string;
  outputAmountRaw: string;
  /** Maximum adverse protected-rate movement from this reference, in bps. */
  maxAdverseDeviationBps: number;
}

/** Optional policy checks. No product limits are silently invented here. */
export interface SeraFixedOutputPolicy {
  /** Maximum increase of final maxInputAmount over the initial estimate. */
  maxInputIncreaseBps?: number;
  maxGasCostUsd?: string;
  maxGasCostFromToken?: string;
  priceReference?: SeraPriceReference;
}

export interface SeraFixedOutputQuoteAttempt {
  attempt: 1 | 2;
  request: SeraSwapQuoteRequest;
  quote: SeraValidatedSwapQuote;
}

export interface SeraFixedOutputQuoteResult {
  initialRequest: SeraSwapQuoteRequest;
  finalRequest: SeraSwapQuoteRequest;
  targetOutputRaw: string;
  quote: SeraValidatedSwapQuote;
  attempts: readonly SeraFixedOutputQuoteAttempt[];
}

export interface SeraPreflightSummary {
  executable: true;
  advisory: true;
  requiresCustomerRequote: true;
  source: "sera-swap-quote";
  requestedInputAmountRaw: string;
  quotedInputAmountRaw: string;
  maximumInputAmountRaw: string;
  targetOutputAmountRaw: string;
  minimumOutputAmountRaw: string;
  feeBreakdown: SeraQuoteFeeBreakdown;
  checkedAt: number;
  quoteExpiresAt: number;
  attemptCount: 1 | 2;
}

type RecordValue = Record<string, unknown>;

function fail(
  code: SeraQuoteErrorCode,
  message: string,
  field?: string,
  detail?: Record<string, unknown>,
): never {
  throw new SeraQuoteValidationError(code, message, { field, detail });
}

function asRecord(value: unknown, code: SeraQuoteErrorCode, field: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${field} must be an object`, field);
  }
  return value as RecordValue;
}

function asNonEmptyString(value: unknown, code: SeraQuoteErrorCode, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail(code, `${field} must be a non-empty string`, field);
  }
  return value.trim();
}

function asAddress(value: unknown, code: SeraQuoteErrorCode, field: string): SeraAddress {
  if (typeof value !== "string" || !ADDRESS_RE.test(value) || value.toLowerCase() === ZERO_ADDRESS) {
    fail(code, `${field} must be a non-zero EVM address`, field);
  }
  return value.toLowerCase() as SeraAddress;
}

function addressesEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function uintString(
  value: unknown,
  maximum: bigint,
  code: SeraQuoteErrorCode,
  field: string,
  options: { positive?: boolean } = {},
): string {
  let normalized: string;
  if (typeof value === "bigint") {
    normalized = value.toString();
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail(code, `${field} must be a safe unsigned integer`, field);
    normalized = String(value);
  } else if (typeof value === "string") {
    normalized = value.trim();
  } else {
    fail(code, `${field} must be an unsigned integer`, field);
  }

  if (!UINT_RE.test(normalized)) fail(code, `${field} must be an unsigned decimal integer`, field);
  const parsed = BigInt(normalized);
  if (parsed > maximum) fail(code, `${field} is outside its unsigned integer range`, field);
  if (options.positive && parsed === 0n) fail(code, `${field} must be greater than zero`, field);
  return parsed.toString();
}

function uint256(
  value: unknown,
  code: SeraQuoteErrorCode,
  field: string,
  options: { positive?: boolean } = {},
): string {
  return uintString(value, SERA_UINT256_MAX, code, field, options);
}

function unixUint48(value: unknown, code: SeraQuoteErrorCode, field: string): number {
  const parsed = uintString(value, SERA_UINT48_MAX, code, field, { positive: true });
  return Number(parsed);
}

function serverTimestamp(value: unknown, code: SeraQuoteErrorCode, field = "serverTime"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(code, `${field} must be a positive Unix timestamp`, field);
  }
  return value;
}

function nonNegativeDecimal(value: unknown, code: SeraQuoteErrorCode, field: string): string {
  let text: string;
  if (typeof value === "string") {
    text = value.trim();
  } else if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    text = String(value);
  } else {
    fail(code, `${field} must be a non-negative decimal`, field);
  }
  const match = text.match(DECIMAL_RE);
  if (!match) fail(code, `${field} must be a non-negative decimal`, field);
  const [whole, fraction = ""] = text.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
}

function compareDecimals(left: string, right: string): number {
  const [leftWhole, leftFraction = ""] = left.split(".");
  const [rightWhole, rightFraction = ""] = right.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftRaw = BigInt(`${leftWhole}${leftFraction.padEnd(scale, "0")}`);
  const rightRaw = BigInt(`${rightWhole}${rightFraction.padEnd(scale, "0")}`);
  return leftRaw < rightRaw ? -1 : leftRaw > rightRaw ? 1 : 0;
}

function chainId(value: unknown, code: SeraQuoteErrorCode, field: string): number {
  const parsed = uint256(value, code, field, { positive: true });
  const numeric = Number(parsed);
  if (!Number.isSafeInteger(numeric)) fail(code, `${field} must be a safe positive chain id`, field);
  return numeric;
}

function parseDomain(value: unknown, code: SeraQuoteErrorCode, field: string): SeraEip712Domain {
  const record = asRecord(value, code, field);
  const name = asNonEmptyString(record.name, code, `${field}.name`);
  const version = asNonEmptyString(record.version, code, `${field}.version`);
  const parsedChainId = chainId(record.chainId, code, `${field}.chainId`);
  const verifyingContract = asAddress(record.verifyingContract, code, `${field}.verifyingContract`);
  return { name, version, chainId: parsedChainId, verifyingContract };
}

function domainsEqual(left: SeraEip712Domain, right: SeraEip712Domain): boolean {
  return left.name === right.name
    && left.version === right.version
    && left.chainId === right.chainId
    && addressesEqual(left.verifyingContract, right.verifyingContract);
}

/**
 * Validates the live GET /config response and pins its signing domain to the
 * Sera contract in that same response.
 */
export function validateSeraDeploymentConfig(raw: unknown, expectedChainId: number): SeraDeploymentConfig {
  const expected = chainId(expectedChainId, "unsupported_chain", "expectedChainId");
  const value = asRecord(raw, "invalid_config", "config");
  const actualChainId = chainId(value.chain_id, "invalid_config", "config.chain_id");
  if (actualChainId !== expected) {
    fail(
      "unsupported_chain",
      `Sera configuration is for chain ${actualChainId}, expected ${expected}`,
      "config.chain_id",
      { expectedChainId: expected, actualChainId },
    );
  }

  const seraAddress = asAddress(value.sera_address, "invalid_config", "config.sera_address");
  const vaultAddress = asAddress(value.vault_address, "invalid_config", "config.vault_address");
  const sorAddress = asAddress(value.sor_address, "invalid_config", "config.sor_address");
  if (new Set([seraAddress, vaultAddress, sorAddress]).size !== 3) {
    fail("invalid_config", "Sera, Vault, and SOR contract addresses must be distinct", "config");
  }

  const eip712Domain = parseDomain(value.eip712_domain, "invalid_config", "config.eip712_domain");
  if (eip712Domain.name !== "Sera" || eip712Domain.version !== "1") {
    fail("invalid_config", "Sera EIP-712 domain name or version is invalid", "config.eip712_domain");
  }
  if (eip712Domain.chainId !== actualChainId) {
    fail("invalid_config", "Sera EIP-712 domain chain does not match config.chain_id", "config.eip712_domain.chainId");
  }
  if (!addressesEqual(eip712Domain.verifyingContract, seraAddress)) {
    fail(
      "invalid_config",
      "Sera EIP-712 verifyingContract does not match config.sera_address",
      "config.eip712_domain.verifyingContract",
    );
  }

  let domainSeparator: `0x${string}` | null = null;
  if (value.domain_separator !== undefined && value.domain_separator !== null) {
    if (typeof value.domain_separator !== "string" || !BYTES32_RE.test(value.domain_separator)) {
      fail("invalid_config", "config.domain_separator must be a 32-byte hex value", "config.domain_separator");
    }
    domainSeparator = value.domain_separator.toLowerCase() as `0x${string}`;
  }

  return { chainId: actualChainId, seraAddress, vaultAddress, sorAddress, domainSeparator, eip712Domain };
}

export function validateSeraSwapQuoteRequest(
  raw: unknown,
  options: { serverTime: number; expectedGasMode?: SeraGasMode },
): SeraSwapQuoteRequest {
  const now = serverTimestamp(options.serverTime, "invalid_request");
  const value = asRecord(raw, "invalid_request", "request");
  const fromToken = asAddress(value.from_token, "invalid_request", "request.from_token");
  const toToken = asAddress(value.to_token, "invalid_request", "request.to_token");
  if (addressesEqual(fromToken, toToken)) {
    fail("invalid_request", "A Sera swap requires different input and output tokens", "request.to_token");
  }
  const expiration = unixUint48(value.expiration, "invalid_request", "request.expiration");
  if (expiration <= now) fail("invalid_request", "Sera quote expiration must be in the future", "request.expiration");
  if (value.gas_mode !== "pay_more" && value.gas_mode !== "receive_less") {
    fail("invalid_request", "request.gas_mode must be pay_more or receive_less", "request.gas_mode");
  }
  if (options.expectedGasMode && value.gas_mode !== options.expectedGasMode) {
    fail("invalid_request", `Sera quote must use ${options.expectedGasMode}`, "request.gas_mode");
  }
  return {
    from_token: fromToken,
    to_token: toToken,
    from_amount: uint256(value.from_amount, "invalid_request", "request.from_amount", { positive: true }),
    owner_address: asAddress(value.owner_address, "invalid_request", "request.owner_address"),
    recipient: asAddress(value.recipient, "invalid_request", "request.recipient"),
    expiration,
    gas_mode: value.gas_mode,
  };
}

const EXPECTED_PERMIT_FIELDS = [
  { name: "owner", type: "address" },
  { name: "spender", type: "address" },
  { name: "value", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] as const;

function parsePermitTypes(value: unknown): Array<{ name: string; type: string }> {
  const types = asRecord(value, "invalid_quote", "quote.permit.eip712.types");
  const permit = types.Permit;
  if (!Array.isArray(permit) || permit.length !== EXPECTED_PERMIT_FIELDS.length) {
    fail("invalid_quote", "Permit typed data has an invalid Permit type", "quote.permit.eip712.types.Permit");
  }
  const parsed = permit.map((item, index) => {
    const field = asRecord(item, "invalid_quote", `quote.permit.eip712.types.Permit[${index}]`);
    return {
      name: asNonEmptyString(field.name, "invalid_quote", `quote.permit.eip712.types.Permit[${index}].name`),
      type: asNonEmptyString(field.type, "invalid_quote", `quote.permit.eip712.types.Permit[${index}].type`),
    };
  });
  for (let index = 0; index < EXPECTED_PERMIT_FIELDS.length; index += 1) {
    if (parsed[index].name !== EXPECTED_PERMIT_FIELDS[index].name
      || parsed[index].type !== EXPECTED_PERMIT_FIELDS[index].type) {
      fail("invalid_quote", "Permit typed data fields do not match EIP-2612", `quote.permit.eip712.types.Permit[${index}]`);
    }
  }
  return parsed;
}

function parsePermitTypedData(
  raw: unknown,
  context: {
    config: SeraDeploymentConfig;
    inputToken: SeraAddress;
    owner: SeraAddress;
    spender: SeraAddress;
    valueRaw: string;
    nonce: string;
    suggestedDeadline: string;
    routeDeadline: string;
    serverTime: number;
    metadataDomain: SeraEip712Domain;
  },
): SeraPermitTypedData {
  const value = asRecord(raw, "invalid_quote", "quote.permit.eip712");
  if (value.primaryType !== "Permit") {
    fail("invalid_quote", "Permit typed data primaryType must be Permit", "quote.permit.eip712.primaryType");
  }
  const domain = parseDomain(value.domain, "invalid_quote", "quote.permit.eip712.domain");
  if (!domainsEqual(domain, context.metadataDomain)) {
    fail("invalid_quote", "Permit typed-data domain does not match permit.domain", "quote.permit.eip712.domain");
  }
  if (domain.chainId !== context.config.chainId) {
    fail("invalid_quote", "Permit domain chain does not match the live Sera chain", "quote.permit.eip712.domain.chainId");
  }
  if (!addressesEqual(domain.verifyingContract, context.inputToken)) {
    fail("invalid_quote", "Permit verifyingContract does not match the input token", "quote.permit.eip712.domain.verifyingContract");
  }
  const types = { Permit: parsePermitTypes(value.types) };
  const message = asRecord(value.message, "invalid_quote", "quote.permit.eip712.message");
  const owner = asAddress(message.owner, "invalid_quote", "quote.permit.eip712.message.owner");
  const spender = asAddress(message.spender, "invalid_quote", "quote.permit.eip712.message.spender");
  const permitValue = uint256(message.value, "invalid_quote", "quote.permit.eip712.message.value");
  const nonce = uint256(message.nonce, "invalid_quote", "quote.permit.eip712.message.nonce");
  const deadline = uintString(
    message.deadline,
    SERA_UINT256_MAX,
    "invalid_quote",
    "quote.permit.eip712.message.deadline",
    { positive: true },
  );
  if (!addressesEqual(owner, context.owner)) {
    fail("invalid_quote", "Permit message owner does not match the quote payer", "quote.permit.eip712.message.owner");
  }
  if (!addressesEqual(spender, context.spender)) {
    fail("invalid_quote", "Permit message spender does not match permit.spender", "quote.permit.eip712.message.spender");
  }
  if (permitValue !== context.valueRaw) {
    fail("invalid_quote", "Permit message value does not match permit.value_raw", "quote.permit.eip712.message.value");
  }
  if (nonce !== context.nonce) {
    fail("invalid_quote", "Permit message nonce does not match permit.nonce", "quote.permit.eip712.message.nonce");
  }
  if (deadline !== context.suggestedDeadline) {
    fail("invalid_quote", "Permit deadline does not match permit.suggested_deadline", "quote.permit.eip712.message.deadline");
  }
  if (BigInt(deadline) <= BigInt(context.serverTime)) {
    fail("invalid_quote", "Permit deadline has expired", "quote.permit.eip712.message.deadline");
  }
  if (BigInt(deadline) > BigInt(context.routeDeadline)) {
    fail("invalid_quote", "Permit deadline must not outlive the signed Sera Intent", "quote.permit.eip712.message.deadline");
  }
  return { domain, primaryType: "Permit", types, message: { owner, spender, value: permitValue, nonce, deadline } };
}

function parsePermitMetadata(
  raw: unknown,
  context: {
    config: SeraDeploymentConfig;
    inputToken: SeraAddress;
    owner: SeraAddress;
    initialDepositAmount: string;
    routeDeadline: string;
    serverTime: number;
  },
): SeraPermitMetadata | null {
  const initialDeposit = BigInt(context.initialDepositAmount);
  if (raw === undefined || raw === null) {
    if (initialDeposit > 0n) {
      fail("invalid_quote", "Wallet-funded quote did not return Permit or approval metadata", "quote.permit");
    }
    return null;
  }
  const value = asRecord(raw, "invalid_quote", "quote.permit");
  if (typeof value.permit_supported !== "boolean") {
    fail("invalid_quote", "quote.permit.permit_supported must be boolean", "quote.permit.permit_supported");
  }
  if (typeof value.permit_required !== "boolean") {
    fail("invalid_quote", "quote.permit.permit_required must be boolean", "quote.permit.permit_required");
  }
  const permitSupported = value.permit_supported;
  const permitRequired = value.permit_required;
  const token = asAddress(value.token, "invalid_quote", "quote.permit.token");
  const spender = asAddress(value.spender, "invalid_quote", "quote.permit.spender");
  const owner = asAddress(value.owner, "invalid_quote", "quote.permit.owner");
  const valueRaw = uint256(value.value_raw, "invalid_quote", "quote.permit.value_raw");
  const currentAllowanceRaw = uint256(
    value.current_allowance_raw,
    "invalid_quote",
    "quote.permit.current_allowance_raw",
  );

  if (!addressesEqual(token, context.inputToken)) {
    fail("invalid_quote", "Permit token does not match the quote input token", "quote.permit.token");
  }
  if (!addressesEqual(owner, context.owner)) {
    fail("invalid_quote", "Permit owner does not match the quote payer", "quote.permit.owner");
  }
  if (!addressesEqual(spender, context.config.sorAddress)) {
    fail("invalid_quote", "Permit or approval spender does not match the live SOR contract", "quote.permit.spender");
  }

  const allowanceCoversDeposit = BigInt(currentAllowanceRaw) >= initialDeposit;
  if (!allowanceCoversDeposit && BigInt(valueRaw) < initialDeposit) {
    fail("invalid_quote", "Permit or approval value does not cover the wallet deposit", "quote.permit.value_raw");
  }
  if (!permitSupported && permitRequired) {
    fail("invalid_quote", "A token without Permit support cannot require a Permit signature", "quote.permit.permit_required");
  }
  if (permitSupported && !permitRequired && !allowanceCoversDeposit) {
    fail("invalid_quote", "Quote requires token authorization but does not request Permit or approval", "quote.permit");
  }

  let nonce: string | null = null;
  let suggestedDeadline: string | null = null;
  let domain: SeraEip712Domain | null = null;
  let typedData: SeraPermitTypedData | null = null;

  if (permitRequired) {
    nonce = uint256(value.nonce, "invalid_quote", "quote.permit.nonce");
    suggestedDeadline = uintString(
      value.suggested_deadline,
      SERA_UINT256_MAX,
      "invalid_quote",
      "quote.permit.suggested_deadline",
      { positive: true },
    );
    domain = parseDomain(value.domain, "invalid_quote", "quote.permit.domain");
    typedData = parsePermitTypedData(value.eip712, {
      config: context.config,
      inputToken: context.inputToken,
      owner,
      spender,
      valueRaw,
      nonce,
      suggestedDeadline,
      routeDeadline: context.routeDeadline,
      serverTime: context.serverTime,
      metadataDomain: domain,
    });
  } else if (value.eip712 !== undefined && value.eip712 !== null) {
    fail("invalid_quote", "Permit typed data was returned although permit_required is false", "quote.permit.eip712");
  }

  const authorizationKind: SeraAuthorizationKind = permitRequired
    ? "permit"
    : allowanceCoversDeposit || initialDeposit === 0n
      ? "none"
      : "approval";
  return {
    permitSupported,
    permitRequired,
    authorizationKind,
    token,
    spender,
    owner,
    valueRaw,
    currentAllowanceRaw,
    nonce,
    suggestedDeadline,
    domain,
    typedData,
  };
}

function quoteRecord(raw: unknown): RecordValue {
  const envelope = asRecord(raw, "invalid_quote", "quote response");
  if (Object.prototype.hasOwnProperty.call(envelope, "quote")) {
    return asRecord(envelope.quote, "invalid_quote", "quote response.quote");
  }
  return envelope;
}

/** Validates an executable quote and every field the payer will authorize. */
export function validateSeraSwapQuote(
  raw: unknown,
  context: {
    request: SeraSwapQuoteRequest;
    config: SeraDeploymentConfig;
    serverTime: number;
  },
): SeraValidatedSwapQuote {
  const now = serverTimestamp(context.serverTime, "invalid_quote");
  const quote = quoteRecord(raw);
  const uuid = asNonEmptyString(quote.uuid, "invalid_quote", "quote.uuid");
  if (!QUOTE_UUID_RE.test(uuid)) {
    fail("invalid_quote", "quote.uuid must be a UUID and must not be confused with route_params.uuid", "quote.uuid");
  }

  const route = asRecord(quote.route_params, "invalid_quote", "quote.route_params");
  const routeParams: SeraValidatedRouteParams = {
    taker: asAddress(route.taker, "invalid_quote", "quote.route_params.taker"),
    inputToken: asAddress(route.inputToken, "invalid_quote", "quote.route_params.inputToken"),
    outputToken: asAddress(route.outputToken, "invalid_quote", "quote.route_params.outputToken"),
    maxInputAmount: uint256(route.maxInputAmount, "invalid_quote", "quote.route_params.maxInputAmount", { positive: true }),
    minOutputAmount: uint256(route.minOutputAmount, "invalid_quote", "quote.route_params.minOutputAmount"),
    recipient: asAddress(route.recipient, "invalid_quote", "quote.route_params.recipient"),
    initialDepositAmount: uint256(
      route.initialDepositAmount,
      "invalid_quote",
      "quote.route_params.initialDepositAmount",
    ),
    uuid: uint256(route.uuid, "invalid_quote", "quote.route_params.uuid", { positive: true }),
    deadline: uintString(
      route.deadline,
      SERA_UINT48_MAX,
      "invalid_quote",
      "quote.route_params.deadline",
      { positive: true },
    ),
  };

  if (!addressesEqual(routeParams.taker, context.request.owner_address)) {
    fail("invalid_quote", "Quote taker does not match the requested owner", "quote.route_params.taker");
  }
  if (!addressesEqual(routeParams.inputToken, context.request.from_token)) {
    fail("invalid_quote", "Quote input token does not match the request", "quote.route_params.inputToken");
  }
  if (!addressesEqual(routeParams.outputToken, context.request.to_token)) {
    fail("invalid_quote", "Quote output token does not match the request", "quote.route_params.outputToken");
  }
  if (!addressesEqual(routeParams.recipient, context.request.recipient)) {
    fail("invalid_quote", "Quote recipient does not match the merchant recipient", "quote.route_params.recipient");
  }
  if (BigInt(routeParams.deadline) !== BigInt(context.request.expiration)) {
    fail("invalid_quote", "Quote Intent deadline does not match the requested expiration", "quote.route_params.deadline");
  }
  if (BigInt(routeParams.deadline) <= BigInt(now)) {
    fail("invalid_quote", "Quote Intent deadline has expired", "quote.route_params.deadline");
  }
  if (BigInt(routeParams.initialDepositAmount) > BigInt(routeParams.maxInputAmount)) {
    fail("invalid_quote", "Quote wallet deposit exceeds maxInputAmount", "quote.route_params.initialDepositAmount");
  }
  if (context.request.gas_mode === "pay_more"
    && BigInt(routeParams.maxInputAmount) < BigInt(context.request.from_amount)) {
    fail("invalid_quote", "pay_more quote maxInputAmount is below the requested input", "quote.route_params.maxInputAmount");
  }
  if (context.request.gas_mode === "receive_less"
    && BigInt(routeParams.maxInputAmount) !== BigInt(context.request.from_amount)) {
    fail("invalid_quote", "receive_less quote must preserve the requested input", "quote.route_params.maxInputAmount");
  }
  if (BigInt(routeParams.minOutputAmount) === 0n) {
    fail("no_liquidity", "Sera returned no executable output for this direction and amount", "quote.route_params.minOutputAmount");
  }

  const fees = asRecord(quote.fee_breakdown, "invalid_quote", "quote.fee_breakdown");
  const feeBreakdown: SeraQuoteFeeBreakdown = {
    gasCostUsd: nonNegativeDecimal(fees.gas_cost_usd, "invalid_quote", "quote.fee_breakdown.gas_cost_usd"),
    gasCostFromToken: nonNegativeDecimal(
      fees.gas_cost_from_token,
      "invalid_quote",
      "quote.fee_breakdown.gas_cost_from_token",
    ),
  };
  const expiresAt = unixUint48(quote.expires_at, "invalid_quote", "quote.expires_at");
  if (expiresAt <= now) fail("invalid_quote", "Sera quote has already expired", "quote.expires_at");
  if (BigInt(expiresAt) > BigInt(routeParams.deadline)) {
    fail("invalid_quote", "Quote record expiry must not outlive the signed Intent", "quote.expires_at");
  }

  const permit = parsePermitMetadata(quote.permit, {
    config: context.config,
    inputToken: routeParams.inputToken,
    owner: routeParams.taker,
    initialDepositAmount: routeParams.initialDepositAmount,
    routeDeadline: routeParams.deadline,
    serverTime: now,
  });
  return { uuid: uuid.toLowerCase(), routeParams, feeBreakdown, expiresAt, permit };
}

/** Rejects a swap amount locally before consuming a Sera quote request. */
export function assertSeraMinimumInput(
  inputAmountRaw: unknown,
  minimumInputRaw: unknown,
  options: { symbol?: string } = {},
): void {
  const input = uint256(inputAmountRaw, "invalid_request", "inputAmountRaw", { positive: true });
  const minimum = uint256(minimumInputRaw, "invalid_request", "minimumInputRaw");
  if (BigInt(input) < BigInt(minimum)) {
    const symbol = options.symbol?.trim().toUpperCase();
    fail(
      "amount_below_min",
      symbol ? `Amount is below Sera's minimum for ${symbol}` : "Amount is below Sera's token minimum",
      "inputAmountRaw",
      { requestedRaw: input, minimumRaw: minimum, ...(symbol ? { symbol } : {}) },
    );
  }
}

/**
 * I1 = ceil(I0 * targetOutput * 1001 / (quotedOutput * 1000)).
 * The 0.1% buffer is explicit and deterministic; no floating point is used.
 */
export function calculateFixedOutputRetryInputRaw(
  currentInputRaw: unknown,
  targetOutputRaw: unknown,
  quotedOutputRaw: unknown,
): string {
  const input = BigInt(uint256(currentInputRaw, "invalid_request", "currentInputRaw", { positive: true }));
  const target = BigInt(uint256(targetOutputRaw, "invalid_request", "targetOutputRaw", { positive: true }));
  const output = BigInt(uint256(quotedOutputRaw, "invalid_quote", "quotedOutputRaw", { positive: true }));
  const numerator = input * target * 1001n;
  const denominator = output * 1000n;
  const adjusted = (numerator + denominator - 1n) / denominator;
  if (adjusted > SERA_UINT256_MAX) {
    fail("output_below_target", "Required input exceeds uint256 capacity", "currentInputRaw");
  }
  return adjusted.toString();
}

function nonNegativeBps(value: unknown, field: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail("invalid_request", `${field} must be an integer from 0 to ${maximum}`, field);
  }
  return value;
}

function enforcePolicy(
  result: { initialRequest: SeraSwapQuoteRequest; quote: SeraValidatedSwapQuote },
  rawPolicy: SeraFixedOutputPolicy | undefined,
): void {
  if (!rawPolicy) return;
  if (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) {
    fail("invalid_request", "policy must be an object", "policy");
  }
  const finalInput = BigInt(result.quote.routeParams.maxInputAmount);
  const initialInput = BigInt(result.initialRequest.from_amount);

  if (rawPolicy.maxInputIncreaseBps !== undefined) {
    const bps = nonNegativeBps(rawPolicy.maxInputIncreaseBps, "policy.maxInputIncreaseBps", 1_000_000);
    if (finalInput * 10_000n > initialInput * BigInt(10_000 + bps)) {
      fail(
        "price_deviation",
        "Final maximum input exceeds the configured increase limit",
        "quote.route_params.maxInputAmount",
        { initialInputRaw: initialInput.toString(), finalInputRaw: finalInput.toString(), maximumIncreaseBps: bps },
      );
    }
  }

  if (rawPolicy.maxGasCostUsd !== undefined) {
    const limit = nonNegativeDecimal(rawPolicy.maxGasCostUsd, "invalid_request", "policy.maxGasCostUsd");
    if (compareDecimals(result.quote.feeBreakdown.gasCostUsd, limit) > 0) {
      fail(
        "fee_too_high",
        "Sera gas cost exceeds the configured USD limit",
        "quote.fee_breakdown.gas_cost_usd",
        { actual: result.quote.feeBreakdown.gasCostUsd, limit },
      );
    }
  }
  if (rawPolicy.maxGasCostFromToken !== undefined) {
    const limit = nonNegativeDecimal(
      rawPolicy.maxGasCostFromToken,
      "invalid_request",
      "policy.maxGasCostFromToken",
    );
    if (compareDecimals(result.quote.feeBreakdown.gasCostFromToken, limit) > 0) {
      fail(
        "fee_too_high",
        "Sera gas cost exceeds the configured input-token limit",
        "quote.fee_breakdown.gas_cost_from_token",
        { actual: result.quote.feeBreakdown.gasCostFromToken, limit },
      );
    }
  }

  if (rawPolicy.priceReference !== undefined) {
    const reference = asRecord(rawPolicy.priceReference, "invalid_request", "policy.priceReference");
    const referenceInput = BigInt(uint256(
      reference.inputAmountRaw,
      "invalid_request",
      "policy.priceReference.inputAmountRaw",
      { positive: true },
    ));
    const referenceOutput = BigInt(uint256(
      reference.outputAmountRaw,
      "invalid_request",
      "policy.priceReference.outputAmountRaw",
      { positive: true },
    ));
    const bps = nonNegativeBps(
      reference.maxAdverseDeviationBps,
      "policy.priceReference.maxAdverseDeviationBps",
      10_000,
    );
    const actualOutput = BigInt(result.quote.routeParams.minOutputAmount);
    const left = actualOutput * referenceInput * 10_000n;
    const right = finalInput * referenceOutput * BigInt(10_000 - bps);
    if (left < right) {
      fail(
        "price_deviation",
        "Protected Sera execution rate exceeds the configured adverse-deviation limit",
        "quote.route_params",
        { maximumAdverseDeviationBps: bps },
      );
    }
  }
}

function nestedProviderCode(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== "object" || depth > 5) return null;
  const value = error as RecordValue;
  for (const key of ["errorCode", "error_code", "code", "error"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().toUpperCase();
  }
  for (const key of ["detail", "cause"]) {
    const candidate = nestedProviderCode(value[key], depth + 1);
    if (candidate) return candidate;
  }
  return null;
}

/** Maps recognized Sera/network failures without mislabelling arbitrary bugs. */
export function mapSeraQuoteProviderError(error: unknown): SeraQuoteValidationError | null {
  if (error instanceof SeraQuoteValidationError) return error;
  const value = error && typeof error === "object" ? error as RecordValue : null;
  const status = value && typeof value.status === "number" ? value.status : null;
  const code = nestedProviderCode(error);
  if (code === "NO_LIQUIDITY") {
    return new SeraQuoteValidationError("no_liquidity", "Sera has no executable route for this direction and amount");
  }
  if (status === 429 || code === "RATE_LIMITED" || code === "TOO_MANY_REQUESTS") {
    return new SeraQuoteValidationError("sera_rate_limited", "Sera quote service is rate limited");
  }
  if (status === 503 || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return new SeraQuoteValidationError("sera_unavailable", "Sera quote service is temporarily unavailable");
  }
  if (value?.name === "AbortError") {
    return new SeraQuoteValidationError("sera_unavailable", "Sera quote request timed out");
  }
  return null;
}

export interface SolveSeraFixedOutputQuoteOptions {
  initialRequest: unknown;
  /** Omit only for an open-amount checkout that needs one validated quote. */
  targetOutputRaw?: unknown;
  minimumInputRaw?: unknown;
  minimumInputSymbol?: string;
  config: unknown;
  expectedChainId: number;
  serverTime: number;
  policy?: SeraFixedOutputPolicy;
  requestQuote: (request: Readonly<SeraSwapQuoteRequest>, attempt: 1 | 2) => Promise<unknown>;
}

/**
 * Gets at most two quotes and returns only when the protected output covers the
 * merchant target. It performs no persistence and mutates neither input nor
 * quote responses.
 */
export async function solveSeraFixedOutputQuote(
  options: SolveSeraFixedOutputQuoteOptions,
): Promise<SeraFixedOutputQuoteResult> {
  const now = serverTimestamp(options.serverTime, "invalid_request");
  const config = validateSeraDeploymentConfig(options.config, options.expectedChainId);
  const initialRequest = validateSeraSwapQuoteRequest(options.initialRequest, {
    serverTime: now,
    expectedGasMode: "pay_more",
  });
  const requestedTargetOutputRaw = options.targetOutputRaw === undefined
    ? null
    : uint256(options.targetOutputRaw, "invalid_request", "targetOutputRaw", { positive: true });
  if (options.minimumInputRaw !== undefined) {
    assertSeraMinimumInput(initialRequest.from_amount, options.minimumInputRaw, { symbol: options.minimumInputSymbol });
  }

  const attempts: SeraFixedOutputQuoteAttempt[] = [];
  const getAttempt = async (request: SeraSwapQuoteRequest, attempt: 1 | 2): Promise<SeraValidatedSwapQuote> => {
    let raw: unknown;
    try {
      raw = await options.requestQuote(Object.freeze({ ...request }), attempt);
    } catch (error) {
      throw mapSeraQuoteProviderError(error) ?? error;
    }
    const quote = validateSeraSwapQuote(raw, { request, config, serverTime: now });
    attempts.push({ attempt, request: { ...request }, quote });
    return quote;
  };

  let finalRequest = initialRequest;
  let quote = await getAttempt(finalRequest, 1);
  // Open-amount payer checkout compatibility: validate exactly one quote and
  // use its protected output as the result target. Merchant preflight must
  // always pass an explicit target and therefore still gets two-quote solving.
  const targetOutputRaw = requestedTargetOutputRaw ?? quote.routeParams.minOutputAmount;
  if (requestedTargetOutputRaw !== null
    && BigInt(quote.routeParams.minOutputAmount) < BigInt(targetOutputRaw)) {
    const adjustedInputRaw = calculateFixedOutputRetryInputRaw(
      finalRequest.from_amount,
      targetOutputRaw,
      quote.routeParams.minOutputAmount,
    );
    finalRequest = { ...initialRequest, from_amount: adjustedInputRaw };
    quote = await getAttempt(finalRequest, 2);
    if (BigInt(quote.routeParams.minOutputAmount) < BigInt(targetOutputRaw)) {
      fail(
        "output_below_target",
        "Sera quote cannot currently protect the requested merchant output",
        "quote.route_params.minOutputAmount",
        { targetOutputRaw, quotedOutputRaw: quote.routeParams.minOutputAmount },
      );
    }
  }

  const result: SeraFixedOutputQuoteResult = {
    initialRequest,
    finalRequest,
    targetOutputRaw,
    quote,
    attempts,
  };
  enforcePolicy(result, options.policy);
  return result;
}

/**
 * Builds the disposable merchant-preflight result. Quote UUID, signed route,
 * and Permit data are intentionally impossible to obtain from this summary.
 */
export function toSeraPreflightSummary(
  result: SeraFixedOutputQuoteResult,
  checkedAt: number,
): SeraPreflightSummary {
  const now = serverTimestamp(checkedAt, "invalid_request", "checkedAt");
  return {
    executable: true,
    advisory: true,
    requiresCustomerRequote: true,
    source: "sera-swap-quote",
    requestedInputAmountRaw: result.initialRequest.from_amount,
    quotedInputAmountRaw: result.finalRequest.from_amount,
    maximumInputAmountRaw: result.quote.routeParams.maxInputAmount,
    targetOutputAmountRaw: result.targetOutputRaw,
    minimumOutputAmountRaw: result.quote.routeParams.minOutputAmount,
    feeBreakdown: { ...result.quote.feeBreakdown },
    checkedAt: now,
    quoteExpiresAt: result.quote.expiresAt,
    attemptCount: result.attempts.length as 1 | 2,
  };
}
