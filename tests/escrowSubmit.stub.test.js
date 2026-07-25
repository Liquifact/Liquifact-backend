// jest.mock('../src/metrics', ()=> ({}));
// jest.mock('../src/cache/redis', ()=> ({
//   createdRedisEscrowSummaryCache: ()=> ({})
// }));
'use strict';

const jwt = require('jsonwebtoken');
const request = require('supertest');

const { createApp } = require('../src/index');
const {
  SIGNING_MODES,
  SUBMISSION_STATUSES,
  resolveSigningConfig,
  submitEscrowFunding,
  buildMemo,
  EscrowSubmitError
} = require('../src/services/escrowSubmit');
const { simulateOrThrowSync } = require('../src/services/sorobanSim');

const PUBLIC_KEY = `G${'A'.repeat(55)}`;
const CONTRACT_ID = `C${'A'.repeat(55)}`;
const NOW = new Date('2026-04-25T12:00:00.000Z');

function basePayload(overrides = {}) {
  return {
    invoiceId: 'inv_123',
    funderPublicKey: PUBLIC_KEY,
    amount: '100.0000000',
    asset: { code: 'XLM' },
    memo: 'inv_123',
    ...overrides,
  };
}

function networkEnv(overrides = {}) {
  return {
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    LIQUIFACT_ESCROW_CONTRACT_ID: CONTRACT_ID,
    ...overrides,
  };
}

function authHeader() {
  const token = jwt.sign({ id: 'user_123', role: 'user' }, process.env.JWT_SECRET || 'test-secret');
  return { Authorization: `Bearer ${token}` };
}

describe('escrowSubmit design stub', () => {
  it('prepares a delegated funding intent without signing or submitting', async () => {
    const result = await submitEscrowFunding(basePayload({
      idempotencyKey: 'fund-inv-123',
      clientReference: 'client-ref-123',
      metadata: { source: 'unit-test' },
    }), {
      env: {},
      now: NOW,
      userId: 'user_123',
    });

    expect(result.status).toBe(SUBMISSION_STATUSES.REQUIRES_SIGNATURE);
    expect(result.submitted).toBe(false);
    expect(result.signingMode).toBe(SIGNING_MODES.DELEGATED);
    expect(result.controls.liveSubmissionEnabled).toBe(false);
    expect(result.transaction).toEqual({
      unsignedXdr: null,
      signedXdrAccepted: false,
      hash: null,
    });
    expect(result.simulation).toEqual({
      simulated: false,
      simulationStatus: null,
    });
    expect(result.intent).toMatchObject({
      operation: 'fund_escrow',
      invoiceId: 'inv_123',
      funderPublicKey: PUBLIC_KEY,
      amount: '100.0000000',
      asset: { code: 'XLM', issuer: null, type: 'native' },
      idempotencyKey: 'fund-inv-123',
      clientReference: 'client-ref-123',
      metadata: { source: 'unit-test' },
      requestedAt: '2026-04-25T12:00:00.000Z',
      requestedBy: 'user_123',
    });
  });

  it('accepts fundedAmount and idempotency header aliases for the gateway stub', async () => {
    const result = await submitEscrowFunding(basePayload({
      amount: undefined,
      fundedAmount: 25,
      idempotencyKey: undefined,
    }), {
      env: {},
      idempotencyKey: 'header-key-0001',
      now: NOW,
    });

    expect(result.intent.amount).toBe('25');
    expect(result.intent.idempotencyKey).toBe('header-key-0001');
    expect(result.status).toBe(SUBMISSION_STATUSES.REQUIRES_SIGNATURE);
    expect(result.simulation).toEqual({
      simulated: false,
      simulationStatus: null,
    });
  });

  it('returns requires_configuration for custodial mode without KMS and network env', async () => {
    const result = await submitEscrowFunding(basePayload({
      signingMode: 'custodial',
      asset: { code: 'USDC', issuer: PUBLIC_KEY },
    }), {
      env: { ESCROW_SIGNING_MODE: 'custodial' },
      now: NOW,
    });

    expect(result.status).toBe(SUBMISSION_STATUSES.REQUIRES_CONFIGURATION);
    expect(result.signingMode).toBe(SIGNING_MODES.CUSTODIAL);
    expect(result.controls.custodialSigningReady).toBe(false);
    expect(result.controls.custodialKeyConfigured).toBe(false);
    expect(result.simulation).toEqual({
      simulated: false,
      simulationStatus: null,
    });
  });

  it('accepts delegated signed XDR only as a non-submitted design stub', async () => {
    const result = await submitEscrowFunding(basePayload({
      signingMode: 'delegated',
      signedTransactionXdr: 'AAAA',
    }), {
      env: networkEnv(),
      now: NOW,
    });

    expect(result.status).toBe(SUBMISSION_STATUSES.STUBBED);
    expect(result.submitted).toBe(false);
    expect(result.transaction.signedXdrAccepted).toBe(true);
    expect(result.controls.delegatedSubmissionReady).toBe(true);
    expect(result.simulation).toEqual({
      simulated: true,
      simulationStatus: expect.any(String),
    });
  });

  it('requires network configuration before accepting delegated signed XDR for submission', async () => {
    const result = await submitEscrowFunding(basePayload({
      signedTransactionXdr: 'AAAA',
    }), {
      env: {},
      now: NOW,
    });

    expect(result.status).toBe(SUBMISSION_STATUSES.REQUIRES_CONFIGURATION);
    expect(result.nextAction).toBe('configure_soroban_network_before_accepting_signed_xdr');
    expect(result.simulation).toEqual({
      simulated: false,
      simulationStatus: null,
    });
  });

  it('does not expose custodial key identifiers when custodial env is configured', async () => {
    const result = await submitEscrowFunding(basePayload({
      signingMode: 'custodial',
    }), {
      env: networkEnv({
        ESCROW_CUSTODIAL_SIGNING_ENABLED: 'true',
        ESCROW_CUSTODIAL_KMS_PROVIDER: 'aws-kms',
        ESCROW_CUSTODIAL_KEY_ID: 'liquifact/escrow/fund/v1',
      }),
      now: NOW,
    });

    expect(result.status).toBe(SUBMISSION_STATUSES.STUBBED);
    expect(result.controls.custodialSigningReady).toBe(true);
    expect(JSON.stringify(result)).not.toContain('liquifact/escrow/fund/v1');
    expect(result.simulation).toEqual({
      simulated: false,
      simulationStatus: null,
    });
  });

  it('rejects invalid funding payloads with collected validation details', async () => {
    await expect(submitEscrowFunding({
      invoiceId: '$bad',
      funderPublicKey: 'bad-key',
      amount: '0.00000000',
      asset: { code: 'USDC' },
      signingMode: 'offline',
      idempotencyKey: 'bad key',
      memo: 'x'.repeat(65),
      metadata: 'not-an-object',
      signedTransactionXdr: '*',
      clientReference: 'short',
    }, {
      env: {},
      now: NOW,
    })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      detail: expect.stringContaining('invoiceId contains unsupported characters.'),
    });
  });

  it('rejects non-object payloads and oversize metadata', async () => {
    await expect(submitEscrowFunding(null, { env: {}, now: NOW })).rejects.toMatchObject({
      status: 400,
      detail: 'Escrow funding payload must be a JSON object.',
    });

    await expect(submitEscrowFunding(basePayload({
      invoiceId: undefined,
      amount: '0',
      asset: { code: 'TOO-LONG-ASSET-CODE' },
    }), {
      env: {},
      now: NOW,
    })).rejects.toMatchObject({
      status: 400,
      detail: expect.stringContaining('invoiceId is required.'),
    });

    await expect(submitEscrowFunding(basePayload({
      asset: { code: 'XLM', issuer: PUBLIC_KEY },
    }), {
      env: {},
      now: NOW,
    })).rejects.toMatchObject({
      status: 400,
      detail: 'asset.issuer must be omitted for native XLM.',
    });

    await expect(submitEscrowFunding(basePayload({
      metadata: { big: 'x'.repeat(2050) },
    }), {
      env: {},
      now: NOW,
    })).rejects.toMatchObject({
      status: 400,
      detail: expect.stringContaining('metadata must be 2048 bytes or fewer.'),
    });
  });

  it('fails closed on invalid signing environment values', () => {
    expect(resolveSigningConfig({ ESCROW_SIGNING_MODE: 'custodial' }).mode).toBe(
      SIGNING_MODES.CUSTODIAL,
    );
    expect(() => resolveSigningConfig({ ESCROW_SIGNING_MODE: 'server' })).toThrow(
      'Escrow Signing Configuration Error',
    );
    expect(() => resolveSigningConfig({ SOROBAN_RPC_URL: 'ftp://example.test' })).toThrow(
      'Escrow Signing Configuration Error',
    );
    expect(() => resolveSigningConfig({ LIQUIFACT_ESCROW_CONTRACT_ID: 'bad-contract' })).toThrow(
      'Escrow Signing Configuration Error',
    );
  });
});

