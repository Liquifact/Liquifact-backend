'use strict';

const { performHealthCheck, validateSystemConsistency } = require('../../src/jobs/escrowIndexerHealthCheck');

// Mock database
const mockDb = {
  raw: jest.fn(),
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  count: jest.fn().mockReturnThis(),
  first: jest.fn(),
};

// Mock store
const mockStore = {
  loadCursor: jest.fn(),
};

jest.mock('../../src/db/knex', () => mockDb);
jest.mock('../../src/jobs/escrowIndexer', () => ({
  createKnexEscrowEventStore: jest.fn(() => mockStore),
  validateProjectionIntegrity: jest.fn()
}));

const { validateProjectionIntegrity } = require('../../src/jobs/escrowIndexer');

describe('Escrow Indexer Health Check Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('performHealthCheck', () => {
    test('returns healthy status when all checks pass', async () => {
      // Mock successful cursor check
      mockStore.loadCursor.mockResolvedValue('12345-1');
      
      // Mock healthy projections
      const healthyProjections = Array.from({ length: 10 }, (_, i) => ({
        invoice_id: `inv_${i}`,
        latest_event_id: `evt_${i}`,
        latest_event_type: 'escrow_created',
        latest_ledger_sequence: 1000 + i,
        latest_observed_at: new Date().toISOString()
      }));
      
      mockDb.limit.mockResolvedValue(healthyProjections);
      validateProjectionIntegrity.mockReturnValue({ isValid: true });
      
      // Mock recent activity
      mockDb.first.mockResolvedValue({ count: 150 });

      const result = await performHealthCheck({ sampleSize: 10 });

      expect(result.status).toBe('healthy');
      expect(result.checks.cursorConsistency.status).toBe('healthy');
      expect(result.checks.projectionIntegrity.status).toBe('healthy');
      expect(result.checks.recentActivity.status).toBe('healthy');
      expect(result.issues).toEqual([]);
    });

    test('detects cursor consistency issues', async () => {
      mockStore.loadCursor.mockRejectedValue(new Error('Database connection failed'));
      mockDb.limit.mockResolvedValue([]);
      mockDb.first.mockResolvedValue({ count: 0 });

      const result = await performHealthCheck();

      expect(result.status).toBe('unhealthy');
      expect(result.checks.cursorConsistency.status).toBe('unhealthy');
      expect(result.issues).toContain('cursor_consistency_check_failed');
    });

    test('detects high projection corruption rate', async () => {
      mockStore.loadCursor.mockResolvedValue('12345-1');
      
      const mixedProjections = [
        { invoice_id: 'inv_1', latest_event_id: 'evt_1' },
        { invoice_id: 'inv_2', latest_event_id: 'evt_2' },
        { invoice_id: 'inv_3', latest_event_id: 'evt_3' },
        { invoice_id: 'inv_4', latest_event_id: 'evt_4' },
      ];
      
      mockDb.limit.mockResolvedValue(mixedProjections);
      mockDb.first.mockResolvedValue({ count: 50 });
      
      // Mock 50% corruption rate (2 out of 4 corrupted)
      validateProjectionIntegrity
        .mockReturnValueOnce({ isValid: true })
        .mockReturnValueOnce({ 
          isValid: false, 
          violations: [{ type: 'missing_required_field', field: 'latest_event_type' }] 
        })
        .mockReturnValueOnce({ isValid: true })
        .mockReturnValueOnce({ 
          isValid: false, 
          violations: [{ type: 'invalid_timestamp_format' }] 
        });

      const result = await performHealthCheck({ sampleSize: 4 });

      expect(result.status).toBe('unhealthy');
      expect(result.checks.projectionIntegrity.status).toBe('unhealthy');
      expect(result.checks.projectionIntegrity.corruptionRate).toBe(50);
      expect(result.issues).toContain('high_projection_corruption_rate');
    });

    test('detects lack of recent activity', async () => {
      mockStore.loadCursor.mockResolvedValue('12345-1');
      mockDb.limit.mockResolvedValue([]);
      mockDb.first.mockResolvedValue({ count: 0 }); // No events in last 24h

      const result = await performHealthCheck();

      expect(result.checks.recentActivity.status).toBe('warning');
      expect(result.checks.recentActivity.eventsLast24Hours).toBe(0);
      expect(result.issues).toContain('no_recent_activity');
    });

    test('handles database errors gracefully', async () => {
      mockStore.loadCursor.mockRejectedValue(new Error('Connection timeout'));
      mockDb.limit.mockRejectedValue(new Error('Table not found'));
      mockDb.first.mockRejectedValue(new Error('Query failed'));

      const result = await performHealthCheck();

      expect(result.status).toBe('unhealthy');
      expect(result.checks.cursorConsistency.status).toBe('unhealthy');
      expect(result.checks.projectionIntegrity.status).toBe('unhealthy');
      expect(result.checks.recentActivity.status).toBe('unhealthy');
      expect(result.issues.length).toBeGreaterThan(0);
    });

    test('allows selective check execution', async () => {
      mockStore.loadCursor.mockResolvedValue('12345-1');

      const result = await performHealthCheck({ 
        checkCursorConsistency: true,
        checkProjectionIntegrity: false
      });

      expect(result.checks.cursorConsistency).toBeDefined();
      expect(result.checks.projectionIntegrity).toBeUndefined();
    });

    test('limits corruption details in response', async () => {
      mockStore.loadCursor.mockResolvedValue('12345-1');
      
      // Create 20 corrupted projections
      const corruptedProjections = Array.from({ length: 20 }, (_, i) => ({
        invoice_id: `corrupt_inv_${i}`,
        latest_event_id: `evt_${i}`
      }));
      
      mockDb.limit.mockResolvedValue(corruptedProjections);
      mockDb.first.mockResolvedValue({ count: 10 });
      
      validateProjectionIntegrity.mockReturnValue({ 
        isValid: false, 
        violations: [{ type: 'corruption_detected' }] 
      });

      const result = await performHealthCheck({ sampleSize: 20 });

      // Should limit corruption details to prevent large responses
      expect(result.checks.projectionIntegrity.corruptionDetails.length).toBeLessThanOrEqual(5);
    });
  });

  describe('validateSystemConsistency', () => {
    test('detects orphaned projections', async () => {
      mockDb.raw.mockResolvedValueOnce({
        rows: [
          { invoice_id: 'inv_orphan_1', latest_event_id: 'missing_evt_1' },
          { invoice_id: 'inv_orphan_2', latest_event_id: 'missing_evt_2' }
        ]
      }).mockResolvedValueOnce({
        rows: []
      }).mockResolvedValueOnce({
        rows: []
      });

      const result = await validateSystemConsistency();

      expect(result.isConsistent).toBe(false);
      expect(result.violations).toContainEqual({
        type: 'orphaned_projections',
        count: 2,
        examples: [
          { invoiceId: 'inv_orphan_1', missingEventId: 'missing_evt_1' },
          { invoiceId: 'inv_orphan_2', missingEventId: 'missing_evt_2' }
        ]
      });
    });

    test('detects events without projections', async () => {
      mockDb.raw.mockResolvedValueOnce({
        rows: []
      }).mockResolvedValueOnce({
        rows: [
          { invoice_id: 'inv_no_proj_1' },
          { invoice_id: 'inv_no_proj_2' }
        ]
      }).mockResolvedValueOnce({
        rows: []
      });

      const result = await validateSystemConsistency();

      expect(result.isConsistent).toBe(false);
      expect(result.violations).toContainEqual({
        type: 'events_without_projections',
        count: 2,
        examples: ['inv_no_proj_1', 'inv_no_proj_2']
      });
    });

    test('detects timestamp inconsistencies', async () => {
      mockDb.raw.mockResolvedValueOnce({
        rows: []
      }).mockResolvedValueOnce({
        rows: []
      }).mockResolvedValueOnce({
        rows: [
          { 
            invoice_id: 'inv_timestamp_1',
            projection_time: '2026-01-01T00:00:00Z',
            event_time: '2026-01-01T00:01:00Z'
          }
        ]
      });

      const result = await validateSystemConsistency();

      expect(result.isConsistent).toBe(false);
      expect(result.violations).toContainEqual({
        type: 'timestamp_inconsistencies',
        count: 1,
        examples: [{
          invoiceId: 'inv_timestamp_1',
          projectionTime: '2026-01-01T00:00:00Z',
          eventTime: '2026-01-01T00:01:00Z'
        }]
      });
    });

    test('returns consistent when no violations found', async () => {
      mockDb.raw.mockResolvedValue({ rows: [] });

      const result = await validateSystemConsistency();

      expect(result.isConsistent).toBe(true);
      expect(result.violations).toEqual([]);
    });

    test('handles database errors in consistency checks', async () => {
      mockDb.raw.mockRejectedValue(new Error('Query execution failed'));

      const result = await validateSystemConsistency();

      expect(result.isConsistent).toBe(false);
      expect(result.violations).toContainEqual({
        type: 'consistency_check_failure',
        error: 'Query execution failed'
      });
    });

    test('limits examples in violation reports', async () => {
      // Create more than 10 orphaned projections
      const manyOrphanedRows = Array.from({ length: 15 }, (_, i) => ({
        invoice_id: `inv_${i}`,
        latest_event_id: `evt_${i}`
      }));

      mockDb.raw.mockResolvedValueOnce({
        rows: manyOrphanedRows
      }).mockResolvedValueOnce({
        rows: []
      }).mockResolvedValueOnce({
        rows: []
      });

      const result = await validateSystemConsistency();

      const orphanedViolation = result.violations.find(v => v.type === 'orphaned_projections');
      expect(orphanedViolation).toBeDefined();
      expect(orphanedViolation.count).toBe(15);
      expect(orphanedViolation.examples.length).toBeLessThanOrEqual(10);
    });
  });

  describe('Health Check Integration Scenarios', () => {
    test('comprehensive health check under normal conditions', async () => {
      mockStore.loadCursor.mockResolvedValue('98765-4');
      
      const healthyProjections = Array.from({ length: 50 }, (_, i) => ({
        invoice_id: `healthy_inv_${i}`,
        latest_event_id: `evt_${i}`,
        latest_event_type: 'escrow_created',
        latest_ledger_sequence: 2000 + i,
        latest_observed_at: new Date(Date.now() - i * 1000).toISOString()
      }));
      
      mockDb.limit.mockResolvedValue(healthyProjections);
      validateProjectionIntegrity.mockReturnValue({ isValid: true });
      mockDb.first.mockResolvedValue({ count: 500 });

      const result = await performHealthCheck({ sampleSize: 50 });

      expect(result.status).toBe('healthy');
      expect(result.checks.cursorConsistency.hasValidCursor).toBe(true);
      expect(result.checks.projectionIntegrity.corruptionRate).toBe(0);
      expect(result.checks.recentActivity.eventsLast24Hours).toBe(500);
    });

    test('partial degradation scenario', async () => {
      mockStore.loadCursor.mockResolvedValue('98765-4');
      
      const partiallyCorruptedProjections = Array.from({ length: 20 }, (_, i) => ({
        invoice_id: `test_inv_${i}`,
        latest_event_id: `evt_${i}`,
      }));
      
      mockDb.limit.mockResolvedValue(partiallyCorruptedProjections);
      mockDb.first.mockResolvedValue({ count: 5 }); // Low activity
      
      // 10% corruption rate (2 out of 20)
      validateProjectionIntegrity.mockImplementation((projection, index) => {
        if (projection.invoice_id === 'test_inv_3' || projection.invoice_id === 'test_inv_17') {
          return { 
            isValid: false, 
            violations: [{ type: 'missing_field', field: 'latest_event_type' }] 
          };
        }
        return { isValid: true };
      });

      const result = await performHealthCheck({ sampleSize: 20 });

      expect(result.status).toBe('warning'); // Not unhealthy due to low corruption rate
      expect(result.checks.projectionIntegrity.status).toBe('healthy'); // Under 5% threshold
      expect(result.checks.recentActivity.status).toBe('warning'); // Low activity
    });
  });
});