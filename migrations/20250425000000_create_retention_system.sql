-- Create retention policy and legal hold system
-- Migration: 20250425000000_create_retention_system.sql

-- Create retention policies table
CREATE TABLE IF NOT EXISTS retention_policies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    retention_days INTEGER NOT NULL CHECK (retention_days > 0),
    pii_fields TEXT[] NOT NULL DEFAULT '{"customer_name","customer_email","customer_tax_id"}',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- Create legal holds table
CREATE TABLE IF NOT EXISTS legal_holds (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
    hold_reason TEXT NOT NULL,
    hold_type VARCHAR(50) NOT NULL DEFAULT 'litigation' 
        CHECK (hold_type IN ('litigation', 'investigation', 'audit', 'regulatory')),
    status VARCHAR(50) NOT NULL DEFAULT 'active' 
        CHECK (status IN ('active', 'released', 'expired')),
    placed_by UUID REFERENCES users(id),
    placed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    released_at TIMESTAMP WITH TIME ZONE,
    release_reason TEXT,
    expires_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create retention audit log table
CREATE TABLE IF NOT EXISTS retention_audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
    operation VARCHAR(50) NOT NULL 
        CHECK (operation IN ('pii_purged', 'policy_applied', 'hold_placed', 'hold_released', 'dry_run')),
    pii_fields TEXT[] NOT NULL DEFAULT '{}',
    old_values JSONB DEFAULT '{}',
    new_values JSONB DEFAULT '{}',
    reason TEXT,
    performed_by UUID REFERENCES users(id),
    performed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

-- Create retention job executions table
CREATE TABLE IF NOT EXISTS retention_job_executions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    job_type VARCHAR(50) NOT NULL DEFAULT 'scheduled_purge',
    status VARCHAR(50) NOT NULL DEFAULT 'started' 
        CHECK (status IN ('started', 'completed', 'failed', 'cancelled')),
    dry_run BOOLEAN NOT NULL DEFAULT false,
    invoices_processed INTEGER NOT NULL DEFAULT 0,
    invoices_purged INTEGER NOT NULL DEFAULT 0,
    pii_fields_purged TEXT[] NOT NULL DEFAULT '{}',
    errors JSONB DEFAULT '{}',
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    performed_by UUID REFERENCES users(id),
    metadata JSONB DEFAULT '{}'
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_retention_policies_tenant_id ON retention_policies(tenant_id);
CREATE INDEX IF NOT EXISTS idx_retention_policies_active ON retention_policies(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_legal_holds_tenant_id ON legal_holds(tenant_id);
CREATE INDEX IF NOT EXISTS idx_legal_holds_invoice_id ON legal_holds(invoice_id);
CREATE INDEX IF NOT EXISTS idx_legal_holds_status ON legal_holds(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_legal_holds_expires_at ON legal_holds(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_retention_audit_tenant_id ON retention_audit_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_retention_audit_invoice_id ON retention_audit_log(invoice_id);
CREATE INDEX IF NOT EXISTS idx_retention_audit_operation ON retention_audit_log(operation);
CREATE INDEX IF NOT EXISTS idx_retention_audit_performed_at ON retention_audit_log(performed_at);
CREATE INDEX IF NOT EXISTS idx_retention_jobs_tenant_id ON retention_job_executions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_retention_jobs_status ON retention_job_executions(status);
CREATE INDEX IF NOT EXISTS idx_retention_jobs_started_at ON retention_job_executions(started_at);

-- Create triggers for updated_at
CREATE TRIGGER update_retention_policies_updated_at 
    BEFORE UPDATE ON retention_policies 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_legal_holds_updated_at 
    BEFORE UPDATE ON legal_holds 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Enable RLS
ALTER TABLE retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_job_executions ENABLE ROW LEVEL SECURITY;

-- RLS Policies for retention policies
CREATE POLICY retention_policy_tenant_policy ON retention_policies
    FOR ALL TO authenticated_role
    USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- RLS Policies for legal holds
CREATE POLICY legal_hold_tenant_policy ON legal_holds
    FOR ALL TO authenticated_role
    USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- RLS Policies for audit log (read-only for most users)
CREATE POLICY retention_audit_read_policy ON retention_audit_log
    FOR SELECT TO authenticated_role
    USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY retention_audit_insert_policy ON retention_audit_log
    FOR INSERT TO authenticated_role
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- RLS Policies for job executions
CREATE POLICY retention_job_tenant_policy ON retention_job_executions
    FOR ALL TO authenticated_role
    USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Add comments for documentation
COMMENT ON TABLE retention_policies IS 'Data retention policies for PII purging';
COMMENT ON TABLE legal_holds IS 'Legal holds that prevent PII purging';
COMMENT ON TABLE retention_audit_log IS 'Audit trail for all retention operations';
COMMENT ON TABLE retention_job_executions IS 'Execution history of retention purge jobs';

COMMENT ON COLUMN retention_policies.retention_days IS 'Number of days after which PII should be purged';
COMMENT ON COLUMN retention_policies.pii_fields IS 'Array of PII field names to purge';
COMMENT ON COLUMN legal_holds.hold_type IS 'Type of legal hold preventing purging';
COMMENT ON COLUMN legal_holds.expires_at IS 'Optional expiration date for temporary holds';
COMMENT ON COLUMN retention_audit_log.operation IS 'Type of retention operation performed';
COMMENT ON COLUMN retention_audit_log.pii_fields IS 'PII fields affected by this operation';
COMMENT ON COLUMN retention_job_executions.dry_run IS 'True if this was a dry-run execution';
COMMENT ON COLUMN retention_job_executions.invoices_purged IS 'Number of invoices that had PII purged';

-- Create default retention policy for new tenants (will be applied via triggers)
CREATE OR REPLACE FUNCTION create_default_retention_policy()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO retention_policies (tenant_id, name, description, retention_days, pii_fields)
    VALUES (
        NEW.id,
        'Default 7-Year Retention',
        'Default policy to purge PII after 7 years unless under legal hold',
        2555, -- 7 years in days
        ARRAY['customer_name', 'customer_email', 'customer_tax_id']
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to create default retention policy for new tenants
CREATE TRIGGER create_default_retention_policy_trigger
    AFTER INSERT ON tenants
    FOR EACH ROW
    EXECUTE FUNCTION create_default_retention_policy();
