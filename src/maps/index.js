// Map registry. build(onProgress) makes the map object described in
// docs/MAP_CONTRACT.md the first time and returns the same one afterwards, so
// switching back never rebuilds anything.
import { buildMidtown } from './midtown.js';
import { buildLodge } from './lodge.js';

function lazy(fn) {
  let pending = null;
  return (onProgress) => {
    if (!pending) pending = fn(onProgress).catch((e) => { pending = null; throw e; });   // a failed build may be retried
    return pending;
  };
}

export const MAPS = {
  midtown: { id: 'midtown', name: 'MIDTOWN', deploy: 'DEPLOYING TO TIMES SQUARE', build: lazy(buildMidtown) },
  lodge: { id: 'lodge', name: 'CEDAR LODGE', deploy: 'DEPLOYING TO CEDAR LODGE', build: lazy(buildLodge) },
};
