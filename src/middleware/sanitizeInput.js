const { sanitizeValue } = require('../utils/sanitization');

const QUERY_PARSER_SANITIZED = Symbol('liquifact.queryParserSanitized');

/**
 * Express middleware that sanitizes common user-supplied input containers.
 *
 * The middleware avoids shadowing framework-owned accessors such as Express 5's
 * getter-only `req.query`. Query values are sanitized by wrapping the app query
 * parser, while request-owned fields use guarded accessors so later framework
 * assignments are sanitized before handlers read them.
 *
 * @param {import('express').Request} req Express request.
 * @param {import('express').Response} _res Express response.
 * @param {import('express').NextFunction} next Express next callback.
 * @returns {void}
 */
function sanitizeInput(req, _res, next) {
  assignSanitizedValue(req, 'body');
  sanitizeQuery(req);
  installSanitizedAccessor(req, 'params');

  next();
}

/**
 * Sanitizes a request field by assigning a sanitized copy when possible.
 *
 * @param {object} req Express request or request-like object.
 * @param {string} field Field name.
 * @returns {void}
 */
function assignSanitizedValue(req, field) {
  const sanitizedValue = sanitizeValue(readRequestField(req, field));

  try {
    req[field] = sanitizedValue;
  } catch (_error) {
    defineSanitizedFallback(req, `sanitized${capitalize(field)}`, sanitizedValue);
  }
}

/**
 * Sanitizes query values without redefining Express 5's getter-only `req.query`.
 *
 * Express 5 reparses query strings through the app-level parser whenever
 * `req.query` is read. Wrapping that parser keeps downstream reads sanitized and
 * avoids installing an own `query` property on the request. Plain request-like
 * test doubles still receive a guarded accessor so reassignment stays sanitized.
 *
 * @param {import('express').Request|object} req Express request or test double.
 * @returns {void}
 */
function sanitizeQuery(req) {
  const descriptor = findPropertyDescriptor(req, 'query');

  if (isGetterOnlyPrototypeProperty(req, descriptor) && wrapExpressQueryParser(req)) {
    defineSanitizedFallback(req, 'sanitizedQuery', readRequestField(req, 'query'));
    return;
  }

  if (isGetterOnlyPrototypeProperty(req, descriptor)) {
    defineSanitizedFallback(req, 'sanitizedQuery', sanitizeValue(readRequestField(req, 'query')));
    return;
  }

  installSanitizedAccessor(req, 'query');
}

/**
 * Installs a guarded accessor for request-owned fields that can be reassigned
 * later by Express, such as `req.params` during route matching.
 *
 * @param {object} req Express request or request-like object.
 * @param {string} field Field name.
 * @returns {void}
 */
function installSanitizedAccessor(req, field) {
  let sanitizedValue = sanitizeValue(readRequestField(req, field));
  const descriptor = findPropertyDescriptor(req, field);

  if (descriptor && descriptor.configurable === false) {
    assignSanitizedValue(req, field);
    return;
  }

  try {
    Object.defineProperty(req, field, {
      configurable: true,
      enumerable: descriptor ? descriptor.enumerable : true,
      /**
       * Gets the sanitized request value.
       *
       * @returns {*} Sanitized value.
       */
      get() {
        return sanitizedValue;
      },
      /**
       * Re-sanitizes later assignments before downstream handlers read them.
       *
       * @param {*} value New request value.
       * @returns {void}
       */
      set(value) {
        sanitizedValue = sanitizeValue(value);
      },
    });
  } catch (_error) {
    assignSanitizedValue(req, field);
  }
}

/**
 * Wraps the Express app's query parser once so `req.query` stays sanitized
 * without replacing the getter on individual requests.
 *
 * @param {import('express').Request|object} req Express request or test double.
 * @returns {boolean} True when the parser was present or already wrapped.
 */
function wrapExpressQueryParser(req) {
  if (
    !req.app ||
    !req.app.locals ||
    typeof req.app.get !== 'function' ||
    typeof req.app.set !== 'function'
  ) {
    return false;
  }

  if (req.app.locals[QUERY_PARSER_SANITIZED]) {
    return true;
  }

  const queryParser = req.app.get('query parser fn');

  if (typeof queryParser !== 'function') {
    return false;
  }

  const sanitizedQueryParser = (queryString) => sanitizeValue(queryParser(queryString));
  req.app.set('query parser fn', sanitizedQueryParser);
  req.app.locals[QUERY_PARSER_SANITIZED] = true;

  return true;
}

/**
 * Reads a request field without letting getter-only framework properties abort
 * sanitization.
 *
 * @param {object} req Express request or request-like object.
 * @param {string} field Field name.
 * @returns {*} Field value, or undefined when the getter throws.
 */
function readRequestField(req, field) {
  try {
    return req[field];
  } catch (_error) {
    return undefined;
  }
}

/**
 * Finds the effective property descriptor for a request field.
 *
 * @param {object} target Request object.
 * @param {string} field Field name.
 * @returns {PropertyDescriptor|undefined} Property descriptor when present.
 */
function findPropertyDescriptor(target, field) {
  let current = target;

  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, field);

    if (descriptor) {
      return descriptor;
    }

    current = Object.getPrototypeOf(current);
  }

  return undefined;
}

/**
 * Detects framework getter-only properties inherited from the request prototype.
 *
 * @param {object} req Express request or request-like object.
 * @param {PropertyDescriptor|undefined} descriptor Effective descriptor.
 * @returns {boolean} True when the property is an inherited getter without setter.
 */
function isGetterOnlyPrototypeProperty(req, descriptor) {
  return Boolean(
    descriptor &&
      typeof descriptor.get === 'function' &&
      typeof descriptor.set !== 'function' &&
      !Object.prototype.hasOwnProperty.call(req, 'query')
  );
}

/**
 * Stores a sanitized fallback on a dedicated property when a framework-owned
 * field cannot be assigned safely.
 *
 * @param {object} req Express request or request-like object.
 * @param {string} field Fallback field name.
 * @param {*} value Sanitized value.
 * @returns {void}
 */
function defineSanitizedFallback(req, field, value) {
  try {
    Object.defineProperty(req, field, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: sanitizeValue(value),
    });
  } catch (_error) {
    // Some test doubles may be frozen. Fallback storage is best-effort only.
  }
}

/**
 * Capitalizes a field name for fallback-property construction.
 *
 * @param {string} value Field name.
 * @returns {string} Capitalized field name.
 */
function capitalize(value) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

module.exports = {
  sanitizeInput,
};
