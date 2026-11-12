// Street plan for the map: a 2300 m x 2300 m slice of Midtown Manhattan
// (about 2.04 square miles) centred on Times Square.
//
//   +x = east, -z = north. 45th St runs along z = 0, 7th Ave along x = 0.
//   Streets 31st..59th every 80 m, avenues 11th..3rd, Broadway cutting the
//   grid diagonally from Herald Square (34th & 6th) to Columbus Circle
//   (59th & 8th) and forming the Times Square "bowtie" where it crosses 7th.

export const HALF = 1150;
export const CURB = 0.15;
export const PITCH = 80;
export const BW_ROAD = 8;   // Broadway half roadway width
export const BW_HW = 13;    // Broadway half corridor width (building line)

export const AVENUES = [
  { id: '11', name: '11 AV', x: -1120, road: 10, hw: 15 },
  { id: '10', name: '10 AV', x: -840, road: 10, hw: 15 },
  { id: '9', name: '9 AV', x: -560, road: 10, hw: 15 },
  { id: '8', name: '8 AV', x: -280, road: 10, hw: 15 },
  { id: '7', name: '7 AV', x: 0, road: 9, hw: 15 },
  { id: '6', name: '6 AV', x: 280, road: 11, hw: 16 },
  { id: '5', name: '5 AV', x: 560, road: 9, hw: 15 },
  { id: 'MAD', name: 'MADISON AV', x: 700, road: 8, hw: 13 },
  { id: 'PARK', name: 'PARK AV', x: 840, road: 14, hw: 20 },
  { id: 'LEX', name: 'LEXINGTON AV', x: 980, road: 8, hw: 13 },
  { id: '3', name: '3 AV', x: 1120, road: 10, hw: 15 },
];

const MAJOR = new Set([34, 42, 57, 59]);
export const streetZ = (n) => (45 - n) * PITCH;

/** Streets sorted north -> south (ascending z). */
export const STREETS = [];
for (let n = 59; n >= 31; n--) {
  const major = MAJOR.has(n);
  STREETS.push({ n, z: streetZ(n), road: major ? 9 : 5, hw: major ? 15 : 9, major });
}

export const broadwayX = (z) => (z > 0 ? z * 0.318 : z * 0.25);
export const broadwaySlope = (z) => (z > 0 ? 0.318 : 0.25);

// Pedestrianised stretch of Broadway (42nd..47th): the Times Square plazas.
export const PLAZA_Z0 = streetZ(47);
export const PLAZA_Z1 = streetZ(42);
export const inPlazaZone = (z) => z > PLAZA_Z0 && z < PLAZA_Z1;

// Ground that is raised to kerb height although it lies on the street grid.
export const RAISED_RECTS = [];
export const RAISED_CIRCLES = [];

const ROAD = -2;
/** Index of the block column containing x (-1 .. AVENUES.length-1) or ROAD. */
export function colOf(x) {
  for (let i = 0; i < AVENUES.length; i++) {
    const a = AVENUES[i];
    if (x < a.x - a.road) return i - 1;
    if (x <= a.x + a.road) return ROAD;
  }
  return AVENUES.length - 1;
}
/** Index of the block row containing z (-1 .. STREETS.length-1) or ROAD. */
export function rowOf(z) {
  for (let i = 0; i < STREETS.length; i++) {
    const s = STREETS[i];
    if (z < s.z - s.road) return i - 1;
    if (z <= s.z + s.road) return ROAD;
  }
  return STREETS.length - 1;
}

/** Height of the walkable ground: 0 on roadways, CURB on sidewalks and plazas. */
export function groundAt(x, z) {
  for (let i = 0; i < RAISED_RECTS.length; i++) {
    const r = RAISED_RECTS[i];
    if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) return CURB;
  }
  for (let i = 0; i < RAISED_CIRCLES.length; i++) {
    const c = RAISED_CIRCLES[i];
    const dx = x - c.x, dz = z - c.z;
    if (dx * dx + dz * dz <= c.r * c.r) return CURB;
  }
  if (colOf(x) === ROAD || rowOf(z) === ROAD) return 0;
  if (!inPlazaZone(z) && Math.abs(x - broadwayX(z)) < BW_ROAD) return 0;
  return CURB;
}

