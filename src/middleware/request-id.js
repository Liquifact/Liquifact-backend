'use strict';

const crypto = require('crypto');

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  next();
}

module.exports = requestId;
