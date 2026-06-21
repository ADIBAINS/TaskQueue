-- Migration 001: Core tables
-- Creates the foundational schema for the task queue platform.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type VARCHAR(50) NOT NULL,
  priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  payload JSONB NOT NULL DEFAULT '{}',
  idempotency_key VARCHAR(255) UNIQUE,
  correlation_id UUID NOT NULL DEFAULT uuid_generate_v4(),
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error_message TEXT,
  worker_id VARCHAR(100),
  on_success JSONB,
  on_failure JSONB,
  webhook_url VARCHAR(2048),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_jobs_status ON jobs (status);
CREATE INDEX idx_jobs_type ON jobs (type);
CREATE INDEX idx_jobs_priority ON jobs (priority);
CREATE INDEX idx_jobs_idempotency ON jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_jobs_correlation ON jobs (correlation_id);
CREATE INDEX idx_jobs_created ON jobs (created_at DESC);
CREATE INDEX idx_jobs_status_type ON jobs (status, type);

CREATE TABLE IF NOT EXISTS workers (
  worker_id VARCHAR(100) PRIMARY KEY,
  worker_type VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'idle',
  current_job_count INTEGER NOT NULL DEFAULT 0,
  max_concurrency INTEGER NOT NULL DEFAULT 5,
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  previous_status VARCHAR(20),
  new_status VARCHAR(20) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_job ON audit_log (job_id);
CREATE INDEX idx_audit_created ON audit_log (created_at DESC);

CREATE TABLE IF NOT EXISTS dlq (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id UUID NOT NULL,
  job_type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL,
  error_message TEXT NOT NULL,
  retry_count INTEGER NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  requeued BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_dlq_type ON dlq (job_type);
CREATE INDEX idx_dlq_failed ON dlq (failed_at DESC);

CREATE TABLE IF NOT EXISTS cron_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL UNIQUE,
  cron_expression VARCHAR(100) NOT NULL,
  job_type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 3,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_run TIMESTAMPTZ,
  next_run TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS migrations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger to auto-update updated_at on jobs
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_jobs_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_cron_jobs_updated_at
  BEFORE UPDATE ON cron_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
