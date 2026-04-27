#!/usr/bin/env node

/**
 * Quick fix for critical linting issues to unblock CI/CD
 */

const fs = require('fs').promises;
const path = require('path');

async function fixLinting() {
  console.log('🔧 Fixing critical linting issues...\n');
  
  // 1. Fix missing JSDoc in escrowRead.js (our main file)
  try {
    const escrowReadPath = './src/services/escrowRead.js';
    let content = await fs.readFile(escrowReadPath, 'utf8');
    
    // Add proper JSDoc to our new functions
    content = content.replace(
      '/**\n * Fetches the funding close snapshot from the Soroban contract.',
      '/**\n * Fetches the funding close snapshot from the Soroban contract.\n * @param {string} invoiceId - Validated invoice identifier.\n * @param {Function} [adapter] - Optional async function for testing.\n * @returns {Promise<FundingCloseSnapshot | null>} Funding close snapshot data or null.\n */'
    );
    
    await fs.writeFile(escrowReadPath, content);
    console.log('✅ Fixed JSDoc in escrowRead.js');
  } catch (error) {
    console.log('⚠️  Could not fix escrowRead.js JSDoc:', error.message);
  }
  
  // 2. Fix curly brace issues in index.js
  try {
    const indexPath = './src/index.js';
    let content = await fs.readFile(indexPath, 'utf8');
    
    // Fix missing braces
    content = content.replace(
      'if (error.code === \'INVALID_INVOICE_ID\')',
      'if (error.code === \'INVALID_INVOICE_ID\') {'
    );
    
    content = content.replace(
      'return res.status(400).json',
      '  return res.status(400).json'
    );
    
    await fs.writeFile(indexPath, content);
    console.log('✅ Fixed curly brace issues in index.js');
  } catch (error) {
    console.log('⚠️  Could not fix index.js braces:', error.message);
  }
  
  console.log('\n🎯 Critical linting fixes applied. Run \'npm run lint\' to check remaining issues.');
}

fixLinting().catch(console.error);