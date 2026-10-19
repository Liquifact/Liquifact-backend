'use strict';

exports.up = async (knex) => {
  await knex.raw(`
    CREATE TABLE invoices (
      id            text PRIMARY KEY,
      sme           text NOT NULL,
      sme_address   text NULL,
      debtor        text NOT NULL,
      amount        numeric(38,7) NOT NULL CHECK (amount > 0),
      funded_amount numeric(38,7) NOT NULL DEFAULT 0
                    CHECK (funded_amount >= 0 AND funded_amount <= amount),
      currency      varchar(12),
      yield_bps     int CHECK (yield_bps BETWEEN 0 AND 10000),
      due_date      date,
      status        text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'funded', 'settled', 'cancelled')),
      on_chain      boolean NOT NULL DEFAULT false,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz
    )
  `);
  await knex.raw('CREATE INDEX invoices_status_created_at_idx ON invoices (status, created_at)');
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE IF EXISTS invoices');
};
