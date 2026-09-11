import { describe, expect, it } from "vitest";
import type { Transaction } from "../drizzle/schema";
import {
  SERA_SWAP_ALREADY_CLAIMED_STATES,
  SERA_NO_SETTLEMENT_FAILURE_CODE,
  completeSeraSwapOutcomeSync,
  claimDirectTransactionCancellation,
  claimDirectTransactionConfirmation,
  claimDirectTransactionFailure,
  claimDirectTransactionNotification,
  createMenuOrder,
  createPaymentIntent,
  claimSeraSwapPostNetworkUpdate,
  claimSeraSwapTerminalFailure,
  claimSeraSwapSubmission,
  claimSeraSwapSettlementConfirmation,
  claimSeraSwapProvisionalSettlement,
  clearSeraSwapProvisionalSettlement,
  classifySeraSwapProvisionalSettlement,
  classifySeraSwapTerminalFailure,
  classifySeraSwapPostNetworkUpdate,
  classifySeraSwapSubmissionClaim,
  classifySeraSwapSettlementConfirmation,
  classifyDirectTransactionNotification,
  createTransaction,
  getMenuOrderById,
  getPendingSeraSwapTransactions,
  getRecentPendingSeraSwapTransactions,
  getPaymentIntentById,
  getSeraVaultAddressesForChain,
  getSeraSwapTerminalOutcome,
  getActiveSeraSwapTransactionByCheckoutAttemptKey,
  getTransactionById,
  getTransactionByHash,
  getUnsyncedSeraSwapOutcomes,
  isUnresolvedSeraSwapForReconciliation,
  isCompatibleSeraBatchSettlementHashOwner,
  isSeraSwapQuoteRefreshable,
  prepareSeraSwapOutcomeSync,
  markSeraIntentMatchedEvidence,
  releaseTentativeDirectTransactionHash,
  updateTransaction,
  updatePaymentIntent,
  refreshSeraSwapQuote,
  reopenSeraSwapAfterStaleRejection,
  type SeraSwapQuoteRefreshPatch,
} from "./db";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const INTENT_HASH = `0x${"ab".repeat(32)}`;
const SETTLEMENT_HASH = `0x${"12".repeat(32)}`;
const AFTER_DEADLINE = new Date("2026-09-04T12:03:00.000Z");

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "transaction-1",
    merchantId: "merchant-1",
    txHash: null,
    fromAddress: "0x1111111111111111111111111111111111111111",
    toAddress: "0x2222222222222222222222222222222222222222",
    coin: "USDC",
    amount: "1",
    amountUsd: null,
    chainId: 1,
    status: "pending",
    payCoin: "IDRT",
    payAmount: "2000",
    memo: null,
    notes: null,
    checkoutAttemptKey: null,
    quoteUuid: "quote-1",
    routeUuid: "123",
    intentHash: INTENT_HASH,
    tradeId: null,
    seraAddress: null,
    seraVaultAddress: null,
    seraSorAddress: null,
    payTokenAddress: "0x3333333333333333333333333333333333333333",
    receiveTokenAddress: "0x4444444444444444444444444444444444444444",
    payTokenDecimals: null,
    receiveTokenDecimals: null,
    requestedPayAmountRaw: "2000000000000000000000",
    maximumPayAmountRaw: "2100000000000000000000",
    targetReceiveAmountRaw: "1000000",
    minimumReceiveAmountRaw: "1000000",
    initialDepositAmountRaw: "0",
    quoteExpiresAt: new Date("2026-09-04T12:01:00.000Z"),
    intentDeadline: new Date("2026-09-04T12:02:00.000Z"),
    permitRequired: 1,
    permitDeadline: new Date("2026-09-04T12:02:00.000Z"),
    submitState: "quote_ready",
    submittedBlockNumber: null,
    seraStatus: null,
    intentMatchedAt: null,
    intentMatchedTxHash: null,
    intentMatchedBlockNumber: null,
    provisionalSettlementAt: null,
    provisionalSettlementTxHash: null,
    provisionalSettlementBlockNumber: null,
    provisionalSettlementBlockHash: null,
    provisionalSettlementConfirmations: null,
    seraOutcomeSyncedAt: null,
    actualPayAmountRaw: null,
    actualReceiveAmountRaw: null,
    feeAmountRaw: null,
    feeTokenAddress: null,
    settlementTxHash: null,
    failureCode: null,
    verified: 0,
    notifiedAt: null,
    webhookSentAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const claimInput = {
  transactionId: "transaction-1",
  quoteUuid: "quote-1",
  intentHash: INTENT_HASH,
  now: NOW,
};

function makeRefreshPatch(quoteUuid: string): SeraSwapQuoteRefreshPatch {
  return {
    quoteUuid,
    routeUuid: "456",
    intentHash: `0x${"ef".repeat(32)}`,
    seraAddress: "0x1111111111111111111111111111111111111111",
    seraVaultAddress: "0x2222222222222222222222222222222222222222",
    seraSorAddress: "0x5555555555555555555555555555555555555555",
    payTokenAddress: "0x3333333333333333333333333333333333333333",
    receiveTokenAddress: "0x4444444444444444444444444444444444444444",
    payTokenDecimals: 18,
    receiveTokenDecimals: 6,
    requestedPayAmountRaw: "2200000000000000000000",
    maximumPayAmountRaw: "2300000000000000000000",
    targetReceiveAmountRaw: "1000000",
    minimumReceiveAmountRaw: "1000000",
    initialDepositAmountRaw: "0",
    quoteExpiresAt: new Date("2026-09-04T12:03:00.000Z"),
    intentDeadline: new Date("2026-09-04T12:04:00.000Z"),
    permitRequired: 0,
    permitDeadline: null,
    amount: "1",
    payAmount: "2300",
  };
}

async function seedMemoryTransaction(id: string, overrides: Partial<Transaction> = {}): Promise<void> {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...insert } = makeTransaction({ id, ...overrides });
  await createTransaction(insert);
}

async function seedTerminalSeraTransaction({
  id,
  kind,
  notes = null,
  intentHash = INTENT_HASH,
  quoteUuid = "quote-1",
  txHash = SETTLEMENT_HASH,
  failureCode = "provider_rejected",
  updatedAt,
}: {
  id: string;
  kind: "confirmed" | "failed";
  notes?: string | null;
  intentHash?: string;
  quoteUuid?: string;
  txHash?: string;
  failureCode?: string;
  updatedAt?: Date;
}): Promise<void> {
  const transaction = makeTransaction({
    id,
    notes,
    quoteUuid,
    intentHash,
    status: kind === "confirmed" ? "confirmed" : "failed",
    verified: kind === "confirmed" ? 1 : 0,
    submitState: kind === "confirmed" ? "settled" : "failed",
    txHash: kind === "confirmed" ? txHash : null,
    settlementTxHash: kind === "confirmed" ? txHash : null,
    failureCode: kind === "confirmed" ? null : failureCode,
    seraStatus: kind === "confirmed" ? "settled" : "failed",
    seraOutcomeSyncedAt: null,
    ...(updatedAt ? { createdAt: updatedAt, updatedAt } : {}),
  });
  await createTransaction(transaction);
}

async function seedLinkedPaymentIntent(
  id: string,
  status: "created" | "open" | "paid" | "expired" | "canceled" | "failed" = "open",
  merchantId = "merchant-1",
): Promise<void> {
  await createPaymentIntent({
    id,
    merchantId,
    subWalletId: null,
    amount: "1",
    coin: "USDC",
    receiverAddress: "0x2222222222222222222222222222222222222222",
    chainId: 1,
    customerEmail: null,
    customerName: null,
    description: null,
    metadata: null,
    checkoutUrl: `https://pay.sera.cx/pay/${id}`,
    status,
    expiresAt: null,
  });
}

async function seedLinkedMenuOrder({
  id,
  status = "payment_pending",
  merchantId = "merchant-1",
  paymentId = null,
  transactionId = null,
  paymentIntentId = null,
}: {
  id: string;
  status?: string;
  merchantId?: string;
  paymentId?: string | null;
  transactionId?: string | null;
  paymentIntentId?: string | null;
}): Promise<void> {
  await createMenuOrder({
    id,
    merchantId,
    menuId: `menu-${id}`,
    paymentId,
    paymentIntentId,
    transactionId,
    status,
    pax: 1,
    businessCategory: null,
    category1: null,
    category2: null,
    category3: null,
    category4: null,
    category5: null,
    category6: null,
    items: "[]",
    amount: "1",
    coin: "USDC",
    customerName: null,
  });
}

describe("Sera submission claim classification", () => {
  it("allows exactly a pending quote_ready transaction with matching bindings", () => {
    expect(classifySeraSwapSubmissionClaim(makeTransaction(), claimInput)).toBe("claimable");
  });

  it("does not let a different quote or Intent claim the transaction", () => {
    expect(classifySeraSwapSubmissionClaim(makeTransaction(), { ...claimInput, quoteUuid: "quote-2" }))
      .toBe("binding_mismatch");
    expect(classifySeraSwapSubmissionClaim(makeTransaction(), { ...claimInput, intentHash: `0x${"cd".repeat(32)}` }))
      .toBe("binding_mismatch");
  });

  it.each(SERA_SWAP_ALREADY_CLAIMED_STATES)("treats %s as already consumed or in flight", (submitState) => {
    expect(classifySeraSwapSubmissionClaim(makeTransaction({ submitState }), claimInput)).toBe("already_claimed");
  });

  it("treats a confirming payment as already claimed even if its lifecycle write is stale", () => {
    expect(classifySeraSwapSubmissionClaim(makeTransaction({ status: "confirming" }), claimInput))
      .toBe("already_claimed");
  });

  it("rejects direct, terminal, and expired transactions", () => {
    expect(classifySeraSwapSubmissionClaim(makeTransaction({ quoteUuid: null, intentHash: null, submitState: null }), claimInput))
      .toBe("invalid_state");
    expect(classifySeraSwapSubmissionClaim(makeTransaction({ status: "failed", submitState: "failed" }), claimInput))
      .toBe("invalid_state");
    expect(classifySeraSwapSubmissionClaim(makeTransaction({ quoteExpiresAt: NOW }), claimInput))
      .toBe("invalid_state");
    expect(classifySeraSwapSubmissionClaim(makeTransaction({ intentDeadline: NOW }), claimInput))
      .toBe("invalid_state");
  });

  it("reports a missing transaction", () => {
    expect(classifySeraSwapSubmissionClaim(undefined, claimInput)).toBe("not_found");
  });
});

