const EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

export type DecodedErc20TransferEvidence = {
  tokenAddress?: unknown;
  fromAddress?: unknown;
  toAddress?: unknown;
  amountRaw?: unknown;
};

export type DirectTransferEvidenceSelection =
  | { kind: "direct"; sender: `0x${string}`; amountRaw: bigint }
  | { kind: "sera_vault"; sender: `0x${string}`; amountRaw: bigint };

function normalizeAddress(value: unknown): `0x${string}` | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return EVM_ADDRESS_PATTERN.test(normalized) ? normalized as `0x${string}` : null;
}

function unsignedRawAmount(value: unknown): bigint | null {
  try {
    if (typeof value === "bigint") return value >= 0n ? value : null;
    if (typeof value === "number") {
      return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
    }
    if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
    const amount = BigInt(value.trim());
    return amount >= 0n ? amount : null;
  } catch {
    return null;
  }
}

/**
 * Select authoritative ERC-20 evidence for a direct payment.
 *
 * A matching Sera Vault transfer always wins over a direct candidate, even if
 * the direct log appears first. This prevents a batched transaction containing
 * several matching transfers from being claimed by the generic payment path.
 */
export function selectDirectTransferEvidence({
  transfers,
  expectedTokenAddress,
  expectedRecipientAddress,
  expectedAmountRaw,
  seraVaultAddresses,
}: {
  transfers: readonly DecodedErc20TransferEvidence[];
  expectedTokenAddress: string;
  expectedRecipientAddress: string;
  expectedAmountRaw: bigint;
  seraVaultAddresses: ReadonlySet<string>;
}): DirectTransferEvidenceSelection | null {
  const expectedToken = normalizeAddress(expectedTokenAddress);
  const expectedRecipient = normalizeAddress(expectedRecipientAddress);
  if (!expectedToken || !expectedRecipient || expectedRecipient === ZERO_ADDRESS || expectedAmountRaw <= 0n) {
    return null;
  }

  const normalizedVaults = new Set(
    Array.from(seraVaultAddresses, normalizeAddress)
      .filter((address): address is `0x${string}` => address !== null && address !== ZERO_ADDRESS),
  );
  let directCandidate: DirectTransferEvidenceSelection | null = null;

  for (const transfer of transfers) {
    const token = normalizeAddress(transfer.tokenAddress);
    const recipient = normalizeAddress(transfer.toAddress);
    const sender = normalizeAddress(transfer.fromAddress);
    const amountRaw = unsignedRawAmount(transfer.amountRaw);
    if (
      token !== expectedToken
      || recipient !== expectedRecipient
      || !sender
      || sender === ZERO_ADDRESS
      || amountRaw === null
    ) continue;

    if (normalizedVaults.has(sender)) {
      return { kind: "sera_vault", sender, amountRaw };
    }
    if (amountRaw === 0n) continue;

    const difference = amountRaw > expectedAmountRaw
      ? amountRaw - expectedAmountRaw
      : expectedAmountRaw - amountRaw;
    if (difference > 1n) continue;

    const selection: DirectTransferEvidenceSelection = {
      kind: "direct",
      sender,
      amountRaw,
    };
    directCandidate ??= selection;
  }

  return directCandidate;
}
