import path from 'path'
import { defineConfig } from 'vitest/config'

/**
 * The tests import the framework and the common package by their published names, and the framework
 * in turn imports @activepieces/core-piece-types and @activepieces/core-utils by bare specifier.
 * There is no workspace linking in this repository, so all four have to be aliased to the sources
 * that scripts/fetch-ap.mjs puts in .ap-src. Aliasing only the two the tests name directly leaves
 * the framework unresolvable and silently costs four of the seven suites.
 */
const apSrc = path.resolve(__dirname, '../../.ap-src')

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
  resolve: {
    alias: {
      '@activepieces/pieces-framework': path.resolve(apSrc, 'packages/pieces/framework/src/index.ts'),
      '@activepieces/pieces-common': path.resolve(apSrc, 'packages/pieces/common/src/index.ts'),
      '@activepieces/core-piece-types': path.resolve(apSrc, 'packages/core/piece-types/src/index.ts'),
      '@activepieces/core-utils': path.resolve(apSrc, 'packages/core/utils/src/index.ts'),
    },
  },
})
