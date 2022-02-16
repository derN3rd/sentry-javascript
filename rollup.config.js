/**
 * Shared config used by individual packages' Rollup configs, not through inheritance (Rollup doesn't support that the
 * way the TS, for example, does) but through normal imports.
 */

import { terser } from 'rollup-plugin-terser';

export const terserInstance = terser({
  mangle: {
    // captureExceptions and captureMessage are public API methods and they don't need to be listed here
    // as mangler doesn't touch user-facing thing, however sentryWrapped is not, and it would be mangled into a minified version.
    // We need those full names to correctly detect our internal frames for stripping.
    // I listed all of them here just for the clarity sake, as they are all used in the frames manipulation process.
    reserved: ['captureException', 'captureMessage', 'sentryWrapped'],
    properties: {
      regex: /^_[^_]/,
    },
  },
  output: {
    comments: false,
  },
});
