// Board definition and scoring. Shared by the website and the Discord updater.
// Tiles are identified by their name, so progress.json stays human-readable.

export const TIERS = ["Lv 10", "Lv 20", "Lv 30", "Lv 40", "Lv 50", "Lv 55+"];

// S = safe track, D = danger track (can kill you).
export const TRACK = { S: [2, 3, 4, 5, 6, 7], D: [3, 5, 7, 9, 11, 13] };
export const BONUS = { row: 8, col: 12, diag: 12 };

export const ROWS = [
  { name: "Towers", track: "D", tint: "--r1", tiles: [
    ["Grizzly Situation", "Defeat Zoe & Grizzbolt · Lv 10"],
    ["Flower Power Outage", "Defeat Lily & Lyleen · Lv 20"],
    ["Axel Grease", "Defeat Axel & Orserk · Lv 30"],
    ["Marcus My Words", "Defeat Marcus & Faleris · Lv 40"],
    ["Beak Performance", "Defeat Victor & Shadowbeak · Lv 50"],
    ["Saya Goodbye", "Defeat Saya & Selyne · Lv 55"]] },
  { name: "Passives", track: "S", pts: [2, 3, 5, 5, 7, 7], tint: "--r2", tiles: [
    ["No Fun Allowed", "Own 5 Pals with Serious · rank 1"],
    ["Do You Even Lift", "Own 5 Pals with Musclehead · rank 2"],
    ["Legs for Days", "Own 5 Pals with Runner · rank 3"],
    ["Etsy Shop", "Own 5 Pals with Artisan · rank 3"],
    ["Zoomies", "Own 5 Pals with Swift · rank 4"],
    ["Professional Gambler", "Own 5 Lucky Pals · rank 4"]] },
  { name: "Paldeck", track: "S", tint: "--r3", tiles: [
    ["Starter Pack", "Register 25 Pals in your Paldeck"],
    ["Ball Is Life", "Register 50 Pals in your Paldeck"],
    ["Sphere Pressure", "Register 75 Pals in your Paldeck"],
    ["Century Club", "Register 100 Pals in your Paldeck"],
    ["Pal Hoarder", "Register 125 Pals in your Paldeck"],
    ["Touch Grass Later", "Register 150 Pals in your Paldeck"]] },
  { name: "Field alphas", short: "Alphas", track: "D", tint: "--r4", tiles: [
    ["Chill Pill", "Capture alpha Chillet · Lv 11"],
    ["Bushi Whacked", "Capture alpha Bushi · Lv 25"],
    ["Elphi on the Shelf", "Capture alpha Elphidran · ~Lv 30"],
    ["Mammoth Task", "Capture alpha Mammorest · Lv 38"],
    ["Hot Property", "Capture alpha Blazamut · Lv 49"],
    ["Big Fish Energy", "Capture alpha Jormuntide · Lv 55"]] },
  { name: "Bounties", track: "D", tint: "--r5", tiles: [
    ["Scoot Free", "Defeat bounty Scoot · Lv 10"],
    ["Off the Grill", "Defeat bounty Grill · Lv 20"],
    ["Flare-well", "Defeat bounty Flare · Lv 38"],
    ["Skim Milk", "Defeat bounty Skim · Lv 42"],
    ["Clint-ical Hit", "Defeat bounty Clint · Lv 49"],
    ["Ram-shackled", "Defeat bounty Ram · Lv 59"]] },
  { name: "Wildcard", tint: "--r6", tiles: [
    ["Hunting Season", "Obtain a Predator Core", "D"],
    ["Crude Awakening", "Loot the Test Drilling Rig's big chest · Lv 30", "D"],
    ["Gold Digger", "Hold 1,000,000 gold at once", "S"],
    ["Condensed Milk", "Condense any Pal to 4 stars", "S"],
    ["Fade to Noir", "Defeat the Bellanoir raid", "D"],
    ["Helicopter Parent", "Have a Pal reach Lv 60", "D"]] },
];

// Flat lookup: lower-cased name -> {r, c, name, detail, danger, points}
export const TILES = new Map();
ROWS.forEach((row, r) => row.tiles.forEach(([name, detail, own], c) => {
  const track = own || row.track;
  TILES.set(name.toLowerCase(), { r, c, name, detail, danger: track === "D", points: row.pts ? row.pts[c] : TRACK[track][c] });
}));

export function findTile(name) {
  return TILES.get(String(name).trim().toLowerCase()) || null;
}

// Returns {total, points, bonus, tiles, lines, grid} for a list of tile names.
export function score(tileNames) {
  const grid = Array.from({ length: 6 }, () => Array(6).fill(false));
  let points = 0;
  for (const n of tileNames) {
    const t = findTile(n);
    if (t && !grid[t.r][t.c]) { grid[t.r][t.c] = true; points += t.points; }
  }
  const idx = [0, 1, 2, 3, 4, 5];
  let lines = 0, bonus = 0;
  for (const i of idx) {
    if (idx.every(c => grid[i][c])) { lines++; bonus += BONUS.row; }
    if (idx.every(r => grid[r][i])) { lines++; bonus += BONUS.col; }
  }
  if (idx.every(i => grid[i][i])) { lines++; bonus += BONUS.diag; }
  if (idx.every(i => grid[i][5 - i])) { lines++; bonus += BONUS.diag; }
  const tiles = grid.flat().filter(Boolean).length;
  return { total: points + bonus, points, bonus, tiles, lines, grid };
}

// Returns a list of human-readable problems with progress.json (empty = OK).
export function validate(progress) {
  const errors = [];
  if (!progress || !Array.isArray(progress.players)) return ['progress.json needs a "players" list.'];
  const seen = new Set();
  progress.players.forEach((p, i) => {
    const who = p && p.name ? `"${p.name}"` : `player #${i + 1}`;
    if (!p || typeof p.name !== "string" || !p.name.trim()) errors.push(`${who} has no name.`);
    else if (seen.has(p.name.toLowerCase())) errors.push(`${who} is listed twice.`);
    else seen.add(p.name.toLowerCase());
    if (!p || !Array.isArray(p.tiles)) { errors.push(`${who} needs a "tiles" list (it can be empty).`); return; }
    p.tiles.forEach(n => {
      if (!findTile(n)) errors.push(`${who} has an unknown tile "${n}". Check the spelling against the board.`);
    });
  });
  return errors;
}

// Players sorted by score; equal totals share a rank and are flagged as tied.
export function standings(progress) {
  const list = progress.players
    .map(p => ({ ...p, restarts: p.restarts || 0, ...score(p.tiles) }))
    .sort((a, b) => b.total - a.total || b.tiles - a.tiles || a.name.localeCompare(b.name));
  list.forEach((p, i) => {
    p.rank = i > 0 && list[i - 1].total === p.total ? list[i - 1].rank : i + 1;
  });
  list.forEach(p => { p.tied = p.total > 0 && list.filter(q => q.total === p.total).length > 1; });
  return list;
}

// Playtime for one player from playtime.json (written by the player clock), or null if unknown.
// Returns {played, left, budget, out} in minutes.
export function playtimeFor(playtime, name) {
  if (!playtime || !playtime.budget_minutes) return null;
  const key = Object.keys(playtime.players || {}).find(k => k.toLowerCase() === String(name).toLowerCase());
  const p = key ? playtime.players[key] : {};
  const budget = playtime.budget_minutes, played = Math.min(budget, p.played_minutes || 0);
  return { played, left: p.out ? 0 : budget - played, budget, out: Boolean(p.out) };
}

export function formatMinutes(m) {
  return `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m`;
}