describe("Sera quote refresh compare-and-set classification", () => {
  it("matches only the exact current quote while it is still pending and quote_ready", () => {
    expect(isSeraSwapQuoteRefreshable(makeTransaction(), "quote-1")).toBe(true);
    expect(isSeraSwapQuoteRefreshable(makeTransaction(), "quote-2")).toBe(false);
    expect(isSeraSwapQuoteRefreshable(makeTransaction({ status: "confirming" }), "quote-1")).toBe(false);
    expect(isSeraSwapQuoteRefreshable(makeTransaction({ submitState: "submitting" }), "quote-1")).toBe(false);
  });

  it("allows legacy null adoption only when null is explicitly expected", () => {
    const legacy = makeTransaction({ quoteUuid: null, submitState: null });
    expect(isSeraSwapQuoteRefreshable(legacy, null)).toBe(true);
    expect(isSeraSwapQuoteRefreshable(legacy, "quote-1")).toBe(false);
    expect(isSeraSwapQuoteRefreshable(makeTransaction(), null)).toBe(false);
  });

  it("also permits an explicitly expected null quote already marked quote_ready", () => {
    expect(isSeraSwapQuoteRefreshable(makeTransaction({ quoteUuid: null }), null)).toBe(true);
  });

  it("does not overwrite a quote after submission has atomically claimed it", async () => {
    const transactionId = "refresh-loses-to-claim";
    await seedMemoryTransaction(transactionId);

    const claim = await claimSeraSwapSubmission({
      ...claimInput,
      transactionId,
      submittedBlockNumber: "12345678",
    });
    expect(claim.outcome).toBe("claimed");

    const refreshed = await refreshSeraSwapQuote(transactionId, "quote-1", makeRefreshPatch("quote-2"));
    expect(refreshed).toBeUndefined();
    expect((await getTransactionById(transactionId))?.submitState).toBe("submitting");
    expect((await getTransactionById(transactionId))?.submittedBlockNumber).toBe("12345678");
  });

  it("invalidates the old claim binding when quote refresh wins first", async () => {
    const transactionId = "refresh-wins-before-claim";
    await seedMemoryTransaction(transactionId);

    const refreshed = await refreshSeraSwapQuote(transactionId, "quote-1", makeRefreshPatch("quote-2"));
    expect(refreshed?.quoteUuid).toBe("quote-2");
    expect(refreshed?.submitState).toBe("quote_ready");

    const staleClaim = await claimSeraSwapSubmission({ ...claimInput, transactionId });
    expect(staleClaim.outcome).toBe("binding_mismatch");
    expect((await getTransactionById(transactionId))?.quoteUuid).toBe("quote-2");
  });
});

describe("first-payment-wins checkout ownership", () => {
  it("lets only one Sera transaction claim a menu order and payment intent", async () => {
    const orderId = "sera-first-payment-order";
    const paymentIntentId = "sera-first-payment-intent";
    const firstId = "sera-first-payment-first";
    const secondId = "sera-first-payment-second";
    const secondIntentHash = `0x${"d1".repeat(32)}`;
    await seedLinkedPaymentIntent(paymentIntentId);
    await seedLinkedMenuOrder({ id: orderId, paymentIntentId });
    const notes = JSON.stringify({ orderId, paymentIntentId });
    await seedMemoryTransaction(firstId, { notes });
    await seedMemoryTransaction(secondId, {
      notes,
      quoteUuid: "quote-first-payment-second",
      intentHash: secondIntentHash,
      routeUuid: "789",
    });

    const first = await claimSeraSwapSubmission({ ...claimInput, transactionId: firstId });
    const second = await claimSeraSwapSubmission({
      transactionId: secondId,
      quoteUuid: "quote-first-payment-second",
      intentHash: secondIntentHash,
      now: NOW,
    });

    expect(first.outcome).toBe("claimed");
    expect(second.outcome).toBe("binding_conflict");
    expect(await getMenuOrderById(orderId)).toMatchObject({
      status: "payment_submitted",
      paymentId: firstId,
      transactionId: firstId,
    });
    expect(await getPaymentIntentById(paymentIntentId)).toMatchObject({
      status: "processing",
      transactionId: firstId,
    });
    expect(await getTransactionById(secondId)).toMatchObject({
      status: "pending",
      submitState: "quote_ready",
    });
  });
});

describe("quote-time Sera Vault history", () => {
  it("returns normalized distinct Vaults for one chain across config rotations", async () => {
    const firstVault = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const secondVault = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const rows = [
      makeTransaction({
        id: "vault-history-1",
        quoteUuid: "vault-history-quote-1",
        routeUuid: "8801",
        intentHash: `0x${"81".repeat(32)}`,
        seraVaultAddress: firstVault.toUpperCase().replace("0X", "0x"),
      }),
      makeTransaction({
        id: "vault-history-2",
        quoteUuid: "vault-history-quote-2",
        routeUuid: "8802",
        intentHash: `0x${"82".repeat(32)}`,
        seraVaultAddress: firstVault,
      }),
      makeTransaction({
        id: "vault-history-3",
        quoteUuid: "vault-history-quote-3",
        routeUuid: "8803",
        intentHash: `0x${"83".repeat(32)}`,
        seraVaultAddress: secondVault,
      }),
      makeTransaction({
        id: "vault-history-other-chain",
        chainId: 11155111,
        quoteUuid: "vault-history-quote-4",
        routeUuid: "8804",
        intentHash: `0x${"84".repeat(32)}`,
        seraVaultAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
      }),
    ];
    for (const row of rows) {
      const { createdAt: _createdAt, updatedAt: _updatedAt, ...insert } = row;
      await createTransaction(insert);
    }

    const vaults = await getSeraVaultAddressesForChain(1);
    expect(vaults).toEqual(expect.arrayContaining([firstVault, secondVault]));
    expect(vaults.filter((address) => address === firstVault)).toHaveLength(1);
    expect(vaults).not.toContain("0xcccccccccccccccccccccccccccccccccccccccc");
  });
});

describe("guarded post-network Sera lifecycle updates", () => {
  const networkInput = {
    transactionId: "transaction-1",
    quoteUuid: "quote-1",
    intentHash: INTENT_HASH,
  };

  it.each(["submitting", "submitted", "settlement_unknown"] as const)(
    "allows advisory writes in unresolved %s state",
    (submitState) => {
      expect(classifySeraSwapPostNetworkUpdate(
        makeTransaction({ status: "confirming", submitState }),
        networkInput,
      )).toBe("claimable");
    },
  );

  it("requires exact quote, Intent, and optional trade bindings", () => {
    const transaction = makeTransaction({
      status: "confirming",
      submitState: "submitted",
      tradeId: "trade-1",
    });
    expect(classifySeraSwapPostNetworkUpdate(transaction, {
      ...networkInput,
      quoteUuid: "quote-2",
    })).toBe("binding_mismatch");
    expect(classifySeraSwapPostNetworkUpdate(transaction, {
      ...networkInput,
      intentHash: `0x${"cd".repeat(32)}`,
    })).toBe("binding_mismatch");
    expect(classifySeraSwapPostNetworkUpdate(transaction, {
      ...networkInput,
      expectedTradeId: "trade-2",
    })).toBe("binding_mismatch");
    expect(classifySeraSwapPostNetworkUpdate(transaction, {
      ...networkInput,
      expectedTradeId: "trade-1",
    })).toBe("claimable");
  });

  it("cannot downgrade an already confirmed or failed row", () => {
    expect(classifySeraSwapPostNetworkUpdate(makeTransaction({
      status: "confirmed",
      verified: 1,
      submitState: "settled",
    }), networkInput)).toBe("invalid_state");
    expect(classifySeraSwapPostNetworkUpdate(makeTransaction({
      status: "failed",
      verified: 0,
      submitState: "failed",
    }), networkInput)).toBe("invalid_state");
  });

  it("clears linked-outcome sync ownership on an explicit provider failure", async () => {
    const transactionId = "post-network-explicit-failure";
    await seedMemoryTransaction(transactionId);
    await claimSeraSwapSubmission({ ...claimInput, transactionId });
    const { updateSeraSwapLifecycle } = await import("./db");
    await updateSeraSwapLifecycle(transactionId, { seraOutcomeSyncedAt: NOW });

    const result = await claimSeraSwapPostNetworkUpdate({
      ...networkInput,
      transactionId,
      patch: {
        status: "failed",
        submitState: "failed",
        seraStatus: "failed",
        failureCode: "provider_rejected",
      },
    });

    expect(result.outcome).toBe("claimed");
    expect(result.transaction).toMatchObject({
      status: "failed",
      submitState: "failed",
      failureCode: "provider_rejected",
      seraOutcomeSyncedAt: null,
    });
  });

  it("does not apply GET /orders evidence after the durable trade binding changes", async () => {
    const transactionId = "post-network-trade-binding";
    await seedMemoryTransaction(transactionId);
    await claimSeraSwapSubmission({ ...claimInput, transactionId });
    const { updateSeraSwapLifecycle } = await import("./db");
    await updateSeraSwapLifecycle(transactionId, {
      tradeId: "trade-current",
      submitState: "submitted",
    });

    const stale = await claimSeraSwapPostNetworkUpdate({
      ...networkInput,
      transactionId,
      expectedTradeId: "trade-stale",
      patch: { seraStatus: "settled" },
    });
    expect(stale.outcome).toBe("binding_mismatch");
    expect(stale.transaction.seraStatus).not.toBe("settled");

    const current = await claimSeraSwapPostNetworkUpdate({
      ...networkInput,
      transactionId,
      expectedTradeId: "trade-current",
      patch: { seraStatus: "pending" },
    });
    expect(current.outcome).toBe("claimed");
    expect(current.transaction.seraStatus).toBe("pending");
  });

  it("does not let callers override the linked-outcome sync marker", async () => {
    await expect(claimSeraSwapPostNetworkUpdate({
      ...networkInput,
      patch: { seraOutcomeSyncedAt: NOW } as never,
    })).rejects.toThrow("Invalid post-network Sera patch field: seraOutcomeSyncedAt");
  });

  it("cannot overwrite a concurrent authoritative settlement confirmation", async () => {
    const transactionId = "post-network-races-settlement";
    const raceSettlementHash = `0x${"74".repeat(32)}`;
    await seedMemoryTransaction(transactionId);
    await claimSeraSwapSubmission({ ...claimInput, transactionId });

    const [networkResult, settlementResult] = await Promise.all([
      claimSeraSwapPostNetworkUpdate({
        ...networkInput,
        transactionId,
        patch: {
          submitState: "submitted",
          seraStatus: "pending",
          failureCode: "stale_provider_status",
        },
      }),
      claimSeraSwapSettlementConfirmation({
        transactionId,
        intentHash: INTENT_HASH,
        expectedQuoteUuid: "quote-1",
        txHash: raceSettlementHash,
      }),
    ]);

    expect(["claimed", "invalid_state"]).toContain(networkResult.outcome);
    expect(settlementResult.outcome).toBe("claimed");
    expect(await getTransactionById(transactionId)).toMatchObject({
      status: "confirmed",
      verified: 1,
      submitState: "settled",
      seraStatus: "settled",
      failureCode: null,
      txHash: raceSettlementHash,
      settlementTxHash: raceSettlementHash,
    });

    const stale = await claimSeraSwapPostNetworkUpdate({
      ...networkInput,
      transactionId,
      patch: { status: "failed", submitState: "failed", seraStatus: "failed" },
    });
    expect(stale.outcome).toBe("invalid_state");
    expect(stale.transaction.status).toBe("confirmed");
  });

  it("does not let a late provider failure overwrite provisional chain evidence", async () => {
    const transactionId = "post-network-failure-after-provisional";
    await seedMemoryTransaction(transactionId);
    await claimSeraSwapSubmission({ ...claimInput, transactionId });
    await claimSeraSwapProvisionalSettlement({
      transactionId,
      intentHash: INTENT_HASH,
      quoteUuid: "quote-1",
      txHash: SETTLEMENT_HASH,
      blockNumber: "12345",
      blockHash: `0x${"34".repeat(32)}`,
      confirmations: 2,
    });

    const failure = await claimSeraSwapPostNetworkUpdate({
      ...networkInput,
      transactionId,
      patch: {
        status: "failed",
        submitState: "failed",
        seraStatus: "failed",
        failureCode: "late_provider_failure",
      },
    });
    expect(failure.outcome).toBe("invalid_state");
    expect(failure.transaction).toMatchObject({
      status: "confirming",
      verified: 0,
      provisionalSettlementTxHash: SETTLEMENT_HASH,
    });
  });

  it("does not reopen a stale quote after provisional chain evidence arrives", async () => {
    const transactionId = "stale-reopen-after-provisional";
    await seedMemoryTransaction(transactionId);
    await claimSeraSwapSubmission({ ...claimInput, transactionId });
    await claimSeraSwapProvisionalSettlement({
      transactionId,
      intentHash: INTENT_HASH,
      quoteUuid: "quote-1",
      txHash: SETTLEMENT_HASH,
      blockNumber: "12345",
      blockHash: `0x${"34".repeat(32)}`,
      confirmations: 2,
    });

    const reopened = await reopenSeraSwapAfterStaleRejection({
      transactionId,
      intentHash: INTENT_HASH,
      quoteUuid: "quote-1",
      notes: JSON.stringify({ type: "sera_swap", seraStatus: "quote_stale" }),
    });
    expect(reopened.outcome).toBe("invalid_state");
    expect(reopened.transaction).toMatchObject({
      status: "confirming",
      submitState: "submitting",
      provisionalSettlementTxHash: SETTLEMENT_HASH,
    });
  });
});

