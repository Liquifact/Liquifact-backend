# Data Retention System Documentation

## Overview

The LiquiFact data retention system provides automated PII (Personally Identifiable Information) purging for invoices while respecting legal holds and compliance requirements. The system is designed to never delete on-chain data, only off-chain PII stored in the database.

## Architecture

### Core Components

1. **Retention Policies** - Define how long PII should be retained before purging
2. **Legal Holds** - Prevent purging of PII for invoices under legal investigation
3. **Retention Job** - Background worker that processes eligible invoices
4. **Audit Trail** - Complete logging of all retention operations
5. **Dry Run Mode** - Safe simulation of purging operations

### Database Schema

#### Retention Policies (`retention_policies`)
- `tenant_id` - Multi-tenant isolation
- `name` - Policy name for identification
- `retention_days` - Number of days before PII purging
- `pii_fields` - Array of PII field names to purge
- `is_active` - Whether policy is currently active

#### Legal Holds (`legal_holds`)
- `tenant_id` - Multi-tenant isolation
- `invoice_id` - Reference to protected invoice
- `hold_reason` - Reason for legal hold
- `hold_type` - Type of hold (litigation, investigation, audit, regulatory)
- `status` - Current hold status (active, released, expired)
- `expires_at` - Optional expiration for temporary holds

#### Audit Log (`retention_audit_log`)
- `tenant_id` - Multi-tenant isolation
- `invoice_id` - Reference to affected invoice
- `operation` - Type of operation performed
- `pii_fields` - PII fields affected
- `old_values` - Original PII values before purging
- `performed_by` - User who initiated the operation

#### Job Executions (`retention_job_executions`)
- `tenant_id` - Multi-tenant isolation
- `job_type` - Type of retention job
- `status` - Execution status
- `dry_run` - Whether this was a simulation
- `invoices_processed` - Number of invoices examined
- `invoices_purged` - Number of invoices with PII purged

## PII Fields

The system currently supports purging the following PII fields from invoices:

- `customer_name` - Customer full name
- `customer_email` - Customer email address  
- `customer_tax_id` - Customer tax identification number

## Security Features

### Multi-Tenant Isolation
- Row Level Security (RLS) ensures tenants can only access their own data
- All operations are scoped to tenant context
- Audit logs maintain tenant separation

### Legal Hold Protection
- Invoices under active legal holds are automatically excluded from purging
- Supports multiple hold types with expiration dates
- Hold status tracking for compliance auditing

### Audit Trail
- Every retention operation is logged with complete context
- Captures original PII values before purging
- Tracks who performed the operation and when
- Immutable audit records for compliance

### Dry Run Mode
- Safe simulation without data modification
- Validates eligibility and legal hold status
- Provides detailed preview of what would be purged
- Essential for compliance validation

## Usage Examples

### Scheduling a Retention Job

```javascript
const retentionJob = require('./src/jobs/retentionPurge');

// Schedule dry run to preview what would be purged
const dryRunJobId = retentionJob.scheduleRetentionPurge({
  tenantId: 'tenant-uuid',
  policyId: 'policy-uuid',
  dryRun: true,
  performedBy: 'user-uuid'
});

// Schedule actual purging job
const purgeJobId = retentionJob.scheduleRetentionPurge({
  tenantId: 'tenant-uuid',
  policyId: 'policy-uuid',
  dryRun: false,
  performedBy: 'user-uuid',
  batchSize: 100
});
```

### Creating a Legal Hold

```sql
INSERT INTO legal_holds (
  tenant_id, 
  invoice_id, 
  hold_reason, 
  hold_type, 
  placed_by
) VALUES (
  'tenant-uuid',
  'invoice-uuid', 
  'Pending litigation - Case #12345',
  'litigation',
  'user-uuid'
);
```

### Creating a Retention Policy

```sql
INSERT INTO retention_policies (
  tenant_id,
  name,
  description,
  retention_days,
  pii_fields,
  is_active
) VALUES (
  'tenant-uuid',
  '7-Year Standard Retention',
  'Standard policy to purge PII after 7 years',
  2555, -- 7 years in days
  ARRAY['customer_name', 'customer_email', 'customer_tax_id'],
  true
);
```

## API Endpoints

### Retention Management