/**
 * All city blocks. `x0..z1` is the building-line rectangle, `sx0..sz1` the
 * sidewalk slab (reaching out to the kerb). Border blocks extend past the map
 * edge and only carry backdrop buildings.
 */
export function makeBlocks() {
  const blocks = [];
  const BACK = 60;
  for (let c = -1; c < AVENUES.length; c++) {
    const west = AVENUES[c], east = AVENUES[c + 1];
    for (let r = -1; r < STREETS.length; r++) {
      const north = STREETS[r], south = STREETS[r + 1];
      blocks.push({
        col: c,
        row: r,
        border: !west || !east || !north || !south,
        x0: west ? west.x + west.hw : -HALF - BACK,
        x1: east ? east.x - east.hw : HALF + BACK,
        z0: north ? north.z + north.hw : -HALF - BACK,
        z1: south ? south.z - south.hw : HALF + BACK,
        sx0: west ? west.x + west.road : -HALF - BACK,
        sx1: east ? east.x - east.road : HALF + BACK,
        sz0: north ? north.z + north.road : -HALF - BACK,
        sz1: south ? south.z - south.road : HALF + BACK,
        // street numbers bounding the block (north has the higher number)
        nNorth: north ? north.n : 60,
        nSouth: south ? south.n : 30,
      });
    }
  }
  return blocks;
}

export const avenueById = (id) => AVENUES.find((a) => a.id === id);

// Named places: capture sectors, fast-travel stations and HUD location names.
export const LANDMARKS = {
  timesSquare: { name: 'TIMES SQUARE', x: 6, z: 40 },
  bryantPark: { name: 'BRYANT PARK', x: 420, z: 320 },
  grandCentral: { name: 'GRAND CENTRAL', x: 772, z: 262 },
  rockefeller: { name: 'ROCKEFELLER PLAZA', x: 470, z: -360 },
  columbusCircle: { name: 'COLUMBUS CIRCLE', x: -280, z: -1120 },
  heraldSquare: { name: 'HERALD SQUARE', x: 262, z: 846 },
  hudsonYards: { name: 'HUDSON YARDS', x: -980, z: 920 },
  hellsKitchen: { name: "HELL'S KITCHEN", x: -700, z: -160 },
  pennPlaza: { name: 'PENN PLAZA', x: -140, z: 1000 },
  parkAvenue: { name: 'PARK AVENUE', x: 840, z: -560 },
};

export function districtName(x, z) {
  let best = null, bd = 150 * 150;
  for (const k in LANDMARKS) {
    const l = LANDMARKS[k];
    const d = (x - l.x) * (x - l.x) + (z - l.z) * (z - l.z);
    if (d < bd) { bd = d; best = l.name; }
  }
  if (best) return best;
  if (z < -1100) return 'CENTRAL PARK SOUTH';
  if (Math.abs(x - broadwayX(z)) < 150 && z > -330 && z < 330) return 'THEATER DISTRICT';
  if (x < -420) return z > 500 ? 'HUDSON YARDS' : "HELL'S KITCHEN";
  if (x > 640) return z < -400 ? 'PARK AVENUE' : 'MIDTOWN EAST';
  if (z > 560) return 'GARMENT DISTRICT';
  if (z < -640) return 'BILLIONAIRES ROW';
  return 'MIDTOWN';
}

/** Street label for a world position, e.g. "W 45 ST & 7 AV". */
export function crossStreet(x, z) {
  let s = STREETS[0], sd = Infinity;
  for (const st of STREETS) {
    const d = Math.abs(z - st.z);
    if (d < sd) { sd = d; s = st; }
  }
  let a = AVENUES[0], ad = Infinity;
  for (const av of AVENUES) {
    const d = Math.abs(x - av.x);
    if (d < ad) { ad = d; a = av; }
  }
  let av = a.name;
  if (Math.abs(x - broadwayX(z)) < ad) av = 'BROADWAY';
  return `${x < 560 ? 'W' : 'E'} ${s.n} ST & ${av}`;
}