describe("Sera provisional settlement compare-and-set", () => {
  const provisionalInput = {
    transactionId: "transaction-1",
    intentHash: INTENT_HASH,
    quoteUuid: "quote-1",
    txHash: SETTLEMENT_HASH,
    blockNumber: "12345",
    blockHash: `0x${"34".repeat(32)}`,
    confirmations: 2,
  };

  it("is claimable only for an unresolved, exact quote and Intent", () => {
    expect(classifySeraSwapProvisionalSettlement(
      makeTransaction({ status: "confirming", submitState: "submitted" }),
      provisionalInput,
    )).toBe("claimable");
    expect(classifySeraSwapProvisionalSettlement(
      makeTransaction({ status: "confirmed", verified: 1, submitState: "settled" }),
      provisionalInput,
    )).toBe("invalid_state");
    expect(classifySeraSwapProvisionalSettlement(
      makeTransaction({ status: "confirming", submitState: "submitted" }),
      { ...provisionalInput, quoteUuid: "different-quote" },
    )).toBe("binding_mismatch");
  });

  it("persists receipt evidence without confirming, paying, or claiming the terminal hash", async () => {
    const transactionId = "provisional-settlement";
    await seedMemoryTransaction(transactionId);
    await claimSeraSwapSubmission({ ...claimInput, transactionId });
    const { updateSeraSwapLifecycle } = await import("./db");
    await updateSeraSwapLifecycle(transactionId, { submitState: "submitted" });

    const results = await Promise.all([
      claimSeraSwapProvisionalSettlement({ ...provisionalInput, transactionId }),
      claimSeraSwapProvisionalSettlement({ ...provisionalInput, transactionId }),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["already_observed", "claimed"]);
    expect(await getTransactionById(transactionId)).toMatchObject({
      status: "confirming",
      verified: 0,
      txHash: null,
      settlementTxHash: null,
      submitState: "submitted",
      provisionalSettlementTxHash: SETTLEMENT_HASH,
      provisionalSettlementBlockNumber: "12345",
      provisionalSettlementBlockHash: provisionalInput.blockHash,
      provisionalSettlementConfirmations: 2,
      seraOutcomeSyncedAt: null,
      webhookSentAt: null,
    });
  });

  it("clears only the exact observation after an explicit canonical mismatch", async () => {
    const transactionId = "provisional-reorg";
    await seedMemoryTransaction(transactionId);
    await claimSeraSwapSubmission({ ...claimInput, transactionId });
    const { updateSeraSwapLifecycle } = await import("./db");
    await updateSeraSwapLifecycle(transactionId, { submitState: "submitted" });
    await claimSeraSwapProvisionalSettlement({ ...provisionalInput, transactionId });

    const wrong = await clearSeraSwapProvisionalSettlement({
      ...provisionalInput,
      transactionId,
      blockHash: `0x${"56".repeat(32)}`,
    });
    expect(wrong.outcome).toBe("evidence_mismatch");
    expect(wrong.transaction.provisionalSettlementAt).not.toBeNull();

    const cleared = await clearSeraSwapProvisionalSettlement({ ...provisionalInput, transactionId });
    expect(cleared.outcome).toBe("cleared");
    expect(cleared.transaction).toMatchObject({
      status: "confirming",
      verified: 0,
      provisionalSettlementAt: null,
      provisionalSettlementTxHash: null,
      provisionalSettlementBlockNumber: null,
      provisionalSettlementBlockHash: null,
      provisionalSettlementConfirmations: null,
    });
  });

  it("promotes matching provisional evidence only through the terminal settlement CAS", async () => {
    const transactionId = "provisional-promoted-at-finality";
    await seedMemoryTransaction(transactionId);
    await claimSeraSwapSubmission({ ...claimInput, transactionId });
    const { updateSeraSwapLifecycle } = await import("./db");
    await updateSeraSwapLifecycle(transactionId, { submitState: "submitted" });
    await claimSeraSwapProvisionalSettlement({ ...provisionalInput, transactionId });

    const final = await claimSeraSwapSettlementConfirmation({
      transactionId,
      intentHash: INTENT_HASH,
      txHash: SETTLEMENT_HASH,
      expectedQuoteUuid: "quote-1",
    });
    expect(final.outcome).toBe("claimed");
    expect(final.transaction).toMatchObject({
      status: "confirmed",
      verified: 1,
      submitState: "settled",
      txHash: SETTLEMENT_HASH,
      settlementTxHash: SETTLEMENT_HASH,
      provisionalSettlementAt: null,
      provisionalSettlementTxHash: null,
      provisionalSettlementBlockNumber: null,
      provisionalSettlementBlockHash: null,
      provisionalSettlementConfirmations: null,
    });
  });

  it("never lets a concurrent provisional clear downgrade terminal finalization", async () => {
    const transactionId = "provisional-clear-finalize-race";
    await seedMemoryTransaction(transactionId);
    await claimSeraSwapSubmission({ ...claimInput, transactionId });
    const { updateSeraSwapLifecycle } = await import("./db");
    await updateSeraSwapLifecycle(transactionId, { submitState: "submitted" });
    await claimSeraSwapProvisionalSettlement({ ...provisionalInput, transactionId });

    await Promise.all([
      clearSeraSwapProvisionalSettlement({ ...provisionalInput, transactionId }),
      claimSeraSwapSettlementConfirmation({
        transactionId,
        intentHash: INTENT_HASH,
        txHash: SETTLEMENT_HASH,
        expectedQuoteUuid: "quote-1",
      }),
    ]);
    expect(await getTransactionById(transactionId)).toMatchObject({
      status: "confirmed",
      verified: 1,
      submitState: "settled",
      txHash: SETTLEMENT_HASH,
      settlementTxHash: SETTLEMENT_HASH,
      provisionalSettlementAt: null,
      provisionalSettlementTxHash: null,
      provisionalSettlementBlockNumber: null,
      provisionalSettlementBlockHash: null,
      provisionalSettlementConfirmations: null,
    });
  });

  it("does not complete linked resources from provisional evidence", async () => {
    const transactionId = "provisional-linked-nonterminal";
    const paymentIntentId = "provisional-linked-intent";
    const orderId = "provisional-linked-order";
    await seedLinkedPaymentIntent(paymentIntentId);
    await seedLinkedMenuOrder({
      id: orderId,
      paymentIntentId,
      paymentId: transactionId,
      transactionId,
    });
    await updatePaymentIntent(paymentIntentId, { status: "processing", transactionId });
    await seedMemoryTransaction(transactionId, { notes: JSON.stringify({ orderId, paymentIntentId }) });
    await claimSeraSwapSubmission({ ...claimInput, transactionId });
    const { updateSeraSwapLifecycle } = await import("./db");
    await updateSeraSwapLifecycle(transactionId, { submitState: "submitted" });
    await claimSeraSwapProvisionalSettlement({ ...provisionalInput, transactionId });

    expect(await getPaymentIntentById(paymentIntentId)).toMatchObject({
      status: "processing",
      transactionId,
    });
    expect(await getMenuOrderById(orderId)).toMatchObject({
      status: "payment_submitted",
      transactionId,
    });
  });
});

describe("Sera settlement confirmation compare-and-set", () => {
  const settlementInput = {
    transactionId: "transaction-1",
    intentHash: INTENT_HASH,
    txHash: SETTLEMENT_HASH,
    expectedQuoteUuid: "quote-1",
  };

  it.each(["submitting", "submitted", "settlement_unknown"] as const)(
    "classifies %s as claimable only while the payment is confirming",
    (submitState) => {
      expect(classifySeraSwapSettlementConfirmation(
        makeTransaction({ status: "confirming", submitState }),
        settlementInput,
      )).toBe("claimable");
      expect(classifySeraSwapSettlementConfirmation(
        makeTransaction({ status: "pending", submitState }),
        settlementInput,
      )).toBe("invalid_state");
    },
  );

  it("recognizes an idempotent confirmation and rejects conflicting hashes", () => {
    const confirmed = makeTransaction({
      status: "confirmed",
      verified: 1,
      submitState: "settled",
      txHash: SETTLEMENT_HASH,
      settlementTxHash: SETTLEMENT_HASH,
    });
    expect(classifySeraSwapSettlementConfirmation(confirmed, settlementInput)).toBe("already_confirmed");
    expect(classifySeraSwapSettlementConfirmation(
      makeTransaction({ status: "confirming", submitState: "submitted", settlementTxHash: `0x${"34".repeat(32)}` }),
      settlementInput,
    )).toBe("hash_conflict");
    expect(classifySeraSwapSettlementConfirmation(
      makeTransaction({ status: "confirming", submitState: "submitted" }),
      settlementInput,
      makeTransaction({
        id: "other-transaction",
        intentHash: null,
        quoteUuid: null,
        submitState: null,
        status: "confirmed",
        verified: 1,
        txHash: SETTLEMENT_HASH,
      }),
    )).toBe("hash_conflict");
  });

  it("does not let a tentative direct notification block authoritative Sera evidence", () => {
    const tentativeDirect = makeTransaction({
      id: "tentative-direct-owner",
      quoteUuid: null,
      routeUuid: null,
      intentHash: null,
      submitState: null,
      status: "confirming",
      verified: 0,
      txHash: SETTLEMENT_HASH.toUpperCase().replace("0X", "0x"),
    });
    expect(classifyDirectTransactionNotification(tentativeDirect, SETTLEMENT_HASH)).toBe("already_claimed");
    expect(classifySeraSwapSettlementConfirmation(
      makeTransaction({ status: "confirming", submitState: "submitted" }),
      settlementInput,
      tentativeDirect,
    )).toBe("claimable");
  });

  it("allows another durable Sera Intent to share a batched settlement hash", () => {
    const batchOwner = makeTransaction({
      id: "other-sera-intent",
      intentHash: `0x${"56".repeat(32)}`,
      txHash: SETTLEMENT_HASH,
      settlementTxHash: SETTLEMENT_HASH,
      status: "confirmed",
      verified: 1,
      submitState: "settled",
    });
    expect(isCompatibleSeraBatchSettlementHashOwner(batchOwner, SETTLEMENT_HASH)).toBe(true);
    expect(classifySeraSwapSettlementConfirmation(
      makeTransaction({ status: "confirming", submitState: "submitted" }),
      settlementInput,
      batchOwner,
    )).toBe("claimable");

    expect(isCompatibleSeraBatchSettlementHashOwner(
      { ...batchOwner, settlementTxHash: `0x${"57".repeat(32)}` },
      SETTLEMENT_HASH,
    )).toBe(false);
  });

  it("requires the exact durable Intent and optional quote/trade bindings", () => {
    const submitted = makeTransaction({ status: "confirming", submitState: "submitted", tradeId: "trade-1" });
    expect(classifySeraSwapSettlementConfirmation(submitted, {
      ...settlementInput,
      intentHash: `0x${"cd".repeat(32)}`,
    })).toBe("binding_mismatch");
    expect(classifySeraSwapSettlementConfirmation(submitted, {
      ...settlementInput,
      expectedQuoteUuid: "quote-2",
    })).toBe("binding_mismatch");
    expect(classifySeraSwapSettlementConfirmation(submitted, {
      ...settlementInput,
      expectedTradeId: "trade-2",
    })).toBe("binding_mismatch");
  });

  it("lets authoritative on-chain proof recover only a no-settlement terminal failure", () => {
    expect(classifySeraSwapSettlementConfirmation(makeTransaction({
      status: "failed",
      submitState: "failed",
      failureCode: SERA_NO_SETTLEMENT_FAILURE_CODE,
    }), settlementInput)).toBe("claimable");
    expect(classifySeraSwapSettlementConfirmation(makeTransaction({
      status: "failed",
      submitState: "failed",
      failureCode: "provider_rejected",
    }), settlementInput)).toBe("invalid_state");
    expect(classifySeraSwapSettlementConfirmation(makeTransaction({
      status: "canceled",
      submitState: "canceled",
      failureCode: "canceled",
    }), settlementInput)).toBe("invalid_state");
  });

  it("grants one notification owner across concurrent confirmation attempts", async () => {
    const transactionId = "concurrent-settlement-confirmation";
    await seedMemoryTransaction(transactionId);
    await claimSeraSwapSubmission({ ...claimInput, transactionId });
    const { updateSeraSwapLifecycle } = await import("./db");
    await updateSeraSwapLifecycle(transactionId, {
      submitState: "submitted",
      seraOutcomeSyncedAt: NOW,
    });

    const input = {
      ...settlementInput,
      transactionId,
      patch: {
        actualPayAmountRaw: "1999000000000000000000",
        actualReceiveAmountRaw: "1000000",
        feeAmountRaw: "1000000000000000000",
        notes: JSON.stringify({ type: "sera_swap", settlement: "verified" }),
      },
    };
    const results = await Promise.all([
      claimSeraSwapSettlementConfirmation(input),
      claimSeraSwapSettlementConfirmation(input),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual(["already_confirmed", "claimed"]);
    const stored = await getTransactionById(transactionId);
    expect(stored).toMatchObject({
      status: "confirmed",
      verified: 1,
      submitState: "settled",
      seraStatus: "settled",
      txHash: SETTLEMENT_HASH,
      settlementTxHash: SETTLEMENT_HASH,
      actualReceiveAmountRaw: "1000000",
      failureCode: null,
      seraOutcomeSyncedAt: null,
    });
  });

  it("does not mutate a transaction when a direct-transfer row owns the settlement hash", async () => {
    const directSettlementHash = `0x${"79".repeat(32)}`;
    const ownerId = "settlement-hash-owner";
    const candidateId = "settlement-hash-candidate";
    const { createdAt: _ownerCreatedAt, updatedAt: _ownerUpdatedAt, ...owner } = makeTransaction({
      id: ownerId,
      status: "confirmed",
      verified: 1,
      submitState: null,
      quoteUuid: null,
      routeUuid: null,
      intentHash: null,
      txHash: directSettlementHash,
      settlementTxHash: null,
    });
    await createTransaction(owner);
    await seedMemoryTransaction(candidateId);
    await claimSeraSwapSubmission({ ...claimInput, transactionId: candidateId });
    const { updateSeraSwapLifecycle } = await import("./db");
    await updateSeraSwapLifecycle(candidateId, { submitState: "settlement_unknown" });

    const result = await claimSeraSwapSettlementConfirmation({
      ...settlementInput,
      transactionId: candidateId,
      txHash: directSettlementHash,
    });
    expect(result.outcome).toBe("hash_conflict");
    expect(await getTransactionById(candidateId)).toMatchObject({
      status: "confirming",
      verified: 0,
      txHash: null,
      settlementTxHash: null,
      submitState: "settlement_unknown",
    });
  });

  it("confirms two distinct Sera Intents from the same batched settlement transaction", async () => {
    const batchHash = `0x${"78".repeat(32)}`;
    const firstId = "batch-settlement-first";
    const secondId = "batch-settlement-second";
    const secondIntentHash = `0x${"67".repeat(32)}`;

    await seedMemoryTransaction(firstId);
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...second } = makeTransaction({
      id: secondId,
      quoteUuid: "quote-batch-second",
      routeUuid: "987654",
      intentHash: secondIntentHash,
    });
    await createTransaction(second);
    await claimSeraSwapSubmission({ ...claimInput, transactionId: firstId });
    await claimSeraSwapSubmission({
      transactionId: secondId,
      quoteUuid: "quote-batch-second",
      intentHash: secondIntentHash,
      now: NOW,
    });
    const { updateSeraSwapLifecycle } = await import("./db");
    await updateSeraSwapLifecycle(firstId, { submitState: "submitted" });
    await updateSeraSwapLifecycle(secondId, { submitState: "submitted" });

    const [first, secondResult] = await Promise.all([
      claimSeraSwapSettlementConfirmation({ ...settlementInput, transactionId: firstId, txHash: batchHash }),
      claimSeraSwapSettlementConfirmation({
        transactionId: secondId,
        intentHash: secondIntentHash,
        expectedQuoteUuid: "quote-batch-second",
        txHash: batchHash,
      }),
    ]);

    expect(first.outcome).toBe("claimed");
    expect(secondResult.outcome).toBe("claimed");
    expect(await getTransactionById(firstId)).toMatchObject({
      status: "confirmed",
      txHash: batchHash,
      settlementTxHash: batchHash,
    });
    expect(await getTransactionById(secondId)).toMatchObject({
      status: "confirmed",
      txHash: batchHash,
      settlementTxHash: batchHash,
    });
  });
});

describe("Sera post-deadline terminal failure compare-and-set", () => {
  const terminalInput = {
    transactionId: "transaction-1",
    intentHash: INTENT_HASH,
    expectedQuoteUuid: "quote-1",
    finalizedScanFromBlock: "998",
    finalizedScanThroughBlock: "1200",
    finalizedScanThroughTimestamp: new Date("2026-09-04T12:02:30.000Z"),
    now: AFTER_DEADLINE,
  };

  it.each(["submitting", "submitted", "settlement_unknown"] as const)(
    "allows %s recovery to end only after the finalized scan covers its submission anchor",
    (submitState) => {
      expect(classifySeraSwapTerminalFailure(makeTransaction({
        status: "confirming",
        submitState,
        submittedBlockNumber: "1000",
      }), terminalInput)).toBe("claimable");
    },
  );

  it("requires both local and finalized-chain time to reach the Intent deadline", () => {
    const transaction = makeTransaction({
      status: "confirming",
      submitState: "submitting",
      submittedBlockNumber: "1000",
    });
    expect(classifySeraSwapTerminalFailure(transaction, {
      ...terminalInput,
      now: new Date("2026-09-04T12:01:59.000Z"),
    })).toBe("scan_incomplete");
    expect(classifySeraSwapTerminalFailure(transaction, {
      ...terminalInput,
      finalizedScanThroughTimestamp: new Date("2026-09-04T12:01:59.000Z"),
    })).toBe("scan_incomplete");
    expect(classifySeraSwapTerminalFailure(transaction, {
      ...terminalInput,
      finalizedScanThroughTimestamp: new Date("2026-09-04T12:03:01.000Z"),
    })).toBe("scan_incomplete");
  });

  it("rejects a gapped range, a range before submission, or a missing recovery anchor", () => {
    const transaction = makeTransaction({
      status: "confirming",
      submitState: "submitting",
      submittedBlockNumber: "1000",
    });
    expect(classifySeraSwapTerminalFailure(transaction, {
      ...terminalInput,
      finalizedScanFromBlock: "1001",
    })).toBe("scan_incomplete");
    expect(classifySeraSwapTerminalFailure(transaction, {
      ...terminalInput,
      finalizedScanThroughBlock: "999",
    })).toBe("scan_incomplete");
    expect(classifySeraSwapTerminalFailure(
      makeTransaction({ status: "confirming", submitState: "submitting", submittedBlockNumber: null }),
      terminalInput,
    )).toBe("scan_incomplete");
  });

  it("does not fail a row with settlement evidence or a mismatched durable binding", () => {
    expect(classifySeraSwapTerminalFailure(makeTransaction({
      status: "confirming",
      submitState: "submitted",
      submittedBlockNumber: "1000",
      settlementTxHash: SETTLEMENT_HASH,
    }), terminalInput)).toBe("invalid_state");
    expect(classifySeraSwapTerminalFailure(makeTransaction({
      status: "confirming",
      submitState: "submitted",
      submittedBlockNumber: "1000",
      provisionalSettlementAt: NOW,
      provisionalSettlementTxHash: SETTLEMENT_HASH,
      provisionalSettlementBlockNumber: "1100",
      provisionalSettlementBlockHash: `0x${"34".repeat(32)}`,
      provisionalSettlementConfirmations: 2,
    }), terminalInput)).toBe("invalid_state");
    expect(classifySeraSwapTerminalFailure(makeTransaction({
      status: "confirming",
      submitState: "submitted",
      submittedBlockNumber: "1000",
    }), { ...terminalInput, expectedQuoteUuid: "quote-2" })).toBe("binding_mismatch");
  });

  it("cannot claim terminal failure while durable provisional evidence remains", async () => {
    const transactionId = "provisional-blocks-terminal-failure";
    await seedMemoryTransaction(transactionId);
    await claimSeraSwapSubmission({
      ...claimInput,
      transactionId,
      submittedBlockNumber: "1000",
    });
    const { updateSeraSwapLifecycle } = await import("./db");
    await updateSeraSwapLifecycle(transactionId, { submitState: "submitted" });
    await claimSeraSwapProvisionalSettlement({
      transactionId,
      intentHash: INTENT_HASH,
      quoteUuid: "quote-1",
      txHash: SETTLEMENT_HASH,
      blockNumber: "1100",
      blockHash: `0x${"34".repeat(32)}`,
      confirmations: 2,
    });

    const failure = await claimSeraSwapTerminalFailure({ ...terminalInput, transactionId });
    expect(failure.outcome).toBe("invalid_state");
    expect(failure.transaction).toMatchObject({
      status: "confirming",
      verified: 0,
      submitState: "submitted",
      provisionalSettlementTxHash: SETTLEMENT_HASH,
      provisionalSettlementBlockNumber: "1100",
    });
  });

  it("grants exactly one terminal-failure notification owner", async () => {
    const transactionId = "concurrent-terminal-failure";
    await seedMemoryTransaction(transactionId);
    await claimSeraSwapSubmission({
      ...claimInput,
      transactionId,
      submittedBlockNumber: "1000",
    });
    const { updateSeraSwapLifecycle } = await import("./db");
    await updateSeraSwapLifecycle(transactionId, { seraOutcomeSyncedAt: NOW });

    const input = {
      ...terminalInput,
      transactionId,
      patch: {
        seraStatus: "cancelled",
        notes: JSON.stringify({ type: "sera_swap", failure: "finalized scan empty" }),
      },
    };
    const results = await Promise.all([
      claimSeraSwapTerminalFailure(input),
      claimSeraSwapTerminalFailure(input),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual(["already_failed", "claimed"]);
    expect(await getTransactionById(transactionId)).toMatchObject({
      status: "failed",
      verified: 0,
      submitState: "failed",
      failureCode: SERA_NO_SETTLEMENT_FAILURE_CODE,
      seraStatus: "cancelled",
      seraOutcomeSyncedAt: null,
    });
  });

  it("makes a verified settlement authoritative in either CAS race order", async () => {
    for (const suffix of ["terminal-first", "concurrent"] as const) {
      const transactionId = `terminal-success-race-${suffix}`;
      await seedMemoryTransaction(transactionId);
      await claimSeraSwapSubmission({
        ...claimInput,
        transactionId,
        submittedBlockNumber: "1000",
      });
      const terminal = { ...terminalInput, transactionId };
      const settlement = {
        transactionId,
        intentHash: INTENT_HASH,
        txHash: suffix === "terminal-first" ? `0x${"90".repeat(32)}` : `0x${"91".repeat(32)}`,
        expectedQuoteUuid: "quote-1",
      };

      if (suffix === "terminal-first") {
        expect((await claimSeraSwapTerminalFailure(terminal)).outcome).toBe("claimed");
        expect((await claimSeraSwapSettlementConfirmation(settlement)).outcome).toBe("claimed");
      } else {
        const results = await Promise.all([
          claimSeraSwapTerminalFailure(terminal),
          claimSeraSwapSettlementConfirmation(settlement),
        ]);
        expect(results[1].outcome).toBe("claimed");
        expect(["claimed", "already_confirmed"]).toContain(results[0].outcome);
      }

      expect(await getTransactionById(transactionId)).toMatchObject({
        status: "confirmed",
        verified: 1,
        submitState: "settled",
        failureCode: null,
        txHash: settlement.txHash,
        settlementTxHash: settlement.txHash,
      });
    }
  });

  it("keeps exact IntentMatched evidence authoritative over terminal failure in either order", async () => {
    for (const suffix of ["marker-first", "failure-first"] as const) {
      const transactionId = `intent-marker-terminal-race-${suffix}`;
      const settlementTxHash = suffix === "marker-first"
        ? `0x${"92".repeat(32)}`
        : `0x${"93".repeat(32)}`;
      await seedMemoryTransaction(transactionId);
      await claimSeraSwapSubmission({
        ...claimInput,
        transactionId,
        submittedBlockNumber: "1000",
      });
      const marker = {
        transactionId,
        intentHash: INTENT_HASH,
        quoteUuid: "quote-1",
        settlementTxHash,
        blockNumber: "1100",
        observedAt: AFTER_DEADLINE,
      };
      const failure = { ...terminalInput, transactionId };

      if (suffix === "marker-first") {
        expect((await markSeraIntentMatchedEvidence(marker)).outcome).toBe("claimed");
        expect((await claimSeraSwapTerminalFailure(failure)).outcome).toBe("invalid_state");
      } else {
        expect((await claimSeraSwapTerminalFailure(failure)).outcome).toBe("claimed");
        expect((await markSeraIntentMatchedEvidence(marker)).outcome).toBe("claimed");
      }

      const transaction = await getTransactionById(transactionId);
      expect(transaction).toMatchObject({
        status: "confirming",
        verified: 0,
        submitState: "settlement_unknown",
        intentMatchedAt: AFTER_DEADLINE,
        intentMatchedTxHash: settlementTxHash,
        intentMatchedBlockNumber: "1100",
        failureCode: "payout_evidence_pending",
      });
      expect(classifySeraSwapTerminalFailure(transaction, failure)).toBe("invalid_state");
    }
  });

  it("reopens an arbitrary provider failure when exact IntentMatched evidence arrives", async () => {
    const transactionId = "intent-marker-reopens-provider-failure";
    const settlementTxHash = `0x${"94".repeat(32)}`;
    await seedMemoryTransaction(transactionId);
    await claimSeraSwapSubmission({
      ...claimInput,
      transactionId,
      submittedBlockNumber: "1000",
    });
    expect((await claimSeraSwapPostNetworkUpdate({
      transactionId,
      quoteUuid: "quote-1",
      intentHash: INTENT_HASH,
      patch: {
        status: "failed",
        submitState: "failed",
        seraStatus: "rejected",
        failureCode: "provider_rejected",
      },
    })).outcome).toBe("claimed");

    const marker = await markSeraIntentMatchedEvidence({
      transactionId,
      intentHash: INTENT_HASH,
      quoteUuid: "quote-1",
      settlementTxHash,
      blockNumber: "1101",
      observedAt: AFTER_DEADLINE,
    });
    expect(marker.outcome).toBe("claimed");
    expect(marker.transaction).toMatchObject({
      status: "confirming",
      submitState: "settlement_unknown",
      intentMatchedTxHash: settlementTxHash,
      failureCode: "payout_evidence_pending",
    });

    const staleProviderFailure = await claimSeraSwapPostNetworkUpdate({
      transactionId,
      quoteUuid: "quote-1",
      intentHash: INTENT_HASH,
      patch: { status: "failed", submitState: "failed", failureCode: "late_rejection" },
    });
    expect(staleProviderFailure.outcome).toBe("invalid_state");
    expect(staleProviderFailure.transaction.intentMatchedAt).toEqual(AFTER_DEADLINE);
  });
});

describe("durable Sera terminal-outcome synchronization", () => {
  it("transactionally prepares confirmed linked records, then acknowledges the exact outcome", async () => {
    const transactionId = "outcome-confirmed";
    const orderId = "outcome-confirmed-order";
    const paymentIntentId = "outcome-confirmed-intent";
    const txHash = `0x${"a1".repeat(32)}`;
    const completedAt = new Date("2026-09-04T13:00:00.000Z");
    await seedLinkedPaymentIntent(paymentIntentId);
    await seedLinkedMenuOrder({ id: orderId, paymentIntentId });
    await seedTerminalSeraTransaction({
      id: transactionId,
      kind: "confirmed",
      txHash,
      intentHash: `0x${"a2".repeat(32)}`,
      quoteUuid: "outcome-confirmed-quote",
      notes: JSON.stringify({ orderId, paymentIntentId }),
    });

    const prepared = await prepareSeraSwapOutcomeSync(transactionId);
    expect(prepared.outcome).toBe("prepared");
    if (prepared.outcome !== "prepared") throw new Error("Expected prepared outcome");
    expect(prepared.terminalOutcome).toEqual({
      kind: "confirmed",
      quoteUuid: "outcome-confirmed-quote",
      intentHash: `0x${"a2".repeat(32)}`,
      txHash,
    });
    expect(await getMenuOrderById(orderId)).toMatchObject({
      status: "paid",
      paymentId: transactionId,
      transactionId,
      paymentIntentId,
    });
    expect(await getPaymentIntentById(paymentIntentId)).toMatchObject({ status: "paid" });
    expect((await getTransactionById(transactionId))?.seraOutcomeSyncedAt).toBeNull();

    const completed = await completeSeraSwapOutcomeSync({
      transactionId,
      terminalOutcome: prepared.terminalOutcome,
      webhookRequested: false,
      webhookDelivered: false,
      completedAt,
    });
    expect(completed.outcome).toBe("completed");
    expect(completed.transaction.seraOutcomeSyncedAt).toEqual(completedAt);
    expect(completed.transaction.webhookSentAt).toBeNull();

    const repeated = await prepareSeraSwapOutcomeSync(transactionId);
    expect(repeated.outcome).toBe("already_synced");
  });

  it("synchronizes failed records but never downgrades an already-paid order or intent", async () => {
    const transactionId = "outcome-failed-paid-wins";
    const orderId = "outcome-failed-paid-order";
    const paymentIntentId = "outcome-failed-paid-intent";
    await seedLinkedPaymentIntent(paymentIntentId, "paid");
    await seedLinkedMenuOrder({ id: orderId, status: "paid", paymentIntentId });
    await seedTerminalSeraTransaction({
      id: transactionId,
      kind: "failed",
      quoteUuid: "outcome-failed-paid-quote",
      intentHash: `0x${"a3".repeat(32)}`,
      notes: JSON.stringify({ orderId, paymentIntentId }),
    });

    const prepared = await prepareSeraSwapOutcomeSync(transactionId);
    expect(prepared.outcome).toBe("prepared");
    expect(await getMenuOrderById(orderId)).toMatchObject({
      status: "paid",
      paymentId: null,
      transactionId: null,
    });
    expect(await getPaymentIntentById(paymentIntentId)).toMatchObject({ status: "paid" });
  });

  it("marks non-paid linked records failed and installs missing transaction bindings", async () => {
    const transactionId = "outcome-failed-linked";
    const orderId = "outcome-failed-linked-order";
    const paymentIntentId = "outcome-failed-linked-intent";
    await seedLinkedPaymentIntent(paymentIntentId, "open");
    await seedLinkedMenuOrder({ id: orderId, paymentIntentId });
    await seedTerminalSeraTransaction({
      id: transactionId,
      kind: "failed",
      quoteUuid: "outcome-failed-linked-quote",
      intentHash: `0x${"a4".repeat(32)}`,
      notes: JSON.stringify({ orderId, paymentIntentId }),
    });

    expect((await prepareSeraSwapOutcomeSync(transactionId)).outcome).toBe("prepared");
    expect(await getMenuOrderById(orderId)).toMatchObject({
      status: "failed",
      paymentId: transactionId,
      transactionId,
    });
    expect(await getPaymentIntentById(paymentIntentId)).toMatchObject({ status: "failed" });
  });

  it("fails closed on conflicting menu-order or merchant bindings without partial updates", async () => {
    const transactionId = "outcome-binding-conflict";
    const orderId = "outcome-binding-conflict-order";
    const paymentIntentId = "outcome-binding-conflict-intent";
    await seedLinkedPaymentIntent(paymentIntentId, "open");
    await seedLinkedMenuOrder({
      id: orderId,
      paymentIntentId,
      transactionId: "different-transaction",
    });
    await seedTerminalSeraTransaction({
      id: transactionId,
      kind: "confirmed",
      txHash: `0x${"a5".repeat(32)}`,
      quoteUuid: "outcome-binding-conflict-quote",
      intentHash: `0x${"a6".repeat(32)}`,
      notes: JSON.stringify({ orderId, paymentIntentId }),
    });

    const prepared = await prepareSeraSwapOutcomeSync(transactionId);
    expect(prepared).toMatchObject({
      outcome: "binding_conflict",
      resource: "menu_order",
      resourceId: orderId,
    });
    expect(await getMenuOrderById(orderId)).toMatchObject({
      status: "payment_pending",
      transactionId: "different-transaction",
    });
    expect(await getPaymentIntentById(paymentIntentId)).toMatchObject({ status: "open" });
    expect((await getTransactionById(transactionId))?.seraOutcomeSyncedAt).toBeNull();
  });

  it("rejects a stale failure completion after authoritative settlement wins", async () => {
    const transactionId = "outcome-failure-overridden";
    const orderId = "outcome-failure-overridden-order";
    const paymentIntentId = "outcome-failure-overridden-intent";
    const intentHash = `0x${"a7".repeat(32)}`;
    const quoteUuid = "outcome-failure-overridden-quote";
    const settlementHash = `0x${"a8".repeat(32)}`;
    await seedLinkedPaymentIntent(paymentIntentId, "open");
    await seedLinkedMenuOrder({ id: orderId, paymentIntentId });
    await seedTerminalSeraTransaction({
      id: transactionId,
      kind: "failed",
      failureCode: SERA_NO_SETTLEMENT_FAILURE_CODE,
      quoteUuid,
      intentHash,
      notes: JSON.stringify({ orderId, paymentIntentId }),
    });

    const stalePreparation = await prepareSeraSwapOutcomeSync(transactionId);
    expect(stalePreparation.outcome).toBe("prepared");
    if (stalePreparation.outcome !== "prepared") throw new Error("Expected failure preparation");
    expect(await getPaymentIntentById(paymentIntentId)).toMatchObject({ status: "failed" });

    const settlement = await claimSeraSwapSettlementConfirmation({
      transactionId,
      intentHash,
      expectedQuoteUuid: quoteUuid,
      txHash: settlementHash,
    });
    expect(settlement.outcome).toBe("claimed");
    const currentPreparation = await prepareSeraSwapOutcomeSync(transactionId);
    expect(currentPreparation.outcome).toBe("prepared");
    expect(await getMenuOrderById(orderId)).toMatchObject({ status: "paid" });
    expect(await getPaymentIntentById(paymentIntentId)).toMatchObject({ status: "paid" });

    const staleCompletion = await completeSeraSwapOutcomeSync({
      transactionId,
      terminalOutcome: stalePreparation.terminalOutcome,
      webhookRequested: false,
      webhookDelivered: false,
    });
    expect(staleCompletion.outcome).toBe("state_changed");
    expect(staleCompletion.transaction.seraOutcomeSyncedAt).toBeNull();
    expect(staleCompletion.transaction.status).toBe("confirmed");
  });

  it("records completion after a failed webhook attempt without claiming delivery", async () => {
    const transactionId = "outcome-webhook-failed";
    await seedTerminalSeraTransaction({
      id: transactionId,
      kind: "failed",
      quoteUuid: "outcome-webhook-failed-quote",
      intentHash: `0x${"a9".repeat(32)}`,
    });
    const prepared = await prepareSeraSwapOutcomeSync(transactionId);
    if (prepared.outcome !== "prepared") throw new Error("Expected prepared outcome");
    const { updateSeraSwapLifecycle } = await import("./db");
    await updateSeraSwapLifecycle(transactionId, { webhookSentAt: NOW });
    const completedAt = new Date("2026-09-04T14:00:00.000Z");
    const completed = await completeSeraSwapOutcomeSync({
      transactionId,
      terminalOutcome: prepared.terminalOutcome,
      webhookRequested: true,
      webhookDelivered: false,
      completedAt,
    });
    expect(completed.outcome).toBe("completed");
    expect(completed.transaction.seraOutcomeSyncedAt).toEqual(completedAt);
    expect(completed.transaction.webhookSentAt).toBeNull();
  });

  it("grants one completion owner and requires the exact confirmed hash", async () => {
    const transactionId = "outcome-completion-race";
    const txHash = `0x${"af".repeat(32)}`;
    await seedTerminalSeraTransaction({
      id: transactionId,
      kind: "confirmed",
      txHash,
      quoteUuid: "outcome-completion-race-quote",
      intentHash: `0x${"b0".repeat(32)}`,
    });
    const prepared = await prepareSeraSwapOutcomeSync(transactionId);
    if (prepared.outcome !== "prepared" || prepared.terminalOutcome.kind !== "confirmed") {
      throw new Error("Expected confirmed preparation");
    }

    const wrongHash = await completeSeraSwapOutcomeSync({
      transactionId,
      terminalOutcome: { ...prepared.terminalOutcome, txHash: `0x${"b1".repeat(32)}` },
      webhookRequested: false,
      webhookDelivered: false,
    });
    expect(wrongHash.outcome).toBe("state_changed");
    expect(wrongHash.transaction.seraOutcomeSyncedAt).toBeNull();

    const results = await Promise.all([
      completeSeraSwapOutcomeSync({
        transactionId,
        terminalOutcome: prepared.terminalOutcome,
        webhookRequested: false,
        webhookDelivered: false,
      }),
      completeSeraSwapOutcomeSync({
        transactionId,
        terminalOutcome: prepared.terminalOutcome,
        webhookRequested: false,
        webhookDelivered: false,
      }),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["already_synced", "completed"]);
  });

  it("sets webhookSentAt only when delivery is positively attested", async () => {
    const transactionId = "outcome-webhook-delivered";
    await seedTerminalSeraTransaction({
      id: transactionId,
      kind: "confirmed",
      txHash: `0x${"aa".repeat(32)}`,
      quoteUuid: "outcome-webhook-delivered-quote",
      intentHash: `0x${"ab".repeat(32)}`,
    });
    const prepared = await prepareSeraSwapOutcomeSync(transactionId);
    if (prepared.outcome !== "prepared") throw new Error("Expected prepared outcome");
    const completedAt = new Date("2026-09-04T14:01:00.000Z");
    const completed = await completeSeraSwapOutcomeSync({
      transactionId,
      terminalOutcome: prepared.terminalOutcome,
      webhookRequested: true,
      webhookDelivered: true,
      completedAt,
    });
    expect(completed.outcome).toBe("completed");
    expect(completed.transaction.webhookSentAt).toEqual(completedAt);
  });

  it("returns only valid unsynced terminal outcomes oldest-first", async () => {
    const firstId = "outcome-queue-first";
    const secondId = "outcome-queue-second";
    await seedTerminalSeraTransaction({
      id: firstId,
      kind: "failed",
      quoteUuid: "outcome-queue-first-quote",
      intentHash: `0x${"ac".repeat(32)}`,
      updatedAt: new Date("1990-01-01T00:00:00.000Z"),
    });
    await seedTerminalSeraTransaction({
      id: secondId,
      kind: "confirmed",
      txHash: `0x${"ad".repeat(32)}`,
      quoteUuid: "outcome-queue-second-quote",
      intentHash: `0x${"ae".repeat(32)}`,
      updatedAt: new Date("1990-01-02T00:00:00.000Z"),
    });

    expect((await getUnsyncedSeraSwapOutcomes(2)).map((transaction) => transaction.id)).toEqual([
      firstId,
      secondId,
    ]);
    expect(getSeraSwapTerminalOutcome(await getTransactionById(firstId))).toMatchObject({ kind: "failed" });
  });
});

describe("direct notification and terminal hash ownership", () => {
  const directRow = (id: string, overrides: Partial<Transaction> = {}) => makeTransaction({
    id,
    quoteUuid: null,
    routeUuid: null,
    intentHash: null,
    tradeId: null,
    submitState: null,
    settlementTxHash: null,
    status: "pending",
    verified: 0,
    txHash: null,
    ...overrides,
  });

  it("normalizes lookup casing and lets Sera supersede a tentative direct hash reservation", async () => {
    const txHashUpper = `0x${"C1".repeat(32)}`;
    const txHash = txHashUpper.toLowerCase();
    const directId = "hash-owner-tentative-direct";
    const seraId = "hash-owner-authoritative-sera";
    await createTransaction(directRow(directId, {
      status: "confirming",
      txHash: txHashUpper,
      notifiedAt: NOW,
    }));
    await seedMemoryTransaction(seraId);
    await claimSeraSwapSubmission({ ...claimInput, transactionId: seraId });
    const { updateSeraSwapLifecycle } = await import("./db");
    await updateSeraSwapLifecycle(seraId, { submitState: "submitted" });

    const confirmation = await claimSeraSwapSettlementConfirmation({
      transactionId: seraId,
      intentHash: INTENT_HASH,
      expectedQuoteUuid: "quote-1",
      txHash: txHashUpper,
    });
    expect(confirmation.outcome).toBe("claimed");
    expect(confirmation.transaction.txHash).toBe(txHash);
    expect((await getTransactionById(directId))?.status).toBe("confirming");
    expect((await getTransactionByHash(txHashUpper))?.id).toBe(seraId);

    await expect(updateTransaction(directId, { status: "confirmed", verified: 1 }))
      .rejects.toMatchObject({ code: "23505", constraint: "transaction_hash_terminal_owner" });
    expect(await getTransactionById(directId)).toMatchObject({ status: "confirming", verified: 0 });

    // Ownership is a replay tombstone, not a projection of mutable row state.
    await updateSeraSwapLifecycle(seraId, {
      status: "failed",
      verified: 0,
      submitState: "failed",
      txHash: null,
      settlementTxHash: null,
    });
    await expect(updateTransaction(directId, { status: "confirmed", verified: 1 }))
      .rejects.toMatchObject({ code: "23505", constraint: "transaction_hash_terminal_owner" });
  });

  it("deduplicates tentative direct notifications case-insensitively", async () => {
    const txHashUpper = `0x${"C2".repeat(32)}`;
    const firstId = "direct-notification-hash-first";
    const secondId = "direct-notification-hash-second";
    await createTransaction(directRow(firstId));
    await createTransaction(directRow(secondId));

    expect((await claimDirectTransactionNotification({ transactionId: firstId, txHash: txHashUpper })).outcome)
      .toBe("claimed");
    const duplicate = await claimDirectTransactionNotification({
      transactionId: secondId,
      txHash: txHashUpper.toLowerCase(),
    });
    expect(duplicate.outcome).toBe("hash_conflict");
    expect(await getTransactionById(secondId)).toMatchObject({ status: "pending", txHash: null });
  });

  it("claims and releases a direct notification with its linked order atomically", async () => {
    const transactionId = "direct-notification-linked";
    const orderId = "direct-notification-linked-order";
    const txHashUpper = `0x${"C3".repeat(32)}`;
    await seedLinkedMenuOrder({ id: orderId });
    await createTransaction(directRow(transactionId, { notes: JSON.stringify({ orderId }) }));

    const claimed = await claimDirectTransactionNotification({ transactionId, txHash: txHashUpper });
    expect(claimed.outcome).toBe("claimed");
    expect(claimed.transaction).toMatchObject({
      status: "confirming",
      txHash: txHashUpper.toLowerCase(),
      fromAddress: null,
    });
    expect(await getMenuOrderById(orderId)).toMatchObject({
      status: "payment_submitted",
      paymentId: transactionId,
      transactionId,
    });

    const released = await releaseTentativeDirectTransactionHash({ transactionId, txHash: txHashUpper });
    expect(released.outcome).toBe("released");
    expect(released.transaction).toMatchObject({
      status: "pending",
      txHash: null,
      settlementTxHash: null,
      fromAddress: null,
      notifiedAt: null,
    });
    expect(await getMenuOrderById(orderId)).toMatchObject({
      status: "payment_pending",
      paymentId: transactionId,
      transactionId,
    });
  });

  it("returns binding_conflict without partially claiming an order owned by another payment", async () => {
    const transactionId = "direct-notification-binding-conflict";
    const orderId = "direct-notification-binding-conflict-order";
    const txHash = `0x${"c4".repeat(32)}`;
    await seedLinkedMenuOrder({
      id: orderId,
      status: "payment_submitted",
      paymentId: "different-payment",
      transactionId: "different-payment",
    });
    await createTransaction(directRow(transactionId, { notes: JSON.stringify({ orderId }) }));

    const result = await claimDirectTransactionNotification({ transactionId, txHash });
    expect(result).toMatchObject({ outcome: "binding_conflict", orderId });
    expect(await getTransactionById(transactionId)).toMatchObject({ status: "pending", txHash: null });
    expect(await getMenuOrderById(orderId)).toMatchObject({
      status: "payment_submitted",
      paymentId: "different-payment",
      transactionId: "different-payment",
    });
  });

  it("releases only orders still bound to the tentative direct transaction", async () => {
    const transactionId = "direct-release-stale-order-binding";
    const orderId = "direct-release-stale-order-binding-order";
    const txHash = `0x${"c5".repeat(32)}`;
    await seedLinkedMenuOrder({
      id: orderId,
      status: "payment_submitted",
      paymentId: "new-sera-payment",
      transactionId: "new-sera-payment",
    });
    await createTransaction(directRow(transactionId, {
      status: "confirming",
      txHash,
      notifiedAt: NOW,
      notes: JSON.stringify({ orderId }),
    }));

    expect((await releaseTentativeDirectTransactionHash({ transactionId, txHash })).outcome).toBe("released");
    expect(await getMenuOrderById(orderId)).toMatchObject({
      status: "payment_submitted",
      paymentId: "new-sera-payment",
      transactionId: "new-sera-payment",
    });
  });

  it("commits direct confirmation and its linked payment state atomically", async () => {
    const transactionId = "direct-terminal-confirmation-linked";
    const orderId = "direct-terminal-confirmation-order";
    const paymentIntentId = "direct-terminal-confirmation-intent";
    const txHash = `0x${"c6".repeat(32)}`;
    await seedLinkedPaymentIntent(paymentIntentId);
    await seedLinkedMenuOrder({ id: orderId, paymentIntentId });
    await createTransaction(directRow(transactionId, {
      notes: JSON.stringify({ orderId, paymentIntentId }),
    }));

    expect((await claimDirectTransactionNotification({ transactionId, txHash })).outcome).toBe("claimed");
    const confirmed = await claimDirectTransactionConfirmation({
      transactionId,
      txHash,
      fromAddress: "0x5555555555555555555555555555555555555555",
    });

    expect(confirmed.outcome).toBe("claimed");
    expect(confirmed.transaction).toMatchObject({ status: "confirmed", verified: 1, txHash });
    expect(await getMenuOrderById(orderId)).toMatchObject({
      status: "paid",
      paymentId: transactionId,
      transactionId,
    });
    expect(await getPaymentIntentById(paymentIntentId)).toMatchObject({
      status: "paid",
      transactionId,
    });
    expect((await claimDirectTransactionConfirmation({ transactionId, txHash })).outcome)
      .toBe("already_confirmed");
  });

  it("allows exactly one direct terminal result and keeps linked resources consistent", async () => {
    const transactionId = "direct-terminal-confirm-fail-race";
    const orderId = "direct-terminal-confirm-fail-race-order";
    const paymentIntentId = "direct-terminal-confirm-fail-race-intent";
    const txHash = `0x${"c7".repeat(32)}`;
    await seedLinkedPaymentIntent(paymentIntentId);
    await seedLinkedMenuOrder({ id: orderId, paymentIntentId });
    await createTransaction(directRow(transactionId, {
      notes: JSON.stringify({ orderId, paymentIntentId }),
    }));
    expect((await claimDirectTransactionNotification({ transactionId, txHash })).outcome).toBe("claimed");

    const [confirmation, failure] = await Promise.all([
      claimDirectTransactionConfirmation({ transactionId, txHash }),
      claimDirectTransactionFailure({
        transactionId,
        txHash,
        notes: JSON.stringify({ orderId, paymentIntentId, failure: "compliance_blocked" }),
      }),
    ]);
    expect([confirmation.outcome, failure.outcome].sort()).toEqual(["claimed", "invalid_state"]);

    const transaction = await getTransactionById(transactionId);
    const order = await getMenuOrderById(orderId);
    const intent = await getPaymentIntentById(paymentIntentId);
    if (transaction?.status === "confirmed") {
      expect(order?.status).toBe("paid");
      expect(intent?.status).toBe("paid");
    } else {
      expect(transaction?.status).toBe("failed");
      expect(order?.status).toBe("failed");
      expect(intent?.status).toBe("failed");
    }
  });

  it("allows exactly one direct cancellation or notification owner", async () => {
    const transactionId = "direct-notification-cancel-race";
    const orderId = "direct-notification-cancel-race-order";
    const txHash = `0x${"c8".repeat(32)}`;
    await seedLinkedMenuOrder({ id: orderId });
    await createTransaction(directRow(transactionId, { notes: JSON.stringify({ orderId }) }));

    const [notification, cancellation] = await Promise.all([
      claimDirectTransactionNotification({ transactionId, txHash }),
      claimDirectTransactionCancellation({
        transactionId,
        notes: JSON.stringify({ orderId, cancellation: "payer_closed_wallet" }),
      }),
    ]);
    expect([notification.outcome, cancellation.outcome].filter((outcome) => outcome === "claimed"))
      .toHaveLength(1);
    const transaction = await getTransactionById(transactionId);
    expect(["confirming", "canceled"]).toContain(transaction?.status);
    expect((await getMenuOrderById(orderId))?.status)
      .toBe(transaction?.status === "confirming" ? "payment_submitted" : "canceled");
  });

  it("does not let watch expiry overwrite a concurrent scanner confirmation", async () => {
    const transactionId = "direct-watch-expiry-confirm-race";
    const txHash = `0x${"c9".repeat(32)}`;
    await createTransaction(directRow(transactionId, {
      notes: JSON.stringify({ type: "direct_wallet_qr", watch: true }),
    }));

    const [confirmation, cancellation] = await Promise.all([
      claimDirectTransactionConfirmation({ transactionId, txHash }),
      claimDirectTransactionCancellation({
        transactionId,
        notes: JSON.stringify({ type: "direct_wallet_qr", watch: true, cancellation: "expired" }),
      }),
    ]);
    expect([confirmation.outcome, cancellation.outcome].filter((outcome) => outcome === "claimed"))
      .toHaveLength(1);
    const transaction = await getTransactionById(transactionId);
    expect(["confirmed", "canceled"]).toContain(transaction?.status);
    if (transaction?.status === "confirmed") {
      expect(transaction).toMatchObject({ verified: 1, txHash });
    } else {
      expect(transaction).toMatchObject({ verified: 0, txHash: null });
    }
  });
});

describe("Sera reconciliation recovery queue", () => {
  it("recognizes only unverified confirming rows with durable Sera lifecycle markers", () => {
    const direct = makeTransaction({
      status: "confirming",
      verified: 0,
      quoteUuid: null,
      intentHash: null,
      submitState: null,
    });
    expect(isUnresolvedSeraSwapForReconciliation(direct)).toBe(false);
    expect(isUnresolvedSeraSwapForReconciliation({ ...direct, quoteUuid: "quote" })).toBe(true);
    expect(isUnresolvedSeraSwapForReconciliation({ ...direct, intentHash: INTENT_HASH })).toBe(true);
    expect(isUnresolvedSeraSwapForReconciliation({ ...direct, submitState: "submitted" })).toBe(true);
    expect(isUnresolvedSeraSwapForReconciliation({ ...direct, status: "confirmed", quoteUuid: "quote" })).toBe(false);
    expect(isUnresolvedSeraSwapForReconciliation({ ...direct, verified: 1, quoteUuid: "quote" })).toBe(false);
  });

  it("returns the oldest Sera recovery work independently of direct and terminal rows", async () => {
    const seed = async (id: string, createdAt: string, overrides: Partial<Transaction>) => {
      await createTransaction(makeTransaction({
        id,
        createdAt: new Date(createdAt),
        updatedAt: new Date(createdAt),
        status: "confirming",
        verified: 0,
        quoteUuid: null,
        intentHash: null,
        submitState: null,
        ...overrides,
      }));
    };

    await seed("recovery-direct-oldest", "2000-01-01T00:00:00.000Z", {});
    await seed("recovery-first", "2000-01-02T00:00:00.000Z", { quoteUuid: "recovery-quote-first" });
    await seed("recovery-second", "2000-01-03T00:00:00.000Z", { intentHash: `0x${"34".repeat(32)}` });
    await seed("recovery-third", "2000-01-04T00:00:00.000Z", { submitState: "settlement_unknown" });
    await seed("recovery-already-confirmed", "1999-01-01T00:00:00.000Z", {
      status: "confirmed",
      verified: 1,
      quoteUuid: "recovery-quote-confirmed",
    });

    const recoveryBatch = await getPendingSeraSwapTransactions(2);
    expect(recoveryBatch.map((transaction) => transaction.id)).toEqual([
      "recovery-first",
      "recovery-second",
    ]);
  });

  it("filters Sera rows before limiting the newest fast-acknowledgement queue", async () => {
    const seed = async (id: string, createdAt: string, overrides: Partial<Transaction>) => {
      await createTransaction(makeTransaction({
        id,
        createdAt: new Date(createdAt),
        updatedAt: new Date(createdAt),
        status: "confirming",
        verified: 0,
        quoteUuid: null,
        intentHash: null,
        submitState: null,
        ...overrides,
      }));
    };
    await seed("fast-direct-newest", "2100-01-01T00:00:00.000Z", {});
    await seed("fast-sera-newest", "2099-01-03T00:00:00.000Z", { quoteUuid: "fast-quote-newest" });
    await seed("fast-sera-second", "2099-01-02T00:00:00.000Z", { intentHash: `0x${"91".repeat(32)}` });
    await seed("fast-sera-third", "2099-01-01T00:00:00.000Z", { submitState: "submitted" });

    const fastBatch = await getRecentPendingSeraSwapTransactions(2);
    expect(fastBatch.map((transaction) => transaction.id)).toEqual([
      "fast-sera-newest",
      "fast-sera-second",
    ]);
  });
});

describe("durable Sera checkout-attempt ownership", () => {
  it("normalizes and recovers only an active row carrying Sera quote or Intent markers", async () => {
    const checkoutAttemptKey = "checkout-attempt-recovery-1";
    await seedMemoryTransaction("checkout-attempt-sera-active", {
      checkoutAttemptKey: `  ${checkoutAttemptKey.toUpperCase()}  `,
      quoteUuid: "checkout-attempt-quote-active",
      routeUuid: "810001",
      intentHash: `0x${"81".repeat(32)}`,
    });
    await seedMemoryTransaction("checkout-attempt-direct-active", {
      checkoutAttemptKey: "checkout-attempt-direct-only",
      quoteUuid: null,
      routeUuid: null,
      intentHash: null,
      submitState: null,
    });
    await seedMemoryTransaction("checkout-attempt-sera-terminal", {
      checkoutAttemptKey: "checkout-attempt-terminal-only",
      quoteUuid: "checkout-attempt-quote-terminal",
      routeUuid: "810002",
      intentHash: `0x${"82".repeat(32)}`,
      status: "failed",
      submitState: "failed",
    });

    const stored = await getTransactionById("checkout-attempt-sera-active");
    expect(stored?.checkoutAttemptKey).toBe(checkoutAttemptKey);
    expect((await getActiveSeraSwapTransactionByCheckoutAttemptKey(checkoutAttemptKey))?.id)
      .toBe("checkout-attempt-sera-active");
    expect(await getActiveSeraSwapTransactionByCheckoutAttemptKey("checkout-attempt-direct-only"))
      .toBeUndefined();
    expect(await getActiveSeraSwapTransactionByCheckoutAttemptKey("checkout-attempt-terminal-only"))
      .toBeUndefined();
  });

  it("rejects a second active owner and releases the key after terminal transition", async () => {
    const checkoutAttemptKey = "checkout-attempt-exclusive-1";
    await seedMemoryTransaction("checkout-attempt-owner-first", {
      checkoutAttemptKey,
      quoteUuid: "checkout-attempt-quote-first",
      routeUuid: "820001",
      intentHash: `0x${"83".repeat(32)}`,
    });

    await expect(seedMemoryTransaction("checkout-attempt-owner-conflict", {
      checkoutAttemptKey: checkoutAttemptKey.toUpperCase(),
      quoteUuid: "checkout-attempt-quote-conflict",
      routeUuid: "820002",
      intentHash: `0x${"84".repeat(32)}`,
    })).rejects.toMatchObject({
      code: "23505",
      constraint: "uq_tx_active_checkout_attempt_key",
    });

    await seedMemoryTransaction("checkout-attempt-update-candidate", {
      checkoutAttemptKey: "checkout-attempt-update-candidate-key",
      quoteUuid: "checkout-attempt-quote-update-candidate",
      routeUuid: "820004",
      intentHash: `0x${"86".repeat(32)}`,
    });
    await expect(updateTransaction("checkout-attempt-update-candidate", {
      checkoutAttemptKey: ` ${checkoutAttemptKey.toUpperCase()} `,
    })).rejects.toMatchObject({
      code: "23505",
      constraint: "uq_tx_active_checkout_attempt_key",
    });
    expect((await getTransactionById("checkout-attempt-update-candidate"))?.checkoutAttemptKey)
      .toBe("checkout-attempt-update-candidate-key");

    await updateTransaction("checkout-attempt-owner-first", {
      status: "failed",
      submitState: "failed",
    });
    await seedMemoryTransaction("checkout-attempt-owner-second", {
      checkoutAttemptKey: ` ${checkoutAttemptKey.toUpperCase()} `,
      quoteUuid: "checkout-attempt-quote-second",
      routeUuid: "820003",
      intentHash: `0x${"85".repeat(32)}`,
    });

    expect((await getActiveSeraSwapTransactionByCheckoutAttemptKey(checkoutAttemptKey))?.id)
      .toBe("checkout-attempt-owner-second");
  });
});
