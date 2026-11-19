# Map contract: Cedar Lodge (second map)

Shared interface between the map asset (Blender), the foliage system and the
engine. Midtown is not changed by any of this.

## The map

Cedar Lodge is an original map for small 6 v 6 fights: a timber-and-stone
mountain lodge on a pine-forested lakeshore on a clear, sunny afternoon.

Coordinates are game space in metres: +X east, +Y up, +Z south (north is -Z).
The playable area is x -55..55, z -65..65. Scenery may extend to about ±150.

| Area | Where | What is there |
|---|---|---|
| North | z -65..-45 | Lakeshore; the water starts around z = -48 (surface y = -1.2) and runs to the horizon, with distant mountains. A wooden dock juts north from (-20, -46) to z = -62. A boathouse on stilts stands near (18, -50) with a walkable floor. Team B spawns here, around z -38..-44. |
| Centre | footprint about 20 x 12, centred at (0, 0), long axis along X | Two-storey lodge with a log/timber upper floor and a stone base. The ground floor can be entered through doors on the north, south and east sides. Inside: a big room with a stone fireplace, tables, sofas, a bar counter, and stairs to an upper gallery with windows. A covered porch with railings runs along the south side. |
| West lane | x -55..-25 | A rocky creek running north into the lake, about 1.5 m below the surrounding ground, with a wooden footbridge at z ≈ 0. Boulders, ferns, birches. A small one-room cabin you can enter at (-38, 25). |
| East lane | x 25..55 | A glass greenhouse at (38, -10), a fenced vegetable garden, a tool shed, picnic tables and an old tractor. |
| South | z 40..65 | Gravel parking area with a pickup, an SUV, a log pile and a woodshed. Team A spawns here, around z 52..60. A gravel road leaves south into the forest, blocked by a gate and a fallen tree. |
| Boundary | edges of the playable area | Dense pine forest and rocky slopes rising beyond the edges, plus invisible boundary colliders. |

The terrain rolls gently. The lodge sits on a flat pad at y ≈ 0, and the
shore slopes down into the water.

## Asset module: `src/maps/lodge_asset.js`

Written by `tools/blender/build_lodge.py`.

```js
export const LODGE_GLB = '<base64 glTF binary>';
export const LODGE_DATA = { /* fields below */ };
```

### `LODGE_GLB`

The static scenery, already in game space:
- Terrain, buildings, props, rocks, the dock, the boathouse and the
  far-backdrop mountains.
- No trees, bushes or grass; foliage is drawn separately.
- No water surface.
- Meshes are merged by material.
- Materials are PBR, with baseColor, normal and metallicRoughness (ORM)
  textures and occlusion baked in.
- Each mesh's `extras` may carry `{ "castShadow": true|false, "glass": true }`.

### `LODGE_DATA` fields

| Field | Contents |
|---|---|
| `name` | `'CEDAR LODGE'` |
| `half` | World half-extent in metres (≥ 160), used for the physics grid. |
| `bounds` | `{ x0: -55, x1: 55, z0: -65, z1: 65 }`, the playable area. |
| `height` | `{ n, x0, z0, size, data }`. Terrain height (m) on an n x n grid starting at (x0, z0), covering size x size metres. `data` is base64 Float32, row-major with rows along z and columns along x. Read bilinearly. Ground only: floors and props are colliders. |
| `colliders` | `[[x0, y0, z0, x1, y1, z1, flags, surf], ...]`, axis-aligned boxes. `flags` and `surf` use the `F_*` and `S_*` constants in `src/core/physics.js`. Use `F_DEFAULT \| F_BUILDING` for walls, and `F_DEFAULT` for props and boundaries. |
| `spawns` | `[teamA[[x, z, yaw] x 6], teamB[[x, z, yaw] x 6]]`. Yaw follows the game's convention: 0 faces -Z (north). |
| `hotspots` | `[[x, z], ...]`, 10-14 points where fights happen. |
| `zones` | `[{ name, x0, z0, x1, z1 }]`, e.g. LODGE, DOCK, BOATHOUSE, CREEK, CABIN, GREENHOUSE, GARDEN, PARKING. Used for the location label in the HUD. |
| `water` | `{ y: -1.2, x0, z0, x1, z1 }`. The engine draws the water surface. |
| `foliage` | See below. |
| `minimap` | `{ png: base64 PNG, x0, z0, size }`. A 512 x 512 top-down orthographic render of the square (x0, z0)-(x0 + size, z0 + size), north up, no foliage canopy. |
| `sun` | `{ dir: [x, y, z] }`, a unit vector pointing towards the sun, in game space. |

### `foliage` fields

The map builder places the plants; the foliage system draws them.

| Field | Contents |
|---|---|
| `trees` | `[[x, y, z, scale, rotY, kind], ...]`. `kind` is one of `'pine'`, `'spruce'` or `'birch'`. `y` is the ground height at the trunk. |
| `bushes` | `[[x, y, z, scale, rotY, kind], ...]`. `kind` is one of `'bush'`, `'fern'` or `'hedge'`. |
| `grass` | `{ n, x0, z0, size, data }`. Grass density from 0 to 255, base64 Uint8, laid out like `height`. It is 0 on roads, gravel, floors, rock and water. |

## Foliage module: `src/world/foliage.js`

Written by the foliage agent.

```js
export async function buildFoliage({ foliage, heightAt, quality }) -> {
  group,                        // THREE.Group to add to the scene
  update(dt, camPos, drawScale),// LOD, grass around the camera, wind time
  colliders,                    // [[x0, y0, z0, x1, y1, z1, flags, surf]] tree trunks
  setQuality(name),             // 'low' | 'medium' | 'high' | 'ultra'
  dispose(),
}
```

The meshes come from `src/world/foliage_asset.js`, made by
`tools/blender/build_foliage.py`.

## Engine

Written by the engine agent.

- `src/maps/index.js` is a registry with `midtown` and `lodge`. Each map
  builds an object with `{ id, name, group, world, nav, ctx: { emitters,
  stations, buildings, parks }, update, half, bounds, groundAt, zoneName,
  minimap, atmosphere }`.
- `src/maps/lodge.js` loads the asset and the foliage.
- `src/world/water.js` draws the water.
- The maps' look comes from `scene.js` `setAtmosphere()`.

## Phone budget

| Item | Limit |
|---|---|
| Map triangles, excluding foliage | ≤ 350k |
| Map draw calls | ≤ 60 |
| Textures | at most 4 sets of 2048 atlases, JPEG |
| `lodge_asset.js` size | ≤ 7 MB |
| `foliage_asset.js` size | ≤ 2.5 MB |