#### Create Retention Policy
```http
POST /api/retention/policies
Content-Type: application/json
Authorization: Bearer <token>

{
  "name": "5-Year Retention",
  "description": "Purge PII after 5 years",
  "retentionDays": 1825,
  "piiFields": ["customer_name", "customer_email"],
  "isActive": true
}
```

#### Create Legal Hold
```http
POST /api/retention/legal-holds
Content-Type: application/json
Authorization: Bearer <token>

{
  "invoiceId": "invoice-uuid",
  "holdReason": "Regulatory investigation",
  "holdType": "regulatory",
  "expiresAt": "2025-12-31T23:59:59Z"
}
```

#### Schedule Retention Job
```http
POST /api/retention/jobs/schedule
Content-Type: application/json
Authorization: Bearer <token>

{
  "policyId": "policy-uuid",
  "dryRun": true,
  "batchSize": 50
}
```

#### Get Job Status
```http
GET /api/retention/jobs/{executionId}
Authorization: Bearer <token>
```

#### Get Audit Log
```http
GET /api/retention/audit?startDate=2024-01-01&endDate=2024-12-31
Authorization: Bearer <token>
```

## Configuration

### Environment Variables

```bash
# Retention job configuration
RETENTION_BATCH_SIZE=100
RETENTION_POLL_INTERVAL_MS=5000
RETENTION_MAX_CONCURRENCY=1

# Legal hold defaults
LEGAL_HOLD_DEFAULT_TYPE=litigation
LEGAL_HOLD_DEFAULT_EXPIRY_DAYS=365
```

### Default Policy

New tenants automatically receive a default 7-year retention policy:

```sql
-- Applied automatically via trigger
INSERT INTO retention_policies (
  tenant_id,
  name,
  description,
  retention_days,
  pii_fields
) VALUES (
  <tenant_id>,
  'Default 7-Year Retention',
  'Default policy to purge PII after 7 years unless under legal hold',
  2555,
  ARRAY['customer_name', 'customer_email', 'customer_tax_id']
);
```

## Operations Guide

### Daily Operations

1. **Monitor Job Executions**
   - Check `retention_job_executions` for failed jobs
   - Review error logs and retry if necessary

2. **Review Legal Holds**
   - Audit active legal holds regularly
   - Release expired holds promptly
   - Document hold reasons properly

3. **Validate Policies**
   - Ensure retention periods meet regulatory requirements
   - Update policies as regulations change
   - Test policy changes with dry runs first

### Monthly Compliance

1. **Audit Trail Review**
   - Export audit logs for compliance reporting
   - Verify all operations have proper authorization
   - Check for any unexpected purging activity

2. **Policy Effectiveness**
   - Analyze purging patterns and volumes
   - Adjust retention periods if needed
   - Update PII field mappings as schema evolves

### Incident Response

1. **Accidental Purging**
   - Immediately stop all retention jobs
   - Review audit logs to identify scope
   - Notify compliance and legal teams
   - Document incident and remediation steps

2. **Legal Hold Violation**
   - Investigate how purging occurred despite hold
   - Review legal hold placement process
   - Implement additional safeguards
   - Report to legal compliance team

## Testing

### Unit Tests
```bash
# Run retention-specific tests
npm test -- tests/retention.dryRun.test.js

# Run with coverage
npm run test:coverage -- tests/retention.dryRun.test.js
```

### Integration Tests
```bash
# Test full retention workflow
npm run test:integration

# Test with sample data
npm run test:e2e
```

### Dry Run Validation
Always validate changes with dry runs:

```javascript
// Test new policy before activation
const testJobId = retentionJob.scheduleRetentionPurge({
  tenantId: 'test-tenant',
  policyId: 'new-policy',
  dryRun: true,
  performedBy: 'admin-user'
});

// Review results before enabling actual purging
const results = await retentionJob.getExecutionStatus(executionId);
console.log(`Would process ${results.invoices_processed} invoices`);
console.log(`Would purge PII from ${results.invoices_purged} invoices`);
```

## Monitoring and Alerting

### Key Metrics

- **Job Success Rate** - Percentage of successful retention jobs
- **Processing Volume** - Number of invoices processed per job
- **Purging Volume** - Number of invoices with PII purged
- **Legal Hold Coverage** - Percentage of high-risk invoices under hold
- **Error Rate** - Failed jobs and error types

