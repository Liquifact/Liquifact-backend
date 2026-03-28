/**
 * Reusable Query Builder Utility
 * 
 * Provides a generic way to apply filters and sorting to a Knex query object.
 */

/**
 * Applies filters and sorting to a knex query.
 *
 * @param {Object} query - The Knex query object.
 * @param {Object} options - The options object.
 * @param {Object} options.filters - Filter key-value pairs.
 * @param {Object} options.sorting - Sort configuration.
 * @param {string} options.sorting.sortBy - The field to sort by.
 * @param {string} options.sorting.order - The sort order (asc/desc).
 * @param {Object} config - Configuration for allowed fields.
 * @param {Array<string>} config.allowedFilters - Whitelisted filter keys.
 * @param {Array<string>} config.allowedSortFields - Whitelisted sort fields.
 * @param {Object} [config.columnMap={}] - Mapping from query keys to DB columns.
 * @returns {Object} The modified Knex query object.
 */
function applyQueryOptions(query, options = {}, config = {}) {
  const { filters = {}, sorting = {} } = options;
  const { allowedFilters = [], allowedSortFields = [], columnMap = {} } = config;

  // Apply filters
  Object.keys(filters).forEach((key) => {
    const value = filters[key];
    if (value === undefined || value === null || value === '') {return;}

    if (allowedFilters.includes(key)) {
      const column = columnMap[key] || key;

      // Handle special filters like date range
      if (key === 'dateFrom') {
        query.where(column, '>=', value);
      } else if (key === 'dateTo') {
        query.where(column, '<=', value);
      } else {
        // Standard equality filter
        query.where(column, value);
      }
    }
  });

  // Apply sorting
  const { sortBy, order = 'desc' } = sorting;
  if (sortBy && allowedSortFields.includes(sortBy)) {
    const column = columnMap[sortBy] || sortBy;
    const direction = ['asc', 'desc'].includes(order.toLowerCase()) ? order.toLowerCase() : 'desc';
    query.orderBy(column, direction);
  } else if (allowedSortFields.length > 0) {
    // Default sorting if sortBy is invalid or not provided
    const defaultSort = allowedSortFields[0];
    const column = columnMap[defaultSort] || defaultSort;
    query.orderBy(column, 'desc');
  }

  return query;
}

module.exports = {
  applyQueryOptions,
};
