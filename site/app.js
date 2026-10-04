import { ROWS, TIERS, findTile, validate, standings, playtimeFor, playtimeTier, formatMinutes } from "./board.js";

const snapshot = new URLSearchParams(location.search).has("snapshot");
if (snapshot) document.body.classList.add("snapshot");

const $ = id => document.getElementById(id);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function getJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

function statusLine(event, builtAt) {
  const parts = [];
  if (event && event.start && event.end) {
    const now = Date.now(), start = Date.parse(event.start), end = Date.parse(event.end);
    const dayMs = 86400000, total = Math.round((end - start) / dayMs);
    if (now < start) parts.push(`Starts in <strong>${plural(Math.ceil((start - now) / dayMs), "day")}</strong>`);
    else if (now < end) parts.push(`<strong>Day ${Math.floor((now - start) / dayMs) + 1} of ${total}</strong>`);
    else parts.push("<strong>Event finished</strong>");
  }
  if (builtAt) {
    const t = new Date(builtAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    parts.push(`last updated ${t}`);
  }
  return parts.length ? parts.join(", ") + "." : "Standings update after each approved screenshot.";
}

function miniBoard(grid) {
  const el = document.createElement("div");
  el.className = "mini";
  el.setAttribute("aria-hidden", "true");
  grid.forEach((row, r) => row.forEach(on => {
    const i = document.createElement("i");
    rowColors(i, r);
    if (on) i.className = "on";
    el.appendChild(i);
  }));
  return el;
}

// Each row has a soft tint (--r1..6) and a bright accent (--a1..6) for completed tiles.
function rowColors(el, r) {
  el.style.setProperty("--tint", `var(${ROWS[r].tint})`);
  el.style.setProperty("--accent", `var(${ROWS[r].tint.replace("--r", "--a")})`);
}

// Cells that belong to a completed row, column or diagonal.
function lineCells(grid) {
  const idx = [0, 1, 2, 3, 4, 5], hit = new Set();
  const take = cells => { if (cells.every(([r, c]) => grid[r][c])) cells.forEach(([r, c]) => hit.add(r * 6 + c)); };
  idx.forEach(i => { take(idx.map(c => [i, c])); take(idx.map(r => [r, i])); });
  take(idx.map(i => [i, i]));
  take(idx.map(i => [i, 5 - i]));
  return hit;
}

function playtimeBar(t) {
  const el = document.createElement("div");
  el.className = "ptime";
  el.style.setProperty("--ptime", `var(${playtimeTier(t).color})`);
  el.innerHTML = `<div class="ptext"><span>Playtime</span><span><b></b> played · <b></b></span></div>` +
    `<div class="pbar"><i></i></div>`;
  const [played, left] = el.querySelectorAll("b");
  played.textContent = formatMinutes(t.played);
  left.textContent = t.out ? "out of time" : `${formatMinutes(t.left)} left`;
  el.querySelector("i").style.width = `${(100 * t.played / t.budget).toFixed(1)}%`;
  return el;
}

// Snapshot mode: one bingo card per player, laid out three across for Discord.
function renderCards(list) {
  const wrap = $("cards");
  wrap.textContent = "";
  list.forEach(p => {
    const card = document.createElement("article");
    card.className = "card" + (p.rank === 1 && p.total > 0 ? " lead" : "");
    card.innerHTML = `<header><span class="crank"></span><span class="cname"></span>` +
      `<span class="cscore"><b></b><span>points</span></span></header><div class="cmeta"></div><div class="cboard"></div>`;
    card.querySelector(".crank").textContent = p.rank;
    card.querySelector(".cname").textContent = p.name;
    card.querySelector(".cscore b").textContent = p.total;
    card.querySelector(".cmeta").textContent = `${plural(p.tiles, "tile")} · ${plural(p.lines, "line")}` +
      (p.restarts ? ` · ${plural(p.restarts, "restart")}` : "") + (p.tied ? " · tied" : "");

    const board = card.querySelector(".cboard");
    const lines = lineCells(p.grid);
    board.appendChild(Object.assign(document.createElement("span"), { className: "ch", textContent: "Lv" }));
    TIERS.forEach(t => board.appendChild(Object.assign(document.createElement("span"), { className: "ch", textContent: t.replace("Lv ", "") })));
    ROWS.forEach((row, r) => {
      board.appendChild(Object.assign(document.createElement("span"), { className: "rl", textContent: row.short || row.name }));
      row.tiles.forEach(([n], c) => {
        const cell = document.createElement("i");
        const on = p.grid[r][c];
        cell.className = "cell" + (on ? " on" : findTile(n).danger ? " skull" : "") + (lines.has(r * 6 + c) ? " line" : "");
        rowColors(cell, r);
        board.appendChild(cell);
      });
    });
    if (p.time) card.appendChild(playtimeBar(p.time));
    wrap.appendChild(card);
  });
}

function renderStandings(list, onSelect) {
  const ol = $("standings");
  ol.textContent = "";
  if (!list.length) {
    ol.innerHTML = '<li class="empty">No players yet. Add them to progress.json to start the board.</li>';
    return [];
  }
  return list.map(p => {
    const li = document.createElement("li");
    if (p.rank === 1 && p.total > 0) li.className = "lead";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "player";
    btn.setAttribute("aria-pressed", "false");

    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = p.rank;

    const who = document.createElement("span");
    who.className = "who";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = p.name;
    if (p.tied) {
      const tie = document.createElement("span");
      tie.className = "tie";
      tie.textContent = "Tied";
      name.appendChild(tie);
    }
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${plural(p.tiles, "tile")}, ${plural(p.lines, "line")}` +
      (p.restarts ? `, ${plural(p.restarts, "restart")}` : "") +
      (p.time ? `, ${p.time.left ? formatMinutes(p.time.left) + " playtime left" : "out of playtime"}` : "");
    who.append(name, meta);

    const score = document.createElement("span");
    score.className = "score";
    score.innerHTML = `<b>${p.total}</b><span>points</span>`;

    btn.append(rank, who, miniBoard(p.grid), score);
    btn.setAttribute("aria-label", `${p.name}, rank ${p.rank}, ${p.total} points, ${meta.textContent}`);
    btn.onclick = () => onSelect(p, btn);
    li.appendChild(btn);
    ol.appendChild(li);
    return { p, btn };
  });
}

function renderBoard(p) {
  const board = $("board");
  board.textContent = "";
  board.appendChild(Object.assign(document.createElement("div"), { className: "colhead" }));
  TIERS.forEach(t => board.appendChild(Object.assign(document.createElement("div"), { className: "colhead", textContent: t })));
  ROWS.forEach((row, r) => {
    board.appendChild(Object.assign(document.createElement("div"), { className: "rowlabel", textContent: row.name }));
    row.tiles.forEach(([n, d, own], c) => {
      const { danger, points: pts } = findTile(n);
      const done = p.grid[r][c];
      const tile = document.createElement("div");
      tile.className = "tile" + (done ? " done" : "");
      tile.style.background = `var(${row.tint})`;
      tile.setAttribute("role", "gridcell");
      tile.setAttribute("aria-label", `${n}, ${d}, ${pts} points${danger ? ", danger tile" : ""}, ${done ? "complete" : "not complete"}`);
      tile.innerHTML = `<div class="sphere" aria-hidden="true"><b>${pts}</b></div>` +
        `<div class="tname">${danger ? '<span class="skull">☠</span> ' : ""}</div><div class="tdetail"></div>`;
      tile.querySelector(".tname").append(n);
      tile.querySelector(".tdetail").textContent = d;
      board.appendChild(tile);
    });
  });
  $("detail-name").textContent = p.name;
  $("detail-meta").textContent = `${p.total} points: ${p.points} from tiles, ${p.bonus} from lines`;
  $("detail").hidden = false;
}

async function main() {
  let progress, built = null;
  try {
    progress = await getJSON("progress.json");
  } catch (e) {
    $("status").textContent = "The standings file couldn't be loaded. Check that progress.json is deployed next to this page.";
    return;
  }
  try { built = (await getJSON("build.json")).builtAt; } catch { /* optional */ }
  let playtime = null;
  try { playtime = await getJSON("playtime.json"); } catch { /* optional: written by the player clock */ }

  $("status").innerHTML = statusLine(progress.event, built);
  if (progress.event && progress.event.name) document.querySelector("h1").textContent = progress.event.name;

  const errors = validate(progress);
  if (errors.length) {
    const box = $("errors");
    box.className = "error";
    box.innerHTML = "<strong>progress.json has problems. Unknown tiles are ignored until they're fixed.</strong><ul></ul>";
    errors.forEach(msg => box.querySelector("ul").appendChild(Object.assign(document.createElement("li"), { textContent: msg })));
  }

  const list = standings({ players: (progress.players || []).filter(p => p && p.name && Array.isArray(p.tiles)) });
  list.forEach(p => { p.time = playtimeFor(playtime, p.name); });
  let current = null;
  const select = (p, btn) => {
    if (current) current.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-pressed", "true");
    current = btn;
    renderBoard(p);
    if (!snapshot) history.replaceState(null, "", "#" + encodeURIComponent(p.name));
  };
  const rows = renderStandings(list, select);
  if (snapshot) renderCards(list);

  if (!snapshot && rows.length) {
    const wanted = decodeURIComponent(location.hash.slice(1)).toLowerCase();
    const pick = rows.find(x => x.p.name.toLowerCase() === wanted) || rows[0];
    select(pick.p, pick.btn);
  }

  await document.fonts.ready;
  document.body.dataset.ready = "1";
}

main();
