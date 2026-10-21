'use strict';

/**
 * Demo invoice seed shared by the memory repository and Postgres seeds.
 * fundedAmount must match contributions seed sums for each id.
 *
 * @returns {object[]} seed invoice records
 */
function demoInvoices() {
  return [
    {
      id: 'INV_0001',
      sme: 'Acme Components Ltd',
      smeAddress: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5',
      debtor: 'Globex Retail',
      amount: 100,
      currency: 'XLM',
      fundedAmount: 0,
      yieldBps: 800,
      dueDate: '2027-01-17',
      status: 'open',
      onChain: true,
      createdAt: '2026-10-19T00:00:00.000Z',
    },
    {
      id: 'INV_0002',
      sme: 'Northwind Textiles',
      smeAddress: 'GBNORTHWINDDEMOADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      debtor: 'Initech Wholesale',
      amount: 25000,
      currency: 'USDC',
      fundedAmount: 18000,
      yieldBps: 650,
      dueDate: '2026-12-30',
      status: 'open',
      onChain: false,
      createdAt: '2026-10-02T09:30:00.000Z',
    },
    {
      id: 'INV_0003',
      sme: 'Blue Harbor Logistics',
      smeAddress: 'GBBLUEHARBORDEMOADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      debtor: 'Umbrella Foods',
      amount: 42000,
      currency: 'USDC',
      fundedAmount: 42000,
      yieldBps: 720,
      dueDate: '2026-11-28',
      status: 'funded',
      onChain: false,
      createdAt: '2026-09-15T14:00:00.000Z',
    },
    {
      id: 'INV_0004',
      sme: 'Sunrise Agritech',
      smeAddress: 'GBSUNRISEDEMOADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      debtor: 'Stark Industries',
      amount: 12500,
      currency: 'USDC',
      fundedAmount: 12500,
      yieldBps: 900,
      dueDate: '2026-09-30',
      status: 'settled',
      onChain: false,
      createdAt: '2026-07-01T08:00:00.000Z',
    },
  ];
}

module.exports = { demoInvoices };
