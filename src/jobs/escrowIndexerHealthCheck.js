'use strict';

const logger = require('../logger');
const { 
  validateProjectionIntegrity,
  validateCursorOrdering,
  createKnexEscrowEventStore 
} = require('./escrowIndexer');
const db = require('../db/knex');

/**
 * Performs comprehensive health checks on the escrow indexer system.
 * @param {object} [options] - Health check options
 * @param {number} [options.sampleSize=100] - Number of projections to sample
 * @param {boolean} [options.checkCursorConsistency=true] - Whether to check cursor consistency
 * @param {boolean} [options.checkProjectionIntegrity=true] - Whether to check projection integrity
 * @returns {Promise<object>} Health check results
 */
async function performHealthCheck(options = {}) {
  const {
    sampleSize = 100,
    checkCursorConsistency = true,
    checkProjectionIntegrity = true
  } = options;
  
  const results = {
    status: 'healthy',
    checks: {},
    timestamp: new Date().toISOString(),
    issues: []
  };
  
  try {
    const store = createKnexEscrowEventStore(db);
    
    // Check cursor consistency
    if (checkCursorConsistency) {
      try {
        const cursor = await store.loadCursor();
        results.checks.cursorConsistency = {
          status: 'healthy',
          cursor,
          hasValidCursor: cursor !== null && typeof cursor === 'string'
        };
      } catch (error) {
        results.checks.cursorConsistency = {
          status: 'unhealthy',
          error: error.message
        };
        results.issues.push('cursor_consistency_check_failed');
      }
    }
    
    // Check projection integrity on a sample
    if (checkProjectionIntegrity) {
      try {
        const projections = await db('escrow_event_projection')
          .orderBy('updated_at', 'desc')
          .limit(sampleSize);
          
        let healthyProjections = 0;
        let corruptProjections = 0;
        const corruptionDetails = [];
        
        for (const projection of projections) {
          const integrityCheck = validateProjectionIntegrity(projection);
          if (integrityCheck.isValid) {
            healthyProjections++;
          } else {
            corruptProjections++;
            corruptionDetails.push({
              invoiceId: projection.invoice_id,
              violations: integrityCheck.violations
            });
            
            // Limit corruption details to prevent large responses
            if (corruptionDetails.length >= 10) {
              break;
            }
          }
        }
        
        const corruptionRate = projections.length > 0 ? 
          (corruptProjections / projections.length) * 100 : 0;
        
        results.checks.projectionIntegrity = {
          status: corruptionRate > 5 ? 'unhealthy' : 'healthy', // 5% threshold
          sampleSize: projections.length,
          healthyProjections,
          corruptProjections,
          corruptionRate: Math.round(corruptionRate * 100) / 100,
          corruptionDetails: corruptionDetails.slice(0, 5) // Limit output
        };
        
        if (corruptionRate > 5) {
          results.issues.push('high_projection_corruption_rate');
        }
      } catch (error) {
        results.checks.projectionIntegrity = {
          status: 'unhealthy',
          error: error.message
        };
        results.issues.push('projection_integrity_check_failed');
      }
    }
    
    // Check for recent activity
    try {
      const recentActivity = await db('escrow_events')
        .where('observed_at', '>', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .count('* as count')
        .first();
        
      const eventsLast24h = Number(recentActivity?.count || 0);
      
      results.checks.recentActivity = {
        status: eventsLast24h > 0 ? 'healthy' : 'warning',
        eventsLast24Hours: eventsLast24h,
        message: eventsLast24h === 0 ? 'No events processed in last 24 hours' : undefined
      };
      
      if (eventsLast24h === 0) {
        results.issues.push('no_recent_activity');
      }
    } catch (error) {
      results.checks.recentActivity = {
        status: 'unhealthy',
        error: error.message
      };
      results.issues.push('recent_activity_check_failed');
    }
    
    // Overall status determination
    const hasUnhealthyChecks = Object.values(results.checks).some(check => check.status === 'unhealthy');
    const hasWarnings = Object.values(results.checks).some(check => check.status === 'warning');
    
    if (hasUnhealthyChecks) {
      results.status = 'unhealthy';
    } else if (hasWarnings) {
      results.status = 'warning';
    }
    
  } catch (error) {
    results.status = 'unhealthy';
    results.error = error.message;
    results.issues.push('health_check_system_failure');
  }
  
  return results;
}

/**
 * Validates the overall consistency of the indexer state.
 * @returns {Promise<object>} Consistency validation result
 */
async function validateSystemConsistency() {
  const results = {
    isConsistent: true,
    violations: [],
    timestamp: new Date().toISOString()
  };
  
  try {
    // Check for orphaned projections (projections without corresponding events)
    const orphanedProjections = await db.raw(`
      SELECT p.invoice_id, p.latest_event_id
      FROM escrow_event_projection p
      LEFT JOIN escrow_events e ON p.latest_event_id = e.event_id
      WHERE e.event_id IS NULL
      LIMIT 10
    `);
    
    if (orphanedProjections.rows.length > 0) {
      results.isConsistent = false;
      results.violations.push({
        type: 'orphaned_projections',
        count: orphanedProjections.rows.length,
        examples: orphanedProjections.rows.map(row => ({
          invoiceId: row.invoice_id,
          missingEventId: row.latest_event_id
        }))
      });
    }
    
    // Check for events without projections (might indicate projection update failures)
    const eventsWithoutProjections = await db.raw(`
      SELECT DISTINCT e.invoice_id
      FROM escrow_events e
      LEFT JOIN escrow_event_projection p ON e.invoice_id = p.invoice_id
      WHERE p.invoice_id IS NULL
      LIMIT 10
    `);
    
    if (eventsWithoutProjections.rows.length > 0) {
      results.isConsistent = false;
      results.violations.push({
        type: 'events_without_projections',
        count: eventsWithoutProjections.rows.length,
        examples: eventsWithoutProjections.rows.map(row => row.invoice_id)
      });
    }
    
    // Check for projection timestamp inconsistencies
    const timestampInconsistencies = await db.raw(`
      SELECT p.invoice_id, p.latest_observed_at as projection_time, e.observed_at as event_time
      FROM escrow_event_projection p
      JOIN escrow_events e ON p.latest_event_id = e.event_id
      WHERE p.latest_observed_at != e.observed_at
      LIMIT 10
    `);
    
    if (timestampInconsistencies.rows.length > 0) {
      results.isConsistent = false;
      results.violations.push({
        type: 'timestamp_inconsistencies',
        count: timestampInconsistencies.rows.length,
        examples: timestampInconsistencies.rows.map(row => ({
          invoiceId: row.invoice_id,
          projectionTime: row.projection_time,
          eventTime: row.event_time
        }))
      });
    }
    
  } catch (error) {
    results.isConsistent = false;
    results.error = error.message;
    results.violations.push({
      type: 'consistency_check_failure',
      error: error.message
    });
  }
  
  return results;
}

module.exports = {
  performHealthCheck,
  validateSystemConsistency
};