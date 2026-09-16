/**
 * Schema Migrations
 *
 * Payment Requests table migration (v12).
 * Added to the existing migration system.
 */

export const MIGRATION_V12 = `
  -- Schema version: 12
  -- Payment Requests for USDC-on-Base revenue

  CREATE TABLE IF NOT EXISTS payment_requests (
    id TEXT PRIMARY KEY,
    amount_cents INTEGER NOT NULL,
    payer TEXT NOT NULL,
    reference TEXT,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','expired','cancelled')),
    tx_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,
    paid_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON payment_requests(status);
  CREATE INDEX IF NOT EXISTS idx_payment_requests_payer ON payment_requests(payer);
  CREATE INDEX IF NOT EXISTS idx_payment_requests_reference ON payment_requests(reference);
`;

// Export the migration version constant
export const PAYMENT_SCHEMA_VERSION = 12;