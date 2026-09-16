/**
 * USDC Payment Rails Tests
 *
 * Tests for direct USDC transfers and basic payment request management.
 * On-chain receipt verification is tested in payment-verification.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../state/database.js";
import { sendUsdc } from "../payment/usdc.js";
import {
  createPaymentRequest,
  listPaymentRequests,
  markPaymentRequestPaid,
} from "../payment/requests.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";

describe("USDC Payment Rails", () => {
  let dbApi: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    dbApi = createDatabase(":memory:");
  });

  afterEach(() => {
    dbApi.close();
  });

  describe("sendUsdc", () => {
    it("rejects zero or negative amounts", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const to = "0x1234567890123456789012345678901234567890" as Address;

      const result0 = await sendUsdc({ to, amountUsd: 0, account, db: dbApi.raw });
      expect(result0.success).toBe(false);
      expect(result0.error).toContain("positive");

      const resultNeg = await sendUsdc({ to, amountUsd: -5, account, db: dbApi.raw });
      expect(resultNeg.success).toBe(false);
    });

    it("rejects unsupported network", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const to = "0x1234567890123456789012345678901234567890" as Address;

      const result = await sendUsdc({
        to,
        amountUsd: 1,
        account,
        network: "eip155:9999" as any,
        db: dbApi.raw,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unsupported network");
    });

    it("returns an error (not crash) when RPC is unavailable", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const to = "0x1234567890123456789012345678901234567890" as Address;

      const result = await sendUsdc({
        to,
        amountUsd: 1,
        account,
        network: "eip155:8453",
        db: dbApi.raw,
        reference: "test-payment",
      });

      // No RPC configured — should fail gracefully, not throw
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("Payment Requests", () => {
    it("creates a payment request with pending status", () => {
      const request = createPaymentRequest(dbApi.raw, {
        amountUsd: 10,
        payer: "0xabcdef1234567890123456789012345678901234" as Address,
        reference: "invoice-001",
        description: "Test payment",
      });

      expect(request.id).toBeDefined();
      expect(request.amountUsd).toBe(10);
      expect(request.status).toBe("pending");
      expect(request.reference).toBe("invoice-001");
    });

    it("lists only pending payment requests", () => {
      createPaymentRequest(dbApi.raw, {
        amountUsd: 5,
        payer: "0xabcdef1234567890123456789012345678901234" as Address,
        reference: "inv-1",
      });

      createPaymentRequest(dbApi.raw, {
        amountUsd: 10,
        payer: "0x1234567890123456789012345678901234567890" as Address,
        reference: "inv-2",
      });

      const pending = listPaymentRequests(dbApi.raw, { status: "pending" });
      expect(pending).toHaveLength(2);
    });

    it("marks a payment request as paid with tx hash", () => {
      const request = createPaymentRequest(dbApi.raw, {
        amountUsd: 25,
        payer: "0xabcdef1234567890123456789012345678901234" as Address,
        reference: "inv-3",
      });

      const txHash = "0xabc123" as `0x${string}`;
      markPaymentRequestPaid(dbApi.raw, request.id, txHash);

      const pending = listPaymentRequests(dbApi.raw, { status: "pending" });
      expect(pending).toHaveLength(0);

      const paid = listPaymentRequests(dbApi.raw, { status: "paid" });
      expect(paid).toHaveLength(1);
      expect(paid[0].txHash).toBe(txHash);
    });
  });
});
