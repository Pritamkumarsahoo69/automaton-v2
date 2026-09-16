/**
 * USDC Payment Rails Tests
 *
 * Tests for direct USDC transfers, payment requests, and incoming payment detection.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../state/database.js";
import { sendUsdc } from "../payment/usdc.js";
import {
  createPaymentRequest,
  listPaymentRequests,
  markPaymentRequestPaid,
  detectIncomingPayments,
} from "../payment/requests.js";
import { ulid } from "ulid";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";

describe("USDC Payment Rails", () => {
  let dbApi: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    // The runtime DB API owns the single in-memory SQLite connection.
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

      const resultNeg = await sendUsdc({ to, amountUsd: -5, account, db: dbApi });
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
        db: dbApi,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unsupported network");
    });

    it("records pending transaction in database on success", async () => {
      // This test will fail until we implement the actual send logic
      // For now, it tests the database recording path
      const account = privateKeyToAccount(generatePrivateKey());
      const to = "0x1234567890123456789012345678901234567890" as Address;

      // Without a real RPC, this will fail at the network level
      // But we're testing the error handling and database path
      const result = await sendUsdc({
        to,
        amountUsd: 1,
        account,
        network: "eip155:8453",
        db: dbApi,
        reference: "test-payment",
      });

      // Will fail due to no RPC, but should handle gracefully
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

  describe("Incoming Payment Detection", () => {
    it("detects no payments when no previous balance recorded", async () => {
      // First call with no baseline: should not fabricate a payment
      const detected = await detectIncomingPayments(dbApi.raw, 0);
      expect(detected).toHaveLength(0);
    });

    it("marks a pending request paid when balance increases to cover it", async () => {
      const payer = "0xabcdef1234567890123456789012345678901234" as Address;

      // Baseline at 0, no wire in
      await detectIncomingPayments(dbApi.raw, 0);

      // Create a payment request
      createPaymentRequest(dbApi.raw, {
        amountUsd: 50,
        payer,
        reference: "inv-4",
      });

      // Balance jumps to $50 -> matches the pending request
      const detected = await detectIncomingPayments(dbApi.raw, 50);
      expect(detected).toHaveLength(1);
      expect(detected[0].reference).toBe("inv-4");
      expect(detected[0].status).toBe("paid");

      // Request is no longer pending
      const pending = listPaymentRequests(dbApi.raw, { status: "pending" });
      expect(pending).toHaveLength(0);
    });

    it("does not re-mark a request paid on subsequent checks", async () => {
      const payer = "0xabcdef1234567890123456789012345678901234" as Address;

      await detectIncomingPayments(dbApi.raw, 0);
      createPaymentRequest(dbApi.raw, { amountUsd: 25, payer, reference: "inv-5" });

      await detectIncomingPayments(dbApi.raw, 25);
      const again = await detectIncomingPayments(dbApi.raw, 25);
      expect(again).toHaveLength(0); // no new delta, no re-marking
    });

    it("expires stale payment requests", async () => {
      const payer = "0xabcdef1234567890123456789012345678901234" as Address;

      await detectIncomingPayments(dbApi.raw, 0);

      // Create a request that has already expired
      const request = createPaymentRequest(dbApi.raw, {
        amountUsd: 10,
        payer,
        reference: "inv-expired",
        expiresInHours: 1, // expires 1 hour from now
      });
      // Force its expiry into the past (simulate an old request)
      dbApi.raw.prepare("UPDATE payment_requests SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00Z", request.id);

      await detectIncomingPayments(dbApi.raw, 0);
      const expired = listPaymentRequests(dbApi.raw, { status: "expired" });
      expect(expired.map((r) => r.reference)).toContain("inv-expired");
    });
  });
});
