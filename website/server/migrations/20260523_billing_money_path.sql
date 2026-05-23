CREATE TABLE IF NOT EXISTS billing_credit_ledger (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  type ENUM('credit_purchase','usage_debit','admin_adjustment','refund') NOT NULL,
  amount_eur DECIMAL(12,6) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'EUR',
  description VARCHAR(240) NULL,
  reference_type VARCHAR(80) NULL,
  reference_id VARCHAR(120) NULL,
  metadata_json LONGTEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_billing_ledger_user_time (user_id, created_at),
  KEY idx_billing_ledger_reference (reference_type, reference_id),
  UNIQUE KEY uq_billing_ledger_reference_once (user_id, reference_type, reference_id),
  CONSTRAINT fk_billing_ledger_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS billing_checkout_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  provider VARCHAR(40) NOT NULL DEFAULT 'stripe',
  provider_session_id VARCHAR(120) NULL,
  amount_eur DECIMAL(12,6) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'EUR',
  status VARCHAR(40) NOT NULL DEFAULT 'created',
  checkout_url TEXT NULL,
  metadata_json LONGTEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_billing_checkout_provider_session (provider, provider_session_id),
  KEY idx_billing_checkout_user_time (user_id, created_at),
  CONSTRAINT fk_billing_checkout_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE api_key_usage
  ADD COLUMN IF NOT EXISTS cost_input_eur DECIMAL(12,6) NULL,
  ADD COLUMN IF NOT EXISTS cost_output_eur DECIMAL(12,6) NULL,
  ADD COLUMN IF NOT EXISTS billing_mode VARCHAR(24) NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS pricing_snapshot_json LONGTEXT NULL;
