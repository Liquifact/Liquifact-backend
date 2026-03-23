const express = require('express');
const router = express.Router();
const roleGuard = require('../middleware/roleGuard');
const RBAC_POLICY = require('../policies/rbacPolicy');

// Placeholder: Escrow (to be wired to Soroban)
router.get('/:invoiceId', roleGuard(RBAC_POLICY.ESCROW_READ), (req, res) => {
  const { invoiceId } = req.params;
  res.json({
    data: { invoiceId, status: 'not_found', fundedAmount: 0 },
    message: 'Escrow state will be read from Soroban contract.',
  });
});

module.exports = router;