### Alert Thresholds

- Job failure rate > 5%
- No successful jobs in 24 hours
- Legal hold placed on > 100 invoices in 1 hour
- Audit log anomalies detected

### Log Monitoring

Monitor these log patterns:
- `retention job failed`
- `legal hold violation`
- `pii purged` (for unexpected purging)
- `dry run completed`

## Compliance Considerations

### GDPR Compliance
- Right to be forgotten: PII purging after retention period
- Data minimization: Only retain necessary PII
- Accountability: Complete audit trail
- Data protection: Legal hold safeguards

### SOX Compliance
- Document retention: Maintain required periods
- Access controls: Role-based permissions
- Change management: Policy change tracking
- Audit trails: Immutable operation logs

### Industry Regulations
- Financial services: 7-year standard retention
- Healthcare: HIPAA-specific requirements
- Government: FOIA and records management
- International: Cross-border data transfer rules

## Troubleshooting

### Common Issues

1. **Jobs Not Processing**
   - Check worker status: `retentionWorker.isRunning`
   - Verify queue: `retentionQueue.getStats()`
   - Review error logs for handler failures

2. **Invoices Not Purging**
   - Verify retention period calculation
   - Check for active legal holds
   - Confirm policy is active
   - Review tenant context settings

3. **Performance Issues**
   - Reduce batch size
   - Add database indexes
   - Optimize retention queries
   - Consider partitioning large tables

4. **Legal Hold Problems**
   - Verify hold status is 'active'
   - Check expiration dates
   - Confirm tenant ID matching
   - Review hold placement permissions

### Debug Queries

```sql
-- Check eligible invoices for purging
SELECT i.id, i.invoice_number, i.created_at, i.customer_name
FROM invoices i
LEFT JOIN legal_holds lh ON i.id = lh.invoice_id 
  AND lh.status = 'active' 
  AND (lh.expires_at IS NULL OR lh.expires_at > NOW())
WHERE i.tenant_id = 'tenant-uuid'
  AND i.created_at < NOW() - INTERVAL '30 days'
  AND i.deleted_at IS NULL
  AND lh.id IS NULL;

-- Check active legal holds
SELECT lh.*, i.invoice_number
FROM legal_holds lh
JOIN invoices i ON lh.invoice_id = i.id
WHERE lh.tenant_id = 'tenant-uuid'
  AND lh.status = 'active';

-- Review recent job executions
SELECT * 
FROM retention_job_executions 
WHERE tenant_id = 'tenant-uuid'
ORDER BY started_at DESC 
LIMIT 10;
```

## Migration and Deployment

### Database Migration
```bash
# Run retention system migration
npm run db:migrate

# Verify new tables
psql $DATABASE_URL -c "\dt retention_*"
```

### Application Deployment
1. Deploy migration first
2. Update application code
3. Restart retention worker
4. Verify worker health
5. Run dry run validation

### Rollback Procedure
1. Stop retention worker
2. Disable active policies
3. Place emergency legal holds if needed
4. Restore from backup if data loss occurred
5. Investigate root cause

## Best Practices

### Policy Management
- Start with conservative retention periods
- Test policies thoroughly with dry runs
- Document policy changes and reasons
- Review policies quarterly with legal team

### Legal Hold Process
- Standardize hold request procedures
- Require proper documentation for holds
- Set expiration dates for temporary holds
- Review holds monthly with legal team

### Operational Safety
- Always use dry run for testing
- Monitor job executions closely
- Maintain comprehensive audit logs
- Implement proper access controls

### Performance Optimization
- Use appropriate batch sizes
- Schedule jobs during low-traffic periods
- Monitor database performance
- Consider archiving very old data

## Support and Escalation

### Level 1 Support
- Monitor job status and basic errors
- Restart failed jobs
- Check configuration settings
- Verify user permissions

### Level 2 Support  
- Investigate database issues
- Analyze performance problems
- Review legal hold configurations
- Debug complex job failures

### Level 3 Support
- Database schema changes
- System architecture modifications
- Security incident response
- Compliance violation investigation

### Escalation Contacts
- Database Administrator: dba@liquifact.com
- Security Team: security@liquifact.com  
- Legal Compliance: legal@liquifact.com
- Engineering Lead: eng@liquifact.com
