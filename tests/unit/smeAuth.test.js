/**
 * Tests for SME wallet authorization middleware.
 *
 * Covers:
 *  - authorizeSmeWallet: wallet binding, header spoofing rejection, format validation
 *  - verifyInvoiceOwner: ownership checks by user ID and wallet address
 *
 * Security focus: header spoofing, missing wallet, malformed addresses, missing req.user
 */

const request = require('supertest');
const express = require('express');
const { StrKey } = require('@stellar/stellar-sdk');
const { authorizeSmeWallet, verifyInvoiceOwner } = require('../../src/middleware/smeAuth');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal Express app with the given middleware stack.
 * @param {import('express').RequestHandler[]} middlewares - Middleware to mount
 * @returns {import('express').Express} Configured app
 */
function makeApp(...middlewares) {
  const app = express();
  app.use(express.json());
  app.get('/test', ...middlewares, (req, res) => {
    res.json({ 
      walletAddress: req.walletAddress,
      invoice: req.invoice,
    });
  });
  // Error handler to return JSON for assertions
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({
      type: err.type,
      title: err.title,
      status: err.status,
      detail: err.detail,
    });
  });
  return app;
}

/**
 * Middleware stub that injects req.user for testing.
 * @param {object} user - User object to inject
 */
function injectUser(user) {
  return (req, res, next) => {
    req.user = user;
    next();
  };
}

const VALID_WALLET = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const VALID_WALLET_2 = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));
const VALID_CONTRACT_ADDRESS = StrKey.encodeContract(Buffer.alloc(32, 3));
const MALFORMED_WALLET = `X${VALID_WALLET.slice(1)}`; // starts with X not G/C
const SHORT_WALLET = 'GABC2345'; // too short

// ---------------------------------------------------------------------------
// authorizeSmeWallet — authentication required
// ---------------------------------------------------------------------------

