const {
  ALLOWED_STATUSES,
  TRANSITIONS,
  canTransition,
  validateStatusTransition
} = require('../utils/invoiceStateMachine');

describe('Invoice State Machine', () => {
  describe('Properties', () => {
    it('should have correct allowed statuses', () => {
      expect(ALLOWED_STATUSES).toEqual([
        'draft',
        'pending_verification',
        'approved',
        'funded',
        'settled',
        'closed'
      ]);
      expect(Object.isFrozen(ALLOWED_STATUSES)).toBe(true);
    });

    it('should have correct transition rules map', () => {
      expect(TRANSITIONS.draft).toEqual(['pending_verification']);
      expect(TRANSITIONS.pending_verification).toEqual(['approved']);
      expect(TRANSITIONS.approved).toEqual(['funded']);
      expect(TRANSITIONS.funded).toEqual(['settled']);
      expect(TRANSITIONS.settled).toEqual(['closed']);
      expect(TRANSITIONS.closed).toEqual([]);
      expect(Object.isFrozen(TRANSITIONS)).toBe(true);
    });
  });

  describe('canTransition()', () => {
    it('should allow valid transitions', () => {
      expect(canTransition('draft', 'pending_verification')).toBe(true);
      expect(canTransition('pending_verification', 'approved')).toBe(true);
      expect(canTransition('approved', 'funded')).toBe(true);
      expect(canTransition('funded', 'settled')).toBe(true);
      expect(canTransition('settled', 'closed')).toBe(true);
    });

    it('should deny invalid transitions (skipping states)', () => {
      expect(canTransition('draft', 'funded')).toBe(false);
      expect(canTransition('pending_verification', 'settled')).toBe(false);
      expect(canTransition('approved', 'closed')).toBe(false);
    });

    it('should deny backward transitions', () => {
      expect(canTransition('approved', 'draft')).toBe(false);
      expect(canTransition('settled', 'pending_verification')).toBe(false);
      expect(canTransition('closed', 'funded')).toBe(false);
    });

    it('should deny transitions from terminal states', () => {
      expect(canTransition('closed', 'draft')).toBe(false);
      expect(canTransition('closed', 'approved')).toBe(false);
    });

    it('should handle missing inputs safely', () => {
      expect(canTransition(null, 'approved')).toBe(false);
      expect(canTransition('draft', undefined)).toBe(false);
      expect(canTransition('', 'approved')).toBe(false);
      expect(canTransition('draft', '')).toBe(false);
    });
  });

  describe('validateStatusTransition()', () => {
    it('should return true for valid transitions', () => {
      expect(validateStatusTransition('draft', 'pending_verification')).toBe(true);
      expect(validateStatusTransition('approved', 'funded')).toBe(true);
    });

    it('should throw if currentStatus or nextStatus are missing', () => {
      expect(() => validateStatusTransition(null, 'approved'))
        .toThrow('Both currentStatus and nextStatus are required for transition validation');
      
      expect(() => validateStatusTransition('draft', undefined))
        .toThrow('Both currentStatus and nextStatus are required for transition validation');
    });

    it('should throw if currentStatus is invalid', () => {
      expect(() => validateStatusTransition('unknown', 'approved'))
        .toThrow('Invalid current status: unknown');
    });

    it('should throw if nextStatus is invalid', () => {
      expect(() => validateStatusTransition('draft', 'unknown'))
        .toThrow('Invalid next status: unknown');
    });

    it('should throw descriptive error for invalid transition', () => {
      expect(() => validateStatusTransition('draft', 'funded'))
        .toThrow('Invalid status transition from draft to funded');
    });
  });
});
