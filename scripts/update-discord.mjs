// Renders the standings as an image and posts or edits the Discord leaderboard message.
//
// Environment:
//   DISCORD_WEBHOOK_URL  (required unless DRY_RUN=1) the channel webhook URL
//   DISCORD_MESSAGE_ID   (optional) the message to edit; leave empty on the first run
//   SITE_URL             (optional) the public site, linked from the embed
//   DISCORD_BOARD_WEBHOOK_URL  (optional) where to post the full tile board; defaults to DISCORD_WEBHOOK_URL
//   DISCORD_BOARD_MESSAGE_ID   (optional) the board message to edit; leave empty on the first run
//   DRY_RUN=1            render standings.png and board.png and print the embeds without posting

import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { validate, standings, allPlayers, playtimeFor, playtimeTier, formatMinutes } from "../site/board.js";

const SITE_DIR = fileURLToPath(new URL("../site/", import.meta.url));
const { DISCORD_WEBHOOK_URL, DISCORD_MESSAGE_ID, SITE_URL, DRY_RUN } = process.env;
const BOARD_WEBHOOK_URL = process.env.DISCORD_BOARD_WEBHOOK_URL || DISCORD_WEBHOOK_URL;
const { DISCORD_BOARD_MESSAGE_ID } = process.env;

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

let png, boardPng;
const browser = await chromium.launch();
try {
  const shoot = async (query, width) => {
    const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 2, colorScheme: "dark" });
    await page.goto(`http://127.0.0.1:${port}/?${query}`);
    await page.waitForSelector("body[data-ready='1']", { timeout: 30000 });
    return page.locator("#snapshot").screenshot({ type: "png" });
  };
  png = await shoot("snapshot", 1000);
  boardPng = await shoot("board", 1240);
} finally {
  await browser.close();
  server.close();
}

// Text leaderboard for the embed (readable even before the image loads).
let playtime = null;
try { playtime = JSON.parse(await readFile(join(SITE_DIR, "playtime.json"), "utf8")); } catch { /* optional */ }
const list = standings({ players: allPlayers(progress, playtime) });
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
  description: (lines.join("\n") || "No players yet. Players appear after their first minute on the server.") + (SITE_URL ? `\n\n[Open the full boards](${SITE_URL})` : ""),
  color: 0x2f7d4f,
  image: { url: "attachment://standings.png" },
  footer: { text: "Updated" },
  timestamp: new Date().toISOString(),
};
if (SITE_URL) embed.url = SITE_URL;

const boardEmbed = {
  title: "The board",
  description: "Every tile, its points and how many players have it. Post a clean screenshot in Discord " +
    "as soon as you finish a tile." + (SITE_URL ? `\n\n[Open the standings](${SITE_URL})` : ""),
  color: 0xc9961a,
  image: { url: "attachment://board.png" },
  footer: { text: "Updated" },
  timestamp: embed.timestamp,
};

if (DRY_RUN) {
  await writeFile("standings.png", png);
  await writeFile("board.png", boardPng);
  console.log(JSON.stringify([embed, boardEmbed], null, 2));
  console.log("Dry run: wrote standings.png and board.png and posted nothing.");
  process.exit(0);
}

if (!DISCORD_WEBHOOK_URL) {
  console.error("DISCORD_WEBHOOK_URL is not set. Add it as a repository secret.");
  process.exit(1);
}

// Posts a new message, or edits it when an ID is known. Returns false on failure.
async function send({ label, webhook, messageId, idVar, embed, file, image }) {
  const form = new FormData();
  form.append("payload_json", JSON.stringify({
    embeds: [embed],
    attachments: [{ id: 0, filename: file }],
    allowed_mentions: { parse: [] },
  }));
  form.append("files[0]", new Blob([image], { type: "image/png" }), file);

  const base = webhook.replace(/\/+$/, "");
  const url = messageId ? `${base}/messages/${messageId}` : `${base}?wait=true`;
  const res = await fetch(url, { method: messageId ? "PATCH" : "POST", body: form });
  if (!res.ok) {
    console.error(`Discord rejected the ${label} update (${res.status}): ${await res.text()}`);
    if (messageId && res.status === 404) {
      console.error(`The ${label} message wasn't found. Clear ${idVar} to post a fresh one.`);
    }
    return false;
  }
  if (messageId) {
    console.log(`Edited the ${label} message ${messageId}.`);
    return true;
  }
  const msg = await res.json();
  console.log(`Posted a new ${label} message: ${msg.id}`);
  console.log(`Save this ID as the ${idVar} repository variable so future runs edit it instead of posting again.`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY,
      `### New ${label} message posted\n\nSet the repository variable \`${idVar}\` to \`${msg.id}\`, then pin the message in Discord.\n`,
      { flag: "a" });
  }
  return true;
}

const ok = [
  await send({ label: "leaderboard", webhook: DISCORD_WEBHOOK_URL, messageId: DISCORD_MESSAGE_ID,
    idVar: "DISCORD_MESSAGE_ID", embed, file: "standings.png", image: png }),
  await send({ label: "board", webhook: BOARD_WEBHOOK_URL, messageId: DISCORD_BOARD_MESSAGE_ID,
    idVar: "DISCORD_BOARD_MESSAGE_ID", embed: boardEmbed, file: "board.png", image: boardPng }),
];
if (ok.includes(false)) process.exit(1);
