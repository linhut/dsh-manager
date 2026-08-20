/**
 * DSH Manager - State Module
 * Centralized application state
 */
'use strict';

const state = {
  skillsQuery: '',
  skillsSourceFilter: 'all',
  skillsSortBy: 'name',
  skillMarketResults: [],
  skillMarketCategory: 'all',
  skillMarketSort: 'stars',
  skillEditingName: null,
  currentPage: 'dashboard',
  dshInstalled: false,
  dshVersion: null,
  dshRunning: false,
  dshUrl: 'http://127.0.0.1:3080',
  plugins: [],
  installing: false,
  pnpmAvailable: null,
  pnpmVersion: null,
  pnpmInstallGuide: '',
  dshInfo: null,
  marketResults: [],
  marketCategory: 'all',
  marketScope: 'all',
  marketSort: 'top',
  localPlugins: [],
};
