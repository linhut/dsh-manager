/**
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * https://github.com/linhut/dsh-manager
 * Licensed under the MIT License. See the LICENSE file for details.
 * DSH Manager - State Module
 * Centralized application state with reactive subscriptions
 */
'use strict';

/**
 * Reactive state - when a property changes, registered callbacks are notified
 */
class ReactiveState {
  constructor(initial = {}) {
    this._data = { ...initial };
    this._listeners = new Map();
    this._idCounter = 0;
  }

  /** Get a state value */
  get(key) {
    return this._data[key];
  }

  /** Set a state value and notify listeners */
  set(key, value) {
    const old = this._data[key];
    if (old === value) return;
    this._data[key] = value;
    this._notify(key, value, old);
  }

  /** Batch update multiple state values */
  patch(updates) {
    for (const [key, value] of Object.entries(updates)) {
      const old = this._data[key];
      if (old !== value) {
        this._data[key] = value;
        this._notify(key, value, old);
      }
    }
  }

  /** Subscribe to a specific key change */
  subscribe(key, callback) {
    const id = ++this._idCounter;
    if (!this._listeners.has(key)) {
      this._listeners.set(key, new Map());
    }
    this._listeners.get(key).set(id, callback);
    // Return unsubscribe function
    return () => {
      const listeners = this._listeners.get(key);
      if (listeners) listeners.delete(id);
    };
  }

  /** Subscribe to any state change */
  subscribeAny(callback) {
    const id = ++this._idCounter;
    // Use a special key for "any"
    const key = '__any__';
    if (!this._listeners.has(key)) {
      this._listeners.set(key, new Map());
    }
    this._listeners.get(key).set(id, callback);
    return () => {
      const listeners = this._listeners.get(key);
      if (listeners) listeners.delete(id);
    };
  }

  /** Notify listeners of a change */
  _notify(key, value, old) {
    // Notify specific key listeners
    const listeners = this._listeners.get(key);
    if (listeners) {
      for (const cb of listeners.values()) {
        try { cb(value, old); } catch (e) { console.warn('State listener error:', e); }
      }
    }
    // Notify global listeners
    const anyListeners = this._listeners.get('__any__');
    if (anyListeners) {
      for (const cb of anyListeners.values()) {
        try { cb(key, value, old); } catch (e) { console.warn('State listener error:', e); }
      }
    }
  }

  /** Get all state as a plain object */
  getAll() {
    return { ...this._data };
  }

  /** Reset state to initial values */
  reset(initial = {}) {
    this._data = { ...initial };
    this._listeners.clear();
  }
}

// Create the global state instance
const appState = new ReactiveState({
  // Page state
  currentPage: 'dashboard',
  previousPage: null,
  
  // DSH state
  dshInstalled: false,
  dshVersion: null,
  dshRunning: false,
  dshUrl: 'http://127.0.0.1:3080',
  dshInfo: null,
  dshPid: null,
  
  // Environment state
  pnpmAvailable: null,
  pnpmVersion: null,
  pnpmInstallGuide: '',
  nodeAvailable: null,
  nodeVersion: null,
  npmAvailable: null,
  npmVersion: null,
  gitAvailable: null,
  gitVersion: null,
  
  // Plugin state
  plugins: [],
  localPlugins: [],
  marketResults: [],
  marketCategory: 'all',
  marketScope: 'all',
  marketSort: 'top',
  installing: false,
  
  // Skill state
  skillsQuery: '',
  skillsSourceFilter: 'all',
  skillsSortBy: 'name',
  skillMarketResults: [],
  skillMarketCategory: 'all',
  skillMarketSort: 'stars',
  skillEditingName: null,
  
  // UI state
  sidebarCollapsed: false,
  theme: 'dark',
  loading: false,
  loadingMessage: '',
  
  // Internal
  _dshPollTimer: null,
  _pageCache: {},
});

// Backward compatibility: keep the global 'state' variable
const state = appState.getAll();

// Make state reactive by creating a proxy
const stateProxy = new Proxy(state, {
  get(target, prop) {
    return appState.get(prop);
  },
  set(target, prop, value) {
    appState.set(prop, value);
    return true;
  }
});

// Export both the reactive instance and the backward-compatible proxy
window.appState = appState;
window.state = stateProxy;
window.ReactiveState = ReactiveState;
