// Navigation for open maps: walkable points on a regular grid, linked to their
// neighbours when a body can walk the straight line between them. The A* and
// the query API are the same ones the street map uses (see nav.js).
import { navFromNodes } from './nav.js';
import { F_SOLID } from '../core/physics.js';

const RADIUS = 0.55, HEIGHT = 1.9, EYE = 0.9;   // body used for the walkability tests

/**
 * @param world physics World (groundAt set, colliders added)
 * @param {{x0,x1,z0,z1}} bounds area to cover
 * @param {{step?:number, extra?:number[][], minGround?:number}} o extra = [[x, z]] points to add (hotspots)
 */
export function buildGridNav(world, bounds, { step = 3.5, extra = [], minGround = -Infinity } = {}) {
  const g = (x, z) => world.groundAt(x, z);
  const nodes = [];
  const spot = (x, z) => {
    const gy = g(x, z);
    if (gy < minGround) return false;
    return world.fits(x, world.supportAt(x, z, gy, RADIUS), z, RADIUS, HEIGHT);
  };
  const add = (x, z) => {
    nodes.push({ id: nodes.length, x, z, links: [] });
    return nodes.length - 1;
  };
  // eye-height ray between two ground points; props and walls (anything solid) block it
  const los = (x0, z0, x1, z1) => world.clear(x0, g(x0, z0) + EYE, z0, x1, g(x1, z1) + EYE, z1, F_SOLID);
  const link = (i, j) => {
    if (i < 0 || j < 0 || i === j) return;
    const a = nodes[i], b = nodes[j];
    if (a.links.some((l) => l.to === j)) return;
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (Math.abs(g(a.x, a.z) - g(b.x, b.z)) > d * 0.9) return;   // too steep to walk
    if (!los(a.x, a.z, b.x, b.z)) return;
    a.links.push({ to: j, d });
    b.links.push({ to: i, d });
  };

  const nx = Math.floor((bounds.x1 - bounds.x0) / step) + 1, nz = Math.floor((bounds.z1 - bounds.z0) / step) + 1;
  const grid = new Int32Array(nx * nz).fill(-1);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = bounds.x0 + i * step, z = bounds.z0 + j * step;
      if (spot(x, z)) grid[j * nx + i] = add(x, z);
    }
  }
  const at = (i, j) => (i < 0 || j < 0 || i >= nx || j >= nz ? -1 : grid[j * nx + i]);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = at(i, j);
      if (a < 0) continue;
      link(a, at(i + 1, j)); link(a, at(i, j + 1)); link(a, at(i + 1, j + 1)); link(a, at(i + 1, j - 1));
    }
  }
  // hotspots become nodes of their own, tied to the grid points around them
  for (const [x, z] of extra) {
    if (!spot(x, z)) continue;
    const id = add(x, z);
    for (let k = 0; k < id; k++) {
      const n = nodes[k];
      if (Math.abs(n.x - x) < 6 && Math.abs(n.z - z) < 6) link(id, k);
    }
  }

  return navFromNodes(nodes, los);
}
