/**
 * Payment Verification Tests
 *
 * Tests for on-chain Base USDC receipt verification replacing balance-delta matching.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../state/database.js";
import type { DatabaseType } from "../state/database.js";
import type { Address } from "viem";
import {
  createPaymentRequest,
  getPaymentRequest,
  listPaymentRequests,
  verifyPendingBaseUsdcPayments,
  getVerifiedPaymentReceipt,
  type BaseUsdcLogClient,
  type VerifiedPaymentReceipt,
} from "../payment/requests.js";

// --- Test helpers ---

const walletAddress = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as Address;
const payerAddress = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" as Address;
const wrongPayer = "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" as Address;

type LogTransfer = {
  transactionHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  args: { from: Address; to: Address; value: bigint };
};

function transfer(overrides: {
  from: Address;
  to: Address;
  value: bigint;
  blockNumber: bigint;
  txHash?: `0x${string}`;
  logIndex?: number;
}): LogTransfer {
  return {
    transactionHash: overrides.txHash ?? ("0xaaa" as `0x${string}`),
    logIndex: overrides.logIndex ?? 0,
    blockNumber: overrides.blockNumber,
    args: {
      from: overrides.from,
      to: overrides.to,
      value: overrides.value,
    },
  };
}

// --- Tests ---

describe("Payment Verification (on-chain receipts)", () => {
  let db: DatabaseType;

  beforeEach(() => {
    const dbApi = createDatabase(":memory:");
    db = dbApi.raw;
  });

  afterEach(() => {
    // db closed by DatabaseType wrapper, but we keep reference raw
  });

  it("marks only the exact payer, recipient, amount, and confirmed log as paid", async () => {
    const invoice = createPaymentRequest(db, {
      amountUsd: 12.34,
      payer: payerAddress,
      reference: "job-quote",
      paymentNotBeforeBlock: 100n,
    });

    const client: BaseUsdcLogClient = {
      getBlockNumber: async () => 105n,
      getTransferLogs: async () => [
        // wrong payer
        transfer({ from: wrongPayer, to: walletAddress, value: 12_340_000n, blockNumber: 101n }),
        // correct payer, correct amount, confirmed enough
        transfer({ from: payerAddress, to: walletAddress, value: 12_340_000n, blockNumber: 102n }),
        // correct payer, wrong amount
        transfer({ from: payerAddress, to: walletAddress, value: 12_339_999n, blockNumber: 102n }),
        // correct payer, correct amount, but not enough confirmations
        transfer({ from: payerAddress, to: walletAddress, value: 12_340_000n, blockNumber: 104n }),
      ],
    };

    const receipts = await verifyPendingBaseUsdcPayments(db, {
      recipient: walletAddress,
      network: "eip155:8453",
      requiredConfirmations: 3,
      client,
    });

    expect(receipts).toHaveLength(1);
    expect(receipts[0].paymentRequestId).toBe(invoice.id);
    expect(getPaymentRequest(db, invoice.id)?.status).toBe("paid");
    expect(getVerifiedPaymentReceipt(db, invoice.id)?.from).toBe(payerAddress.toLowerCase() as Address);
  });

  it("rejects payment before payment_not_before_block", async () => {
    createPaymentRequest(db, {
      amountUsd: 5.0,
      payer: payerAddress,
      reference: "pre-block",
      paymentNotBeforeBlock: 200n,
    });

    const client: BaseUsdcLogClient = {
      getBlockNumber: async () => 210n,
      getTransferLogs: async () => [
        transfer({ from: payerAddress, to: walletAddress, value: 5_000_000n, blockNumber: 199n }),
      ],
    };

    const receipts = await verifyPendingBaseUsdcPayments(db, {
      recipient: walletAddress,
      network: "eip155:8453",
      requiredConfirmations: 3,
      client,
    });

    expect(receipts).toHaveLength(0);
    expect(getPaymentRequest(db, listPaymentRequests(db, { status: "pending" })[0]?.id)?.status).toBe("pending");
  });

  it("does not accept insufficiently confirmed payment", async () => {
    createPaymentRequest(db, {
      amountUsd: 10.0,
      payer: payerAddress,
      reference: "low-conf",
      paymentNotBeforeBlock: 50n,
    });

    const client: BaseUsdcLogClient = {
      getBlockNumber: async () => 52n, // latestBlock=52, requiredConfirmations=3 => safeToBlock=50
      getTransferLogs: async () => [
        // log at block 52 requires safeToBlock >= 52, but safeToBlock = 52-3+1 = 50, so not safe
        transfer({ from: payerAddress, to: walletAddress, value: 10_000_000n, blockNumber: 52n }),
      ],
    };

    const receipts = await verifyPendingBaseUsdcPayments(db, {
      recipient: walletAddress,
      network: "eip155:8453",
      requiredConfirmations: 3,
      client,
    });

    expect(receipts).toHaveLength(0);
  });

  it("an already-consumed (txHash, logIndex) cannot satisfy a second invoice", async () => {
    const invoice1 = createPaymentRequest(db, {
      amountUsd: 8.0,
      payer: payerAddress,
      reference: "first",
      paymentNotBeforeBlock: 100n,
    });

    const matchingLog = transfer({
      from: payerAddress,
      to: walletAddress,
      value: 8_000_000n,
      blockNumber: 102n,
      txHash: "0xtxhash1" as `0x${string}`,
      logIndex: 0,
    });

    const client: BaseUsdcLogClient = {
      getBlockNumber: async () => 110n,
      getTransferLogs: async () => [matchingLog],
    };

    // First verification: should match
    const first = await verifyPendingBaseUsdcPayments(db, {
      recipient: walletAddress,
      network: "eip155:8453",
      requiredConfirmations: 3,
      client,
    });
    expect(first).toHaveLength(1);
    expect(first[0].paymentRequestId).toBe(invoice1.id);

    // Second invoice with same amount
    createPaymentRequest(db, {
      amountUsd: 8.0,
      payer: payerAddress,
      reference: "second",
      paymentNotBeforeBlock: 100n,
    });

    // Same log returned again
    const client2: BaseUsdcLogClient = {
      getBlockNumber: async () => 110n,
      getTransferLogs: async () => [matchingLog],
    };

    const second = await verifyPendingBaseUsdcPayments(db, {
      recipient: walletAddress,
      network: "eip155:8453",
      requiredConfirmations: 3,
      client: client2,
    });

    // The second invoice should NOT be matched because (txHash, logIndex) is already consumed
    expect(second).toHaveLength(0);
  });

  it("payment does not become paid just because the balance increased", async () => {
    createPaymentRequest(db, {
      amountUsd: 15.0,
      payer: payerAddress,
      reference: "no-balance-trick",
      paymentNotBeforeBlock: 100n,
    });

    // Client returns zero transfer logs - no on-chain proof
    const client: BaseUsdcLogClient = {
      getBlockNumber: async () => 200n,
      getTransferLogs: async () => [],
    };

    const receipts = await verifyPendingBaseUsdcPayments(db, {
      recipient: walletAddress,
      network: "eip155:8453",
      requiredConfirmations: 3,
      client,
    });

    expect(receipts).toHaveLength(0);
    expect(getPaymentRequest(db, listPaymentRequests(db, { status: "pending" })[0]?.id)?.status).toBe("pending");
  });
});