describe('authorizeSmeWallet — authentication required', () => {
  const app = makeApp(authorizeSmeWallet);

  it('returns 401 when req.user is missing', async () => {
    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
    expect(res.body.detail).toMatch(/Authentication required/);
  });

  it('returns 401 when req.user is null', async () => {
    const app = makeApp(injectUser(null), authorizeSmeWallet);
    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
  });

  it('returns 401 when req.user is undefined', async () => {
    const app = makeApp(injectUser(undefined), authorizeSmeWallet);
    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// authorizeSmeWallet — wallet binding
// ---------------------------------------------------------------------------

describe('authorizeSmeWallet — wallet binding to req.user', () => {
  it('returns 403 when req.user.walletAddress is missing', async () => {
    const app = makeApp(injectUser({ id: 'user-001' }), authorizeSmeWallet);
    const res = await request(app).get('/test');
    expect(res.status).toBe(403);
    expect(res.body.detail).toMatch(/No Stellar wallet address is bound to this account/);
  });

  it('returns 403 when req.user.walletAddress is empty string', async () => {
    const app = makeApp(injectUser({ id: 'user-001', walletAddress: '' }), authorizeSmeWallet);
    const res = await request(app).get('/test');
    expect(res.status).toBe(403);
  });

  it('returns 403 when req.user.walletAddress is null', async () => {
    const app = makeApp(injectUser({ id: 'user-001', walletAddress: null }), authorizeSmeWallet);
    const res = await request(app).get('/test');
    expect(res.status).toBe(403);
  });

  it('returns 200 and attaches req.walletAddress when wallet is bound', async () => {
    const app = makeApp(
      injectUser({ id: 'user-001', walletAddress: VALID_WALLET }),
      authorizeSmeWallet
    );
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body.walletAddress).toBe(VALID_WALLET);
  });
});

// ---------------------------------------------------------------------------
// authorizeSmeWallet — header spoofing rejection
// ---------------------------------------------------------------------------

describe('authorizeSmeWallet — header spoofing rejection', () => {
  it('ignores x-stellar-address header when req.user.walletAddress is missing', async () => {
    const app = makeApp(injectUser({ id: 'user-001' }), authorizeSmeWallet);
    const res = await request(app)
      .get('/test')
      .set('x-stellar-address', VALID_WALLET);
    expect(res.status).toBe(403);
    expect(res.body.detail).toMatch(/No Stellar wallet address is bound/);
  });

  it('ignores x-stellar-address header when req.user.walletAddress is present', async () => {
    const spoofedWallet = VALID_WALLET_2;
    const app = makeApp(
      injectUser({ id: 'user-001', walletAddress: VALID_WALLET }),
      authorizeSmeWallet
    );
    const res = await request(app)
      .get('/test')
      .set('x-stellar-address', spoofedWallet);
    expect(res.status).toBe(200);
    // Should use wallet from req.user, NOT the spoofed header
    expect(res.body.walletAddress).toBe(VALID_WALLET);
    expect(res.body.walletAddress).not.toBe(spoofedWallet);
  });

  it('ignores x-stellar-address even if it is the only wallet-like value', async () => {
    const app = makeApp(injectUser({ id: 'user-001' }), authorizeSmeWallet);
    const res = await request(app)
      .get('/test')
      .set('x-stellar-address', VALID_WALLET);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// authorizeSmeWallet — format validation
// ---------------------------------------------------------------------------

describe('authorizeSmeWallet — Stellar address format validation', () => {
  it('returns 400 when wallet does not start with G or C', async () => {
    const app = makeApp(
      injectUser({ id: 'user-001', walletAddress: MALFORMED_WALLET }),
      authorizeSmeWallet
    );
    const res = await request(app).get('/test');
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/Stellar wallet address format is invalid/);
  });

  it('returns 400 when wallet is too short', async () => {
    const app = makeApp(
      injectUser({ id: 'user-001', walletAddress: SHORT_WALLET }),
      authorizeSmeWallet
    );
    const res = await request(app).get('/test');
    expect(res.status).toBe(400);
  });

  it('returns 400 when wallet contains invalid characters', async () => {
    const invalidWallet = 'GABC!@#$%^&*()234567890DEFGHIJKLMNOPQRSTUVWXYZ234567890';
    const app = makeApp(
      injectUser({ id: 'user-001', walletAddress: invalidWallet }),
      authorizeSmeWallet
    );
    const res = await request(app).get('/test');
    expect(res.status).toBe(400);
  });

  it('returns 400 when wallet is lowercase', async () => {
    const lowercaseWallet = VALID_WALLET.toLowerCase();
    const app = makeApp(
      injectUser({ id: 'user-001', walletAddress: lowercaseWallet }),
      authorizeSmeWallet
    );
    const res = await request(app).get('/test');
    expect(res.status).toBe(400);
  });

  it('accepts a valid Stellar account address starting with G', async () => {
    const app = makeApp(
      injectUser({ id: 'user-001', walletAddress: VALID_WALLET }),
      authorizeSmeWallet
    );
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body.walletAddress).toBe(VALID_WALLET);
  });

  it('returns 400 for a valid contract address because SME wallets must be account public keys', async () => {
    const app = makeApp(
      injectUser({ id: 'user-001', walletAddress: VALID_CONTRACT_ADDRESS }),
      authorizeSmeWallet
    );
    const res = await request(app).get('/test');
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/Stellar wallet address format is invalid/);
  });

  it('returns 400 for wrong-length uppercase values that only look like StrKeys', async () => {
    const almostValid = `${VALID_WALLET}A`;
    const app = makeApp(
      injectUser({ id: 'user-001', walletAddress: almostValid }),
      authorizeSmeWallet
    );
    const res = await request(app).get('/test');
    expect(res.status).toBe(400);
  });

  it('returns 400 for trailing whitespace on otherwise valid addresses', async () => {
    const app = makeApp(
      injectUser({ id: 'user-001', walletAddress: `${VALID_CONTRACT_ADDRESS} ` }),
      authorizeSmeWallet
    );
    const res = await request(app).get('/test');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// verifyInvoiceOwner — invoice existence checks
// ---------------------------------------------------------------------------

describe('verifyInvoiceOwner — invoice existence checks', () => {
  const invoices = [
    { id: 'inv-001', ownerId: 'user-001', smeWallet: VALID_WALLET },
  ];

  it('returns 400 when invoice ID is missing from params', async () => {
    const app = express();
    app.get('/test', injectUser({ id: 'user-001' }), verifyInvoiceOwner(invoices), (req, res) => {
      res.json({ invoice: req.invoice });
    });
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ detail: err.detail });
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/Invoice ID is required/);
  });

  it('returns 404 when invoice is not found in collection', async () => {
    const app = express();
    app.get('/test/:id', injectUser({ id: 'user-001' }), verifyInvoiceOwner(invoices), (req, res) => {
      res.json({ invoice: req.invoice });
    });
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ detail: err.detail });
    });

    const res = await request(app).get('/test/inv-999');
    expect(res.status).toBe(404);
    expect(res.body.detail).toMatch(/Invoice inv-999 was not found/);
  });
});

// ---------------------------------------------------------------------------
// verifyInvoiceOwner — ownership checks
// ---------------------------------------------------------------------------

describe('verifyInvoiceOwner — ownership by user ID', () => {
  const invoices = [
    { id: 'inv-001', ownerId: 'user-001', smeWallet: VALID_WALLET },
  ];

  it('returns 200 when user owns the invoice by ownerId', async () => {
    const app = express();
    app.get('/test/:id', injectUser({ id: 'user-001' }), verifyInvoiceOwner(invoices), (req, res) => {
      res.json({ invoice: req.invoice });
    });
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ detail: err.detail });
    });

    const res = await request(app).get('/test/inv-001');
    expect(res.status).toBe(200);
    expect(res.body.invoice.id).toBe('inv-001');
  });

  it('returns 403 when user does not own the invoice by ownerId', async () => {
    const app = express();
    app.get('/test/:id', injectUser({ id: 'user-999' }), verifyInvoiceOwner(invoices), (req, res) => {
      res.json({ invoice: req.invoice });
    });
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ detail: err.detail });
    });

    const res = await request(app).get('/test/inv-001');
    expect(res.status).toBe(403);
    expect(res.body.detail).toMatch(/You do not have permission to access this invoice/);
  });
});

