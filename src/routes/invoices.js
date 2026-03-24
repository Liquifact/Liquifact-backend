const express = require('express');
const router = express.Router();
const roleGuard = require('../middleware/roleGuard');
const RBAC_POLICY = require('../policies/rbacPolicy');

// Placeholder: Invoices (to be wired to Invoice Service + DB)
router.get('/', roleGuard(RBAC_POLICY.VIEW_INVOICES), (req, res) => {
  res.json({
    data: [],
    message: 'Invoice service will list tokenized invoices here.',
  });
});

router.post('/', roleGuard(RBAC_POLICY.CREATE_INVOICE), (req, res) => {
  res.status(201).json({
    data: { id: 'placeholder', status: 'pending_verification' },
    message: 'Invoice upload will be implemented with verification and tokenization.',
  });
});

router.post('/:id/approve', roleGuard(RBAC_POLICY.APPROVE_INVOICE), (req, res) => {
  res.json({
    data: { id: req.params.id, status: 'approved' },
    message: 'Invoice approval workflow will be implemented.',
  });
});

module.exports = router;
