// Makes openwave/web/js/world-map.js: the dotted world map behind Explore, and each country's own
// dotted shape. Run it again only to change the map's look; the output is committed.
//
//   node scripts/make_world_map.mjs
//
// Country outlines: Natural Earth 1:50m (public domain), as packaged by world-atlas.
// Country codes, regions and capitals: world-countries (ODbL).

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ATLAS = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json';
const COUNTRIES = 'https://cdn.jsdelivr.net/npm/world-countries@5.1.0/countries.json';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'openwave', 'web', 'js', 'world-map.js');

const COLS = 168;              // dots across the world map
const SHAPE = 30;              // a country's own shape is at most this many dots across or down
const TOP = 78, BOTTOM = -56;  // latitudes shown: no Antarctica, no far Arctic
const HEX = Math.sqrt(3) / 2;  // rows are this much closer than columns, every other row shifted half a dot

const [atlas, countries] = await Promise.all([ATLAS, COUNTRIES].map(async (u) => (await fetch(u)).json()));

// ------------------------------------------------------------------ TopoJSON to polygons
function decodeArcs(topo) {
  const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;
  return topo.arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; });
  });
}
const arcs = decodeArcs(atlas);
function ring(indexes) {
  const out = [];
  for (const i of indexes) {
    const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
    out.push(...(out.length ? a.slice(1) : a));
  }
  return out;
}
// A ring that crosses the 180th meridian jumps from +180 to -180; it's unwrapped onto 0..360 (and
// tested at lon and lon + 360), or its edge along the jump would cut a line across the whole world.
function unwrap(r) {
  const jumps = r.some((p, i) => i && Math.abs(p[0] - r[i - 1][0]) > 180);
  return jumps ? r.map(([x, y]) => [x < 0 ? x + 360 : x, y]) : r;
}
function polygons(geo) {
  if (geo.type === 'Polygon') return [geo.arcs.map(ring).map(unwrap)];
  if (geo.type === 'MultiPolygon') return geo.arcs.map((p) => p.map(ring).map(unwrap));
  return [];
}
const inside = ({ p, box }, lon, lat) => [lon, lon + 360].some((x) => x >= box[0] && x <= box[2] && lat >= box[1] && lat <= box[3] && inPolygon(p, x, lat));

const byNumber = new Map(countries.filter((c) => c.ccn3).map((c) => [c.ccn3, c]));
const REGION = (c) => {
  if (c.cca2 === 'US' || c.cca2 === 'CA') return 'na';
  if (c.region === 'Americas') return c.cca2 === 'GL' ? 'na' : 'la';
  if (c.region === 'Africa') return 'af';
  if (c.region === 'Europe') return 'eu';
  if (c.region === 'Oceania') return 'oc';
  if (c.subregion === 'Western Asia') return 'me';
  return 'as';
};

function bboxOf(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}
function area(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return Math.abs(a / 2);
}
function inRing(r, x, y) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPolygon = (p, x, y) => inRing(p[0], x, y) && !p.slice(1).some((hole) => inRing(hole, x, y));

// Some countries come in more than one piece of the atlas (Australia and its Ashmore and Cartier
// Islands share a number): they're one country here.
const byCode = new Map();
for (const g of atlas.objects.countries.geometries) {
  const c = byNumber.get(g.id);
  if (!c) continue;
  const polys = polygons(g).map((p) => ({ p, box: bboxOf([p[0]]), size: area(p[0]) }));
  if (!polys.length) continue;
  if (byCode.has(c.cca2)) byCode.get(c.cca2).polys.push(...polys);
  else byCode.set(c.cca2, { code: c.cca2, c, polys });
}
const lands = [...byCode.values()];
for (const l of lands) l.main = l.polys.reduce((a, b) => (b.size > a.size ? b : a));

// ------------------------------------------------------------------ the world map (Miller projection)
const miller = (lat) => 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * (lat * Math.PI) / 180));
const unMiller = (y) => ((2.5 * Math.atan(Math.exp(0.8 * y)) - 0.625 * Math.PI) * 180) / Math.PI;
const W = 2 * Math.PI, yTop = miller(TOP), yBottom = miller(BOTTOM), H = yTop - yBottom;
const ROWS = Math.round((COLS * H) / W / HEX);
const toGrid = (lon, lat) => [((lon + 180) / 360) * COLS - 0.5, ((yTop - miller(lat)) / H) * ROWS - 0.5];

const codes = lands.map((l) => l.code);
const grid = new Int16Array(COLS * ROWS).fill(-1);
for (let y = 0; y < ROWS; y++) {
  const lat = unMiller(yTop - ((y + 0.5) / ROWS) * H);
  for (let x = 0; x < COLS; x++) {
    const lon = ((x + 0.5 + (y % 2) * 0.5) / COLS) * 360 - 180;
    for (let i = 0; i < lands.length; i++) {
      const hit = lands[i].polys.some((poly) => inside(poly, lon, lat));
      if (hit) { grid[y * COLS + x] = i; break; }
    }
  }
}

