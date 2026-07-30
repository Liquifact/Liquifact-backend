'use strict';

const fs = require('fs');
const path = require('path');

describe('Migration Utilities', () => {
  describe('Migration File Validation', () => {
    test('should validate migration file naming convention', () => {
      const migrationsDir = path.join(__dirname, '../../migrations');
      
      if (!fs.existsSync(migrationsDir)) {
        console.log('Migrations directory not found, skipping test');
        return;
      }
      
      const migrationFiles = fs.readdirSync(migrationsDir)
        .filter(file => file.endsWith('.sql'));
      
      const namingPattern = /^\d{12,14}_[a-z0-9_]+\.sql$/;
      
      for (const file of migrationFiles) {
        expect(file).toMatch(namingPattern);
      }
    });
    
    test('should validate migration file content structure', () => {
      const migrationsDir = path.join(__dirname, '../../migrations');
      
      if (!fs.existsSync(migrationsDir)) {
        console.log('Migrations directory not found, skipping test');
        return;
      }
      
      const migrationFiles = fs.readdirSync(migrationsDir)
        .filter(file => file.endsWith('.sql'));
      
      for (const file of migrationFiles) {
        const filePath = path.join(migrationsDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        
        // Should contain SQL comments
        expect(content).toMatch(/--.*/);
        
        // Should contain CREATE or ALTER statements
        expect(content).toMatch(/CREATE|ALTER/i);
        
        // Should not contain dangerous operations
        expect(content.toLowerCase()).not.toMatch(/drop\s+database|truncate\s+table/i);
      }
    });
  });
  
  describe('Configuration Validation', () => {
    test('should validate migration configuration exists', () => {
      const configPath = path.join(__dirname, '../../migrator-config.js');
      expect(fs.existsSync(configPath)).toBe(true);
    });
    
    test('should validate configuration structure', () => {
      const configPath = path.join(__dirname, '../../migrator-config.js');
      
      if (!fs.existsSync(configPath)) {
        console.log('Migration config not found, skipping test');
        return;
      }
      
      // Try to require the config
      const config = require(configPath);
      
      // Should have environment configurations
      expect(config).toHaveProperty('development');
      expect(config).toHaveProperty('test');
      expect(config).toHaveProperty('production');
      
      // Should have required properties
      expect(config.development).toHaveProperty('client', 'pg');
      expect(config.development).toHaveProperty('connection');
    });
  });
  
  describe('Docker Configuration Validation', () => {
    test('should validate docker-compose configuration exists', () => {
      const dockerComposePath = path.join(__dirname, '../../docker-compose.dev.yml');
      expect(fs.existsSync(dockerComposePath)).toBe(true);
    });
    
    test('should validate docker-compose structure', () => {
      const dockerComposePath = path.join(__dirname, '../../docker-compose.dev.yml');
      
      if (!fs.existsSync(dockerComposePath)) {
        console.log('Docker compose file not found, skipping test');
        return;
      }
      
      const content = fs.readFileSync(dockerComposePath, 'utf8');
      
      // Should contain PostgreSQL service
      expect(content).toMatch(/postgres:/);
      
      // Should contain Redis service
      expect(content).toMatch(/redis:/);
      
      // Should contain proper networking
      expect(content).toMatch(/networks:/);
      
      // Should contain volume definitions
      expect(content).toMatch(/volumes:/);
    });
  });
  
  describe('Package.json Scripts Validation', () => {
    test('should validate migration scripts exist in package.json', () => {
      const packageJsonPath = path.join(__dirname, '../../package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      
      const expectedScripts = [
        'db:migrate',
        'db:migrate:down',
        'db:migrate:create',
        'db:migrate:reset',
        'db:setup'
      ];
      
      for (const script of expectedScripts) {
        expect(packageJson.scripts).toHaveProperty(script);
      }
    });
    
    test('should validate migration script commands', () => {
      const packageJsonPath = path.join(__dirname, '../../package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      
      expect(packageJson.scripts['db:migrate']).toBe('node-pg-migrate up');
      expect(packageJson.scripts['db:migrate:down']).toBe('node-pg-migrate down');
      expect(packageJson.scripts['db:migrate:create']).toBe('node-pg-migrate create');
      expect(packageJson.scripts['db:migrate:reset']).toBe('node-pg-migrate reset');
    });
  });
  
  describe('Documentation Validation', () => {
    test('should validate migration documentation exists', () => {
      const docPath = path.join(__dirname, '../../DB_MIGRATIONS.md');
      expect(fs.existsSync(docPath)).toBe(true);
    });
    
    test('should validate documentation contains key sections', () => {
      const docPath = path.join(__dirname, '../../DB_MIGRATIONS.md');
      
      if (!fs.existsSync(docPath)) {
        console.log('Migration documentation not found, skipping test');
        return;
      }
      
      const content = fs.readFileSync(docPath, 'utf8');
      
      // Should contain key sections
      expect(content).toMatch(/Key components/);
      expect(content).toMatch(/Authoritative migration runner/);
      expect(content).toMatch(/Commands reference/);
      expect(content).toMatch(/CI notes/);
    });
  });
  
  describe('Environment Configuration Validation', () => {
    test('should validate .env.example contains database variables', () => {
      const envExamplePath = path.join(__dirname, '../../.env.example');
      
      if (!fs.existsSync(envExamplePath)) {
        console.log('.env.example not found, skipping test');
        return;
      }
      
      const content = fs.readFileSync(envExamplePath, 'utf8');
      
      // Should contain database configuration examples
      expect(content).toMatch(/DATABASE_URL/);
      expect(content).toMatch(/# DB \(when added\)/);
    });
  });
});
