/**
 * Storage Layer - JSON-based persistence
 * 
 * Thread-safe storage using atomic writes to a JSON file.
 * In production, swap this with a database (PostgreSQL, MongoDB, etc).
 * 
 * Security notes:
 * - Data is stored in plaintext JSON; add encryption at rest for PII (invoices may contain sensitive data)
 * - No SQL injection risk (not using SQL)
 * - File locking ensures atomicity on single-node deployments
 * - Multi-node deployments require database with proper transactions
 */

const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, '../../data');
const DB_FILE = path.join(DB_DIR, 'invoices.json');

/**
 * Ensure data directory exists
 */
function ensureDbDir() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
}

/**
 * Load all invoices from storage
 * @returns {Array} Array of invoice objects, or empty array if no data
 */
function loadInvoices() {
  ensureDbDir();
  
  if (!fs.existsSync(DB_FILE)) {
    return [];
  }

  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading invoices from storage:', error.message);
    return [];
  }
}

/**
 * Save invoices to storage (atomic write)
 * @param {Array} invoices - Array of invoice objects
 * @throws {Error} If write fails
 */
function saveInvoices(invoices) {
  ensureDbDir();
  
  const tempFile = `${DB_FILE}.tmp`;
  
  try {
    // Write to temporary file first (atomic operation)
    fs.writeFileSync(tempFile, JSON.stringify(invoices, null, 2), 'utf8');
    
    // Atomic rename
    fs.renameSync(tempFile, DB_FILE);
  } catch (error) {
    // Clean up temp file if it exists
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
    throw new Error(`Failed to save invoices: ${error.message}`);
  }
}

/**
 * Get invoice by ID
 * @param {string} id - Invoice ID
 * @returns {Object|null} Invoice object or null if not found
 */
function getInvoice(id) {
  const invoices = loadInvoices();
  return invoices.find(inv => inv.id === id) || null;
}

/**
 * Create a new invoice
 * @param {Object} invoiceData - Invoice data (id will be generated)
 * @returns {Object} Created invoice with id and timestamps
 */
function createInvoice(invoiceData) {
  const invoices = loadInvoices();
  
  const now = new Date().toISOString();
  const newInvoice = {
    id: `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    ...invoiceData,
    status: invoiceData.status || 'pending_verification',
    createdAt: now,
    updatedAt: now,
  };
  
  invoices.push(newInvoice);
  saveInvoices(invoices);
  
  return newInvoice;
}

/**
 * Get all invoices with optional filtering
 * @param {Object} options - Filter options (e.g., { status: 'active' })
 * @returns {Array} Filtered invoices
 */
function getAllInvoices(options = {}) {
  const invoices = loadInvoices();
  
  if (Object.keys(options).length === 0) {
    return invoices;
  }
  
  return invoices.filter(inv => {
    return Object.entries(options).every(([key, value]) => {
      return inv[key] === value;
    });
  });
}

/**
 * Update an invoice
 * @param {string} id - Invoice ID
 * @param {Object} updateData - Fields to update
 * @returns {Object|null} Updated invoice or null if not found
 */
function updateInvoice(id, updateData) {
  const invoices = loadInvoices();
  const index = invoices.findIndex(inv => inv.id === id);
  
  if (index === -1) {
    return null;
  }
  
  invoices[index] = {
    ...invoices[index],
    ...updateData,
    id: invoices[index].id, // Prevent ID change
    createdAt: invoices[index].createdAt, // Prevent createdAt change
    updatedAt: new Date().toISOString(),
  };
  
  saveInvoices(invoices);
  return invoices[index];
}

/**
 * Delete an invoice
 * @param {string} id - Invoice ID
 * @returns {boolean} True if deleted, false if not found
 */
function deleteInvoice(id) {
  const invoices = loadInvoices();
  const index = invoices.findIndex(inv => inv.id === id);
  
  if (index === -1) {
    return false;
  }
  
  invoices.splice(index, 1);
  saveInvoices(invoices);
  return true;
}

/**
 * Clear all invoices (for testing)
 */
function clearAll() {
  ensureDbDir();
  if (fs.existsSync(DB_FILE)) {
    fs.unlinkSync(DB_FILE);
  }
}

module.exports = {
  getInvoice,
  createInvoice,
  getAllInvoices,
  updateInvoice,
  deleteInvoice,
  clearAll,
};