// A country's middle (of its biggest piece), in map dots.
function middle(l) {
  const r = l.main.p[0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    a += f; cx += (r[j][0] + r[i][0]) * f; cy += (r[j][1] + r[i][1]) * f;
  }
  if (!a) return toGrid(r[0][0], r[0][1]);
  const lon = cx / (3 * a);
  return toGrid(lon > 180 ? lon - 360 : lon, cy / (3 * a));
}
// Countries too small to cover a dot still get one, at their middle.
const centres = lands.map(middle);
lands.forEach((l, i) => {
  if (grid.includes(i)) return;
  const [gx, gy] = centres[i].map(Math.round);
  if (gx >= 0 && gx < COLS && gy >= 0 && gy < ROWS) grid[gy * COLS + gx] = i;
});

// Runs of dots: [row, first column, length, country] for each stretch of one country along a row.
const runs = [];
for (let y = 0; y < ROWS; y++) {
  for (let x = 0; x < COLS;) {
    const v = grid[y * COLS + x];
    if (v < 0) { x++; continue; }
    let n = 1;
    while (x + n < COLS && grid[y * COLS + x + n] === v) n++;
    runs.push(y, x, n, v);
    x += n;
  }
}

// ------------------------------------------------------------------ each country's own shape
function shape(l) {
  // The main land and the islands near it (Corsica, Hokkaido, Java), not far-off ones (Alaska,
  // French Guiana, the Canaries): a piece joins if its box is within a few degrees of the group's.
  const [mx0, my0, mx1, my1] = l.main.box;
  const gap = Math.max(3, Math.max(mx1 - mx0, my1 - my0) * 0.06);
  const near = [l.main];
  let group = l.main.box.slice();
  for (let grew = true; grew;) {
    grew = false;
    for (const poly of l.polys) {
      if (near.includes(poly)) continue;
      const b = poly.box;
      const dx = Math.max(0, b[0] - group[2], group[0] - b[2]), dy = Math.max(0, b[1] - group[3], group[1] - b[3]);
      if (Math.hypot(dx, dy) > gap) continue;
      near.push(poly);
      group = [Math.min(group[0], b[0]), Math.min(group[1], b[1]), Math.max(group[2], b[2]), Math.max(group[3], b[3])];
      grew = true;
    }
  }
  const [x0, y0, x1, y1] = group;
  const k = Math.cos((((y0 + y1) / 2) * Math.PI) / 180);
  const w = (x1 - x0) * k, h = y1 - y0;
  const step = Math.max(w, h / HEX) / (SHAPE - 1);   // rows are HEX of a step apart
  const cols = Math.max(1, Math.round(w / step) + 1), rows = Math.max(1, Math.round(h / (step * HEX)) + 1);
  // Cells test against the outline at a few points each, so thin countries (Chile, Norway) still show.
  const bits = new Uint8Array(Math.ceil((cols * rows) / 8));
  let any = false;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const hit = [[0, 0], [0.25, 0.25], [-0.25, 0.25], [0.25, -0.25], [-0.25, -0.25]].some(([dx, dy]) => {
        const lon = x0 + ((x + (y % 2) * 0.5 + dx - (cols > 1 ? 0.25 : 0)) * step) / k;
        const lat = y1 - (y + dy) * step * HEX;
        return near.some((poly) => inside(poly, lon, lat));
      });
      if (hit) { bits[(y * cols + x) >> 3] |= 1 << ((y * cols + x) & 7); any = true; }
    }
  }
  if (!any) bits[0] = 1;
  return [cols, rows, Buffer.from(bits).toString('base64')];
}

const info = {};
lands.forEach((l, i) => {
  info[l.code] = [REGION(l.c), l.c.capital?.[0] || '', +centres[i][0].toFixed(1), +centres[i][1].toFixed(1), ...shape(l)];
});

const js = `// Made by scripts/make_world_map.mjs. Do not edit: run it again instead.
// Country outlines from Natural Earth (public domain); codes, regions and capitals from world-countries (ODbL).
//
// MAP: the world as ${COLS} x ${ROWS} dots, every other row shifted half a dot. RUNS lists the land as
// [row, first column, length, country index into CODES] for each stretch of one country along a row.
// COUNTRY[code]: [region, capital, middle column, middle row, shape columns, shape rows, shape dots
// (base64 bits, row by row)].

export const MAP = { cols: ${COLS}, rows: ${ROWS} };
export const CODES = ${JSON.stringify(codes.join(''))};
export const RUNS = ${JSON.stringify(runs)};
export const COUNTRY = ${JSON.stringify(info)};
`;
writeFileSync(OUT, js);
console.log(`${OUT}: ${COLS}x${ROWS}, ${runs.length / 4} runs, ${lands.length} countries, ${(js.length / 1024).toFixed(1)} KB`);