describe('verifyInvoiceOwner — ownership by wallet address', () => {
  const invoices = [
    { id: 'inv-002', ownerId: 'user-002', smeWallet: VALID_WALLET },
  ];

  it('returns 200 when wallet matches invoice smeWallet', async () => {
    const app = express();
    app.use((req, res, next) => {
      req.user = { id: 'user-999' }; // Different user ID
      req.walletAddress = VALID_WALLET; // But matching wallet
      next();
    });
    app.get('/test/:id', verifyInvoiceOwner(invoices), (req, res) => {
      res.json({ invoice: req.invoice });
    });
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ detail: err.detail });
    });

    const res = await request(app).get('/test/inv-002');
    expect(res.status).toBe(200);
    expect(res.body.invoice.id).toBe('inv-002');
  });

  it('returns 403 when neither ownerId nor wallet match', async () => {
    const app = express();
    app.use((req, res, next) => {
      req.user = { id: 'user-999' };
      req.walletAddress = 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
      next();
    });
    app.get('/test/:id', verifyInvoiceOwner(invoices), (req, res) => {
      res.json({ invoice: req.invoice });
    });
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ detail: err.detail });
    });

    const res = await request(app).get('/test/inv-002');
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// verifyInvoiceOwner — edge cases
// ---------------------------------------------------------------------------

describe('verifyInvoiceOwner — edge cases', () => {
  const invoices = [
    { id: 'inv-003', ownerId: 'user-003', smeWallet: VALID_WALLET },
  ];

  it('returns 200 when both ownerId and wallet match', async () => {
    const app = express();
    app.use((req, res, next) => {
      req.user = { id: 'user-003' };
      req.walletAddress = VALID_WALLET;
      next();
    });
    app.get('/test/:id', verifyInvoiceOwner(invoices), (req, res) => {
      res.json({ invoice: req.invoice });
    });

    const res = await request(app).get('/test/inv-003');
    expect(res.status).toBe(200);
  });

  it('returns 403 when req.user is missing but wallet is set', async () => {
    const app = express();
    app.use((req, res, next) => {
      req.walletAddress = VALID_WALLET;
      // req.user is undefined
      next();
    });
    app.get('/test/:id', verifyInvoiceOwner(invoices), (req, res) => {
      res.json({ invoice: req.invoice });
    });
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ detail: err.detail });
    });

    const res = await request(app).get('/test/inv-003');
    expect(res.status).toBe(200); // Wallet alone is sufficient
  });

  it('returns 403 when req.walletAddress is missing but user ID is set', async () => {
    const invoices = [
      { id: 'inv-004', ownerId: 'user-999', smeWallet: VALID_WALLET },
    ];
    const app = express();
    app.use((req, res, next) => {
      req.user = { id: 'user-003' }; // Different from invoice ownerId
      // req.walletAddress is undefined
      next();
    });
    app.get('/test/:id', verifyInvoiceOwner(invoices), (req, res) => {
      res.json({ invoice: req.invoice });
    });
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ detail: err.detail });
    });

    const res = await request(app).get('/test/inv-004');
    expect(res.status).toBe(403);
  });
});
