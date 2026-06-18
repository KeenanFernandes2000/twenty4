// Learn more: https://docs.expo.dev/guides/monorepos/
// Monorepo-aware Metro config so `@twenty4/contracts` (consumed as TS source)
// resolves from the workspace root.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Watch all files within the monorepo.
config.watchFolders = [workspaceRoot];

// 2. Let Metro resolve packages from the app first, then the workspace root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// 3. Keep hierarchical lookup ON so a hoisted dep at the root still resolves.
config.resolver.disableHierarchicalLookup = false;

module.exports = config;
