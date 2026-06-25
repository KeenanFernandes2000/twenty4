// Metro config for the twenty4 Bun monorepo.
// Follows Expo's "Working with monorepos" guide so Metro can resolve + transpile
// the sibling workspace packages (@twenty4/contracts, @twenty4/api-client) which
// are consumed as raw TypeScript SOURCE (their package main is src/index.ts).
// https://docs.expo.dev/guides/monorepos/
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
// apps/mobile -> apps -> repo root
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Watch the whole monorepo so changes in sibling packages trigger reloads.
config.watchFolders = [workspaceRoot];

// 2. Let Metro resolve modules from BOTH the app's and the root's node_modules.
//    Bun hoists most deps to the root; some stay app-local.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// 3. Bun uses symlinks for workspace packages; Metro must follow them.
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
