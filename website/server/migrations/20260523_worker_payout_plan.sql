ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS worker_payout_class ENUM('compute','relay','test','unstable','premium','dedicated_b2b') NOT NULL DEFAULT 'compute',
  ADD COLUMN IF NOT EXISTS kyc_status ENUM('not_required','required','submitted','approved','rejected') NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS payout_status ENUM('enabled','hold','blocked') NOT NULL DEFAULT 'enabled',
  ADD COLUMN IF NOT EXISTS payout_min_withdrawal_eur DECIMAL(12,2) NULL,
  ADD COLUMN IF NOT EXISTS payout_notes VARCHAR(500) NULL;

ALTER TABLE worker_payout_ledger
  MODIFY status ENUM('pending','payable','approved','paid','void','fraud_review') NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS worker_class ENUM('compute','relay','test','unstable','premium','dedicated_b2b') NOT NULL DEFAULT 'compute' AFTER currency,
  ADD COLUMN IF NOT EXISTS quality_score DECIMAL(6,3) NOT NULL DEFAULT 0 AFTER worker_class,
  ADD COLUMN IF NOT EXISTS availability_score DECIMAL(6,3) NOT NULL DEFAULT 0 AFTER quality_score,
  ADD COLUMN IF NOT EXISTS latency_score DECIMAL(6,3) NOT NULL DEFAULT 0 AFTER availability_score,
  ADD COLUMN IF NOT EXISTS success_score DECIMAL(6,3) NOT NULL DEFAULT 1 AFTER latency_score,
  ADD COLUMN IF NOT EXISTS fraud_flags_json LONGTEXT NULL AFTER success_score,
  ADD COLUMN IF NOT EXISTS payout_batch_id VARCHAR(80) NULL AFTER status,
  ADD COLUMN IF NOT EXISTS invoice_reference VARCHAR(120) NULL AFTER payout_batch_id,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP NULL AFTER created_at,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP NULL AFTER approved_at;

CREATE INDEX IF NOT EXISTS idx_worker_payout_batch ON worker_payout_ledger (payout_batch_id);

CREATE TABLE IF NOT EXISTS worker_payout_batches (
  id VARCHAR(80) NOT NULL,
  status ENUM('draft','processing','paid','failed','cancelled') NOT NULL DEFAULT 'draft',
  currency CHAR(3) NOT NULL DEFAULT 'EUR',
  total_eur DECIMAL(12,6) NOT NULL DEFAULT 0,
  row_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  notes VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  KEY idx_worker_payout_batches_status_time (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
