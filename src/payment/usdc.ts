/**
 * USDC Payment Rails
 *
 * Send USDC directly on Base, create payment requests/invoices,
 * and detect incoming payments. Built on viem (already in deps).
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  type Address,
  type PrivateKeyAccount,
  type Hex,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import type { DatabaseType } from "../state/database.js";
import { onchainTxInsert, onchainTxUpdateStatus, insertSpendRecord } from "../state/database.js";
import { ulid } from "ulid";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("payment.usdc");

// USDC contract addresses (same as x402.ts)
const USDC_ADDRESSES: Record<string, Address> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
};

const CHAINS: Record<string, any> = {
  "eip155:8453": base,
  "eip155:84532": baseSepolia,
};

// Minimal ERC20 ABI for transfer
const ERC20_TRANSFER_ABI = [
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// ERC-20 Transfer event ABI for log filtering
export const USDC_TRANSFER_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
    name: "Transfer",
    type: "event",
  },
] as const;

/** Supported Base networks for USDC operations. */
export type BaseUsdcNetwork = "eip155:8453" | "eip155:84532";

/** USDC contract addresses per network (exported for verifier use). */
export const BASE_USDC_ADDRESSES: Record<BaseUsdcNetwork, Address> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

/** Chain objects per network (exported for client creation). */
export const BASE_USDC_CHAINS: Record<BaseUsdcNetwork, any> = {
  "eip155:8453": base,
  "eip155:84532": baseSepolia,
};

/**
 * Create a viem public client configured for querying Base USDC transfer logs.
 * Falls back to public RPC when no custom endpoint is provided.
 */
export function createBaseUsdcLogClient(
  network: BaseUsdcNetwork,
  rpcUrl?: string,
): any {
  const chain = BASE_USDC_CHAINS[network];
  if (!chain) {
    throw new Error(`Unsupported Base network: ${network}`);
  }
  return createPublicClient({
    chain,
    transport: http(rpcUrl ?? undefined, { timeout: 15_000 }),
  });
}

export interface SendUsdcOptions {
  to: Address;
  amountUsd: number;
  account: PrivateKeyAccount;
  network?: "eip155:8453" | "eip155:84532";
  db?: DatabaseType;
  reference?: string;
}

export interface SendUsdcResult {
  success: boolean;
  txHash?: Hex;
  amountUsd: number;
  to: Address;
  error?: string;
}

/**
 * Send USDC directly to a recipient address on Base.
 * Uses the automaton's EVM wallet (PrivateKeyAccount).
 */
export async function sendUsdc(opts: SendUsdcOptions): Promise<SendUsdcResult> {
  const { to, amountUsd, account, network = "eip155:8453", db, reference } = opts;

  const chain = CHAINS[network];
  const usdcAddress = USDC_ADDRESSES[network];
  if (!chain || !usdcAddress) {
    return { success: false, amountUsd, to, error: `Unsupported network: ${network}` };
  }

  if (amountUsd <= 0) {
    return { success: false, amountUsd, to, error: "Amount must be positive" };
  }

  // USDC has 6 decimals
  const amountAtomic = parseUnits(amountUsd.toFixed(6), 6);

  const rpcUrl = process.env.AUTOMATON_RPC_URL || undefined;

  try {
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl, { timeout: 30_000 }),
    });

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl, { timeout: 30_000 }),
    });

    // Simulate first (catches insufficient balance, etc.)
    await publicClient.simulateContract({
      address: usdcAddress,
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [to, amountAtomic],
      account,
      chain,
    });

    // Send the transaction
    const txHash = await walletClient.writeContract({
      address: usdcAddress,
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [to, amountAtomic],
      chain,
    });

    // Record in onchain_transactions if db provided
    if (db) {
      const id = ulid();
      onchainTxInsert(db, {
        id,
        txHash,
        chain: network,
        operation: "usdc_transfer",
        status: "pending",
        gasUsed: null,
        metadata: JSON.stringify({ to, amountUsd, reference }),
        createdAt: new Date().toISOString(),
      });

      // Record spend for policy tracking
      const now = new Date();
      const hour = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}T${String(now.getUTCHours()).padStart(2, "0")}`;
      const day = hour.slice(0, 10);
      insertSpendRecord(db, {
        id: ulid(),
        toolName: "send_usdc",
        amountCents: Math.round(amountUsd * 100),
        recipient: to,
        domain: null,
        category: "transfer",
        windowHour: hour,
        windowDay: day,
      });
    }

    logger.info(`USDC transfer submitted: ${amountUsd} USDC to ${to} on ${network}, tx=${txHash}`);

    // Wait for confirmation (optional but recommended)
    try {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 60_000,
      });
      if (db) {
        onchainTxUpdateStatus(db, txHash, "confirmed", Number(receipt.gasUsed));
      }
      logger.info(`USDC transfer confirmed: tx=${txHash}`);
    } catch (confirmErr) {
      // Transaction was submitted; let heartbeat task finalize status
      logger.warn(`USDC transfer submitted but confirmation timed out: tx=${txHash}`);
    }

    return { success: true, txHash, amountUsd, to };
  } catch (err: any) {
    const message = err?.message || String(err);
    logger.error(`USDC transfer failed: ${message}`);
    return { success: false, amountUsd, to, error: message };
  }
}
