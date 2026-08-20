import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Test core module loading (without DSH environment)
// These tests verify the core modules can be imported and basic functions work

describe('Core Module Loading', { concurrency: true }, () => {
  it('should load dsh-utils without errors', async () => {
    const mod = await import('../packages/core/src/dsh-utils.js');
    assert.ok(mod.DSH_PATHS, 'DSH_PATHS should be defined');
    assert.ok(typeof mod.DSH_PATHS.home === 'string', 'home should be a string');
  });

  it('should load errors module', async () => {
    const mod = await import('../packages/core/src/errors.js');
    assert.ok(mod.DSHError, 'DSHError should be defined');
    assert.ok(mod.DSHErrorCodes, 'DSHErrorCodes should be defined');
    const err = new mod.DSHError(mod.DSHErrorCodes.NOT_FOUND, 'test');
    assert.ok(err instanceof Error, 'DSHError should extend Error');
    assert.equal(err.code, mod.DSHErrorCodes.NOT_FOUND, 'code should match');
    assert.equal(err.message, 'test', 'message should match');
  });

  it('should load yaml-utils', async () => {
    const mod = await import('../packages/core/src/yaml-utils.js');
    assert.ok(typeof mod.parseYAML === 'function', 'parseYAML should be a function');
    assert.ok(typeof mod.toYAML === 'function', 'toYAML should be a function');
    // Test round-trip
    const obj = { foo: 'bar', num: 42, arr: [1, 2] };
    const yaml = mod.toYAML(obj);
    assert.ok(yaml.includes('foo:'), 'YAML should contain foo');
    assert.ok(yaml.includes('bar'), 'YAML should contain bar');
    const parsed = mod.parseYAML(yaml);
    assert.deepEqual(parsed, obj, 'Round-trip should preserve data');
  });

  it('should load config module', async () => {
    const mod = await import('../packages/core/src/config.js');
    assert.ok(mod.DSHConfig, 'DSHConfig should be defined');
    const config = new mod.DSHConfig();
    assert.ok(config, 'DSHConfig should be instantiable');
    assert.ok(typeof config.read === 'function', 'read should be a function');
    assert.ok(typeof config.get === 'function', 'get should be a function');
  });
});

describe('Version Manager', () => {
  it('should load version-manager module', async () => {
    const mod = await import('../packages/core/src/version-manager.js');
    assert.ok(mod.DSHVersionManager, 'DSHVersionManager should be defined');
  });
});

describe('Reply Language', () => {
  it('should load reply-language module', async () => {
    const mod = await import('../packages/core/src/reply-language.js');
    assert.ok(typeof mod.setReplyLanguage === 'function', 'setReplyLanguage should be a function');
    assert.ok(typeof mod.getReplyLanguage === 'function', 'getReplyLanguage should be a function');
    assert.ok(typeof mod.clearReplyLanguage === 'function', 'clearReplyLanguage should be a function');
  });
});

describe('Marketplace', () => {
  it('should load marketplace modules', async () => {
    const reg = await import('../packages/marketplace/src/registry.js');
    assert.ok(reg.PluginRegistry, 'PluginRegistry should be defined');
    
    const mgr = await import('../packages/marketplace/src/manager.js');
    assert.ok(mgr.PluginManager, 'PluginManager should be defined');
  });
});

describe('Skill Manager', () => {
  it('should load skill-manager module', async () => {
    const mod = await import('../packages/core/src/skill-manager.js');
    assert.ok(mod.SkillManager, 'SkillManager should be defined');
  });
});

describe('Master Prompt Manager', () => {
  it('should load master-prompt-manager module', async () => {
    const mod = await import('../packages/core/src/master-prompt-manager.js');
    assert.ok(mod.MasterPromptManager, 'MasterPromptManager should be defined');
  });
});
