// Street-level navigation graph for the bots: one node per intersection
// (plus the Broadway crossings), edges along streets and avenues that are not
// blocked by buildings. Paths are found with A*.
import { AVENUES, STREETS, broadwayX, HALF } from './layout.js';
import { F_BUILDING } from '../core/physics.js';

export function buildNav(world) {
  const nodes = [];
  const add = (x, z) => {
    nodes.push({ id: nodes.length, x, z, links: [] });
    return nodes.length - 1;
  };
  const open = (x, z) => world.fits(x, 0.3, z, 0.6, 2);
  const los = (a, b) => world.clear(a.x, 1.2, a.z, b.x, 1.2, b.z, F_BUILDING);
  const link = (i, j) => {
    if (i < 0 || j < 0 || i === j) return;
    const a = nodes[i], b = nodes[j];
    if (a.links.some((l) => l.to === j)) return;
    if (!los(a, b)) return;
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    a.links.push({ to: j, d });
    b.links.push({ to: i, d });
  };

  // grid[r][c] -> node id (or -1 when the crossing is built over)
  const grid = STREETS.map((s) => AVENUES.map((a) => (open(a.x, s.z) ? add(a.x, s.z) : -1)));
  const bway = STREETS.map((s) => {
    const x = broadwayX(s.z);
    if (Math.abs(x) > HALF - 20) return -1;
    if (AVENUES.some((a) => Math.abs(a.x - x) < 14)) return -1; // coincides with an avenue crossing
    return open(x, s.z) ? add(x, s.z) : -1;
  });

  for (let r = 0; r < STREETS.length; r++) {
    // along the street, including the Broadway crossing in x order
    const row = grid[r].filter((i) => i >= 0);
    if (bway[r] >= 0) row.push(bway[r]);
    row.sort((i, j) => nodes[i].x - nodes[j].x);
    for (let k = 0; k < row.length - 1; k++) link(row[k], row[k + 1]);
  }
  for (let c = 0; c < AVENUES.length; c++) {
    for (let r = 0; r < STREETS.length - 1; r++) link(grid[r][c], grid[r + 1][c]);
  }
  // along Broadway; where it merges with an avenue crossing use that node
  const bwNode = (r) => {
    if (bway[r] >= 0) return bway[r];
    const x = broadwayX(STREETS[r].z);
    for (let c = 0; c < AVENUES.length; c++) if (Math.abs(AVENUES[c].x - x) < 14) return grid[r][c];
    return -1;
  };
  for (let r = 0; r < STREETS.length - 1; r++) link(bwNode(r), bwNode(r + 1));

  const N = nodes.length;
  const gScore = new Float32Array(N);
  const fScore = new Float32Array(N);
  const came = new Int16Array(N);
  const state = new Uint8Array(N); // 0 new, 1 open, 2 closed

  const order = new Int16Array(N);
  const dist2 = new Float32Array(N);
  /** Closest connected node; with needLos only the handful of nearest candidates are ray-tested. */
  function nearest(x, z, needLos = true) {
    let m = 0;
    for (let i = 0; i < N; i++) {
      const n = nodes[i];
      if (!n.links.length) continue;
      dist2[i] = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z);
      order[m++] = i;
    }
    // partial selection sort: the 8 nearest are enough
    const want = Math.min(needLos ? 8 : 1, m);
    for (let k = 0; k < want; k++) {
      let b = k;
      for (let j = k + 1; j < m; j++) if (dist2[order[j]] < dist2[order[b]]) b = j;
      const t = order[k]; order[k] = order[b]; order[b] = t;
      const n = nodes[order[k]];
      if (!needLos || dist2[order[k]] <= 9 || world.clear(x, 1.2, z, n.x, 1.2, n.z, F_BUILDING)) return order[k];
    }
    return -1;
  }

  /**
   * Path from (x0,z0) to (x1,z1) as a list of waypoints (start excluded, goal
   * included). Returns a direct segment when the two points see each other.
   */
  function findPath(x0, z0, x1, z1) {
    if (world.clear(x0, 1.2, z0, x1, 1.2, z1, F_BUILDING)) return [{ x: x1, z: z1 }];
    let s = nearest(x0, z0), g = nearest(x1, z1);
    if (s < 0) s = nearest(x0, z0, false);
    if (g < 0) g = nearest(x1, z1, false);
    if (s < 0 || g < 0) return [{ x: x1, z: z1 }];
    state.fill(0);
    const openList = [s];
    gScore[s] = 0;
    fScore[s] = Math.hypot(nodes[s].x - nodes[g].x, nodes[s].z - nodes[g].z);
    came[s] = -1;
    state[s] = 1;
    let found = false;
    while (openList.length) {
      let bi = 0;
      for (let i = 1; i < openList.length; i++) if (fScore[openList[i]] < fScore[openList[bi]]) bi = i;
      const cur = openList[bi];
      openList[bi] = openList[openList.length - 1];
      openList.pop();
      if (cur === g) { found = true; break; }
      state[cur] = 2;
      const n = nodes[cur];
      for (let k = 0; k < n.links.length; k++) {
        const { to, d } = n.links[k];
        if (state[to] === 2) continue;
        const t = gScore[cur] + d;
        if (state[to] === 0 || t < gScore[to]) {
          gScore[to] = t;
          fScore[to] = t + Math.hypot(nodes[to].x - nodes[g].x, nodes[to].z - nodes[g].z);
          came[to] = cur;
          if (state[to] === 0) { state[to] = 1; openList.push(to); }
        }
      }
    }
    const path = [{ x: x1, z: z1 }];
    if (found) {
      for (let c = g; c >= 0; c = came[c]) path.push({ x: nodes[c].x, z: nodes[c].z });
    }
    path.reverse();
    // drop leading nodes we can skip because a later one is already visible
    while (path.length > 1 && world.clear(x0, 1.2, z0, path[1].x, 1.2, path[1].z, F_BUILDING)) path.shift();
    // same at the far end
    while (path.length > 2 && world.clear(path[path.length - 3].x, 1.2, path[path.length - 3].z, x1, 1.2, z1, F_BUILDING)) path.splice(path.length - 2, 1);
    return path;
  }

  /** Random connected node within [minD, maxD] of a point (for patrol goals and spawns). */
  function randomNode(x, z, minD, maxD, rnd = Math.random) {
    const cand = [];
    for (let i = 0; i < N; i++) {
      const n = nodes[i];
      if (!n.links.length) continue;
      const d = Math.hypot(n.x - x, n.z - z);
      if (d >= minD && d <= maxD) cand.push(n);
    }
    return cand.length ? cand[Math.floor(rnd() * cand.length)] : null;
  }

  return { nodes, findPath, nearest, randomNode };
}
