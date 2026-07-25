'use strict';

const {
  CommitmentValidationError,
} = require('../src/services/investorCommitment');
const { submitFundEscrow } = require('../src/services/escrowSubmit');

describe('submitFundEscrow amountStroops validation', () => {
  const baseParams = {
    escrowAddress: 'CDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK',
    investorAddress: 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK',
    invoiceId: 'inv-001',
  };

  it('rejects numeric amountStroops before any signing-mode branch', async () => {
    await expect(
      submitFundEscrow({ ...baseParams, amountStroops: 1000 }),
    ).rejects.toThrow(CommitmentValidationError);
  });

  it('accepts a strict decimal string in stubbed mode', async () => {
    const result = await submitFundEscrow({ ...baseParams, amountStroops: '1000' });

    expect(result).toMatchObject({
      status: 'stubbed',
      escrowAddress: baseParams.escrowAddress,
    });
  });
});
