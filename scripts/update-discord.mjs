// Renders the standings as an image and posts or edits the Discord leaderboard message.
//
// Environment:
//   DISCORD_WEBHOOK_URL  (required unless DRY_RUN=1) the channel webhook URL
//   DISCORD_MESSAGE_ID   (optional) the message to edit; leave empty on the first run
//   SITE_URL             (optional) the public site, linked from the embed
//   DRY_RUN=1            render to standings.png and print the embed without posting

import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { validate, standings, playtimeFor, playtimeTier, formatMinutes } from "../site/board.js";

const SITE_DIR = fileURLToPath(new URL("../site/", import.meta.url));
const { DISCORD_WEBHOOK_URL, DISCORD_MESSAGE_ID, SITE_URL, DRY_RUN } = process.env;

const progress = JSON.parse(await readFile(join(SITE_DIR, "progress.json"), "utf8"));
const errors = validate(progress);
if (errors.length) {
  console.error("progress.json has problems, so nothing was posted:\n- " + errors.join("\n- "));
  process.exit(1);
}

// Serve the site locally so the page can fetch progress.json.
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
const server = http.createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "");
  if (path.startsWith("..")) return res.writeHead(404).end();
  const file = path && path !== "." ? path : "index.html";
  try {
    const body = await readFile(join(SITE_DIR, file));
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const { port } = server.address();

let png;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 2, colorScheme: "dark" });
  await page.goto(`http://127.0.0.1:${port}/?snapshot`);
  await page.waitForSelector("body[data-ready='1']", { timeout: 30000 });
  png = await page.locator("#snapshot").screenshot({ type: "png" });
} finally {
  await browser.close();
  server.close();
}

// Text leaderboard for the embed (readable even before the image loads).
const list = standings(progress);
let playtime = null;
try { playtime = JSON.parse(await readFile(join(SITE_DIR, "playtime.json"), "utf8")); } catch { /* optional */ }
const medal = r => ({ 1: "🥇", 2: "🥈", 3: "🥉" }[r] || `**${r}.**`);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const timeLeft = name => {
  const t = playtimeFor(playtime, name);
  return !t ? "" : ` · ${playtimeTier(t).emoji} ` + (t.left ? `${formatMinutes(t.left)} left` : "out of time");
};
const lines = list.map(p =>
  `${medal(p.rank)} **${p.name}**: ${p.total} pts (${plural(p.tiles, "tile")}, ${plural(p.lines, "line")}` +
  (p.restarts ? `, ${plural(p.restarts, "restart")}` : "") + ")" + (p.tied ? " *tied*" : "") + timeLeft(p.name));

const embed = {
  title: progress.event?.name || "Palworld Hardcore Bingo",
  description: (lines.join("\n") || "No players yet.") + (SITE_URL ? `\n\n[Open the full boards](${SITE_URL})` : ""),
  color: 0x2f7d4f,
  image: { url: "attachment://standings.png" },
  footer: { text: "Updated" },
  timestamp: new Date().toISOString(),
};
if (SITE_URL) embed.url = SITE_URL;

if (DRY_RUN) {
  await writeFile("standings.png", png);
  console.log(JSON.stringify(embed, null, 2));
  console.log("Dry run: wrote standings.png and posted nothing.");
  process.exit(0);
}

if (!DISCORD_WEBHOOK_URL) {
  console.error("DISCORD_WEBHOOK_URL is not set. Add it as a repository secret.");
  process.exit(1);
}

const form = new FormData();
form.append("payload_json", JSON.stringify({
  embeds: [embed],
  attachments: [{ id: 0, filename: "standings.png" }],
  allowed_mentions: { parse: [] },
}));
form.append("files[0]", new Blob([png], { type: "image/png" }), "standings.png");

const base = DISCORD_WEBHOOK_URL.replace(/\/+$/, "");
const editing = Boolean(DISCORD_MESSAGE_ID);
const url = editing ? `${base}/messages/${DISCORD_MESSAGE_ID}` : `${base}?wait=true`;
const res = await fetch(url, { method: editing ? "PATCH" : "POST", body: form });

if (!res.ok) {
  console.error(`Discord rejected the update (${res.status}): ${await res.text()}`);
  if (editing && res.status === 404) {
    console.error("The message wasn't found. Clear DISCORD_MESSAGE_ID to post a fresh one.");
  }
  process.exit(1);
}

if (editing) {
  console.log(`Edited Discord message ${DISCORD_MESSAGE_ID}.`);
} else {
  const msg = await res.json();
  console.log(`Posted a new leaderboard message: ${msg.id}`);
  console.log("Save this ID as the DISCORD_MESSAGE_ID repository variable so future runs edit it instead of posting again.");
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY,
      `### New leaderboard message posted\n\nSet the repository variable \`DISCORD_MESSAGE_ID\` to \`${msg.id}\`, then pin the message in Discord.\n`,
      { flag: "a" });
  }
}