describe('POST /api/escrow funding stub', () => {
  it('returns a 202 no-submit funding intent for authenticated callers', async () => {
    const response = await request(createApp())
      .post('/api/escrow')
      .set(authHeader())
      .set('Idempotency-Key', 'fund-inv-123')
      .send(basePayload());

    expect(response.status).toBe(202);
    expect(response.body.message).toBe(
      'Escrow funding transaction prepared; no live transaction was signed or submitted.',
    );
    expect(response.body.data).toMatchObject({
      status: SUBMISSION_STATUSES.REQUIRES_SIGNATURE,
      submitted: false,
      signingMode: SIGNING_MODES.DELEGATED,
      controls: {
        liveSubmissionEnabled: false,
      },
      simulation: {
        simulated: false,
        simulationStatus: null,
      },
      intent: {
        invoiceId: 'inv_123',
        idempotencyKey: '***REDACTED***',
      },
    });
  });

  it('returns structured validation errors for invalid funding requests', async () => {
    const response = await request(createApp())
      .post('/api/escrow')
      .set(authHeader())
      .send({ invoiceId: '$' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      retryable: false,
      retry_hint: 'Fix the escrow funding payload and try again.',
    });
    expect(response.body.error.message).toContain('invoiceId contains unsupported characters.');
  });
});

describe('buildMemo', () => {
 // const { buildMemo, EscrowSubmitError } = require('../src/services/escrowSubmit');

  it('should return memo when invoice ID fits within 28 bytes', () => {
    const result = buildMemo('INV-001');
    expect(result).toEqual({ type: 'text', value: 'lq:INV-001' });
  });

  it('should pass when memo is exactly 28 bytes', () => {
    const exactId = 'A'.repeat(25); // 'lq:' (3) + 25 = 28 bytes
    const result = buildMemo(exactId);
    expect(result.value).toBe(`lq:${exactId}`);
  });

  it('should throw when memo is one byte over the limit', () => {
    const longId = 'A'.repeat(26); // 'lq:' (3) + 26 = 29 bytes
    expect(() => buildMemo(longId)).toThrow(EscrowSubmitError);
  });

  it('should throw when invoice ID is far over the limit', () => {
    const veryLongId = 'A'.repeat(100);
    expect(() => buildMemo(veryLongId)).toThrow('truncation detected');
  });
});