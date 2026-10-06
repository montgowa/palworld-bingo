#!/usr/bin/env python3
"""
Palworld Hardcore Bingo: tile bot.

Watches the tile screenshot channel in Discord. Players post a screenshot with the
tile's title in the same message ("Grizzly Situation"). When an admin reacts with
the approve emoji (✅), the bot adds that tile to the player's entry in
site/progress.json and pushes, so the site and the Discord leaderboard update.

It replies once to posts it can't use (no tile title, more than one, or a poster it
can't match to a board name) so the player can edit their message, and reacts 🎉
once a tile is on the board.

Runs on the same PC as the player clock, from this repo. Python 3.9+, standard
library only. It polls Discord's REST API, so it needs no gateway connection.

Usage:
  python bot/tile_bot.py run     # the long-running bot
  python bot/tile_bot.py check   # one pass that prints what it would do and changes nothing
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
PROGRESS_PATH = REPO / "site" / "progress.json"
PLAYTIME_PATH = REPO / "site" / "playtime.json"
BOARD_PATH = REPO / "site" / "board.js"
CONFIG_PATH = Path(os.environ.get("TILE_BOT_CONFIG", HERE / "bot_config.json"))
STATE_PATH = HERE / "bot_state.json"

API = "https://discord.com/api/v10"
DONE_EMOJI = "🎉"

# Names and emoji in log lines would crash a Windows console that isn't UTF-8.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def log(msg):
    print(f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  {msg}", flush=True)


# ---------------------------------------------------------------- config / state

def load_config():
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    cfg.setdefault("poll_seconds", 30)
    cfg.setdefault("approve_emoji", "✅")
    cfg.setdefault("admin_ids", [])
    cfg.setdefault("players", {})
    cfg["bot_token"] = os.environ.get("DISCORD_BOT_TOKEN", cfg.get("bot_token", ""))
    if not cfg["bot_token"] or not cfg.get("channel_id"):
        sys.exit("Set bot_token (or DISCORD_BOT_TOKEN) and channel_id in bot/bot_config.json.")
    if not cfg["admin_ids"]:
        sys.exit("Add at least one Discord user ID to admin_ids in bot/bot_config.json.")
    cfg["admin_ids"] = {str(i) for i in cfg["admin_ids"]}
    return cfg


def load_state():
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"done": {}, "replied": {}}


def save_state(state):
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    tmp.replace(STATE_PATH)


# ---------------------------------------------------------------- board

def squash(text):
    """Lower-case letters and digits only, so "ram shackled" matches "Ram-shackled"."""
    return re.sub(r"[^a-z0-9]", "", text.lower())


def tile_names():
    """Tile titles from site/board.js, the one place the board is defined."""
    names = re.findall(r'^\s*\["([^"]+)", "', BOARD_PATH.read_text(encoding="utf-8"), re.M)
    if len(names) != 36:
        sys.exit(f"Expected 36 tiles in site/board.js, found {len(names)}.")
    return names


def tiles_in(text, names):
    flat = squash(text)
    return [n for n in names if squash(n) in flat]


def board_names():
    """Names already on the board: players in progress.json and in playtime.json."""
    names = [p["name"] for p in json.loads(PROGRESS_PATH.read_text(encoding="utf-8")).get("players", [])]
    try:
        names += list(json.loads(PLAYTIME_PATH.read_text(encoding="utf-8")).get("players", {}))
    except (FileNotFoundError, ValueError):
        pass
    return names


def player_for(cfg, author):
    """The poster's board name: from the players map by Discord ID, else their Discord
    display name or username if it matches a name already on the board."""
    if author["id"] in cfg["players"]:
        return cfg["players"][author["id"]]
    known = {squash(n): n for n in board_names()}
    for candidate in (author.get("global_name"), author.get("username")):
        if candidate and squash(candidate) in known:
            return known[squash(candidate)]
    return None


def add_tile(player, tile):
    """Adds the tile to progress.json. Returns False if the player already has it."""
    data = json.loads(PROGRESS_PATH.read_text(encoding="utf-8"))
    players = data.setdefault("players", [])
    entry = next((p for p in players if p["name"].lower() == player.lower()), None)
    if entry is None:
        entry = {"name": player, "restarts": 0, "tiles": []}
        players.append(entry)
    if any(t.lower() == tile.lower() for t in entry["tiles"]):
        return False
    entry["tiles"].append(tile)
    PROGRESS_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return True


# ---------------------------------------------------------------- git

def git(*args):
    res = subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, timeout=120)
    return res.returncode == 0, (res.stderr or res.stdout).strip()


def commit(message):
    ok, out = git("commit", "-m", message, "--", PROGRESS_PATH.relative_to(REPO).as_posix())
    if not ok and "index.lock" in out:  # the player clock was committing at the same moment
        time.sleep(3)
        ok, out = git("commit", "-m", message, "--", PROGRESS_PATH.relative_to(REPO).as_posix())
    if not ok:
        log(f"Commit failed: {out}")
    return ok


def push_if_ahead(state):
    """Pushes the bot's tile commits. Called every pass while one is unpushed, so a failed
    push retries. The player clock pushes its own playtime commits; leaving those to it
    keeps the two from pushing over each other."""
    if not state.get("unpushed"):
        return
    ok, out = git("rev-list", "--count", "@{u}..HEAD")
    if ok and out == "0":  # the clock's push already carried it
        state["unpushed"] = False
        return
    for step in (("pull", "--rebase", "--autostash"), ("push",)):
        ok, out = git(*step)
        if not ok:
            log(f"Push failed at 'git {step[0]}': {out}")
            return
    state["unpushed"] = False
    log("Pushed approved tiles to the standings site.")


# ---------------------------------------------------------------- Discord

class Discord:
    def __init__(self, cfg):
        self.channel = str(cfg["channel_id"])
        self.headers = {
            "Authorization": f"Bot {cfg['bot_token']}",
            "User-Agent": "DiscordBot (https://github.com/montgowa/palworld-bingo, 1.0)",
            "Content-Type": "application/json",
        }

    def _call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        for _ in range(3):
            req = urllib.request.Request(API + path, data=data, method=method, headers=self.headers)
            try:
                with urllib.request.urlopen(req, timeout=15) as res:
                    raw = res.read()
                    return json.loads(raw) if raw.strip() else None
            except urllib.error.HTTPError as e:
                if e.code == 429:  # rate limited: wait as long as Discord asks
                    time.sleep(float(json.loads(e.read() or b"{}").get("retry_after", 2)) + 0.5)
                    continue
                raise
        raise RuntimeError(f"Still rate limited on {path}")

    def recent_messages(self):
        return self._call("GET", f"/channels/{self.channel}/messages?limit=100") or []

    def reactors(self, message_id, emoji):
        e = urllib.parse.quote(emoji)
        return self._call("GET", f"/channels/{self.channel}/messages/{message_id}/reactions/{e}?limit=100") or []

    def react(self, message_id, emoji):
        e = urllib.parse.quote(emoji)
        self._call("PUT", f"/channels/{self.channel}/messages/{message_id}/reactions/{e}/@me")

    def reply(self, message_id, text):
        self._call("POST", f"/channels/{self.channel}/messages", {
            "content": text,
            "message_reference": {"message_id": message_id, "fail_if_not_exists": False},
            "allowed_mentions": {"parse": []},
        })


def has_image(msg):
    return any((a.get("content_type") or "").startswith("image/")
               or a.get("filename", "").lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif"))
               for a in msg.get("attachments", []))


def has_reaction(msg, emoji):
    return any(r.get("emoji", {}).get("name") == emoji for r in msg.get("reactions", []))


# ---------------------------------------------------------------- one pass

def problem_with(cfg, msg, names):
    """Why a post can't be approved yet, or None. Also returns (player, tile) when it can."""
    found = tiles_in(msg.get("content", ""), names)
    if not found:
        return "I can't find a tile title in this post. Edit it to add the title, e.g. \"Grizzly Situation\".", None
    if len(found) > 1:
        return f"This post names {len(found)} tiles ({', '.join(found)}). Please post one tile per message.", None
    player = player_for(cfg, msg["author"])
    if not player:
        return ("I don't know which board name is yours yet. An admin needs to link your Discord account "
                "to your board name."), None
    return None, (player, found[0])


def run_pass(cfg, discord, state, names, dry_run=False):
    if not dry_run:
        push_if_ahead(state)
    approve = cfg["approve_emoji"]
    added = []  # (message id, player, tile)

    for msg in reversed(discord.recent_messages()):  # oldest first
        mid = msg["id"]
        if mid in state["done"] or msg["author"].get("bot") or not has_image(msg):
            continue

        problem, claim = problem_with(cfg, msg, names)
        if problem:
            if state["replied"].get(mid) != problem:
                log(f"Post {mid} by {msg['author'].get('username')}: {problem}")
                if not dry_run:
                    discord.reply(mid, problem)
                    state["replied"][mid] = problem
            continue

        player, tile = claim
        if not has_reaction(msg, approve):
            if dry_run:
                log(f"Post {mid}: {player} claims {tile}, waiting for approval.")
            continue
        approvers = [u["id"] for u in discord.reactors(mid, approve)
                     if u["id"] in cfg["admin_ids"] and u["id"] != msg["author"]["id"]]
        if not approvers:
            continue  # only the poster or non-admins reacted

        if dry_run:
            log(f"Post {mid}: would add {tile} to {player}.")
            continue
        if add_tile(player, tile):
            added.append((mid, player, tile))
        else:
            log(f"Post {mid}: {player} already has {tile}.")
            discord.reply(mid, f"{player} already has {tile} on the board.")
            state["done"][mid] = "duplicate"

    if added:
        summary = ", ".join(f"{p}: {t}" for _, p, t in added)
        if commit(f"Approve tiles: {summary}"):
            for mid, player, tile in added:
                state["done"][mid] = f"{player}: {tile}"
                log(f"Added {tile} to {player}.")
                try:
                    discord.react(mid, DONE_EMOJI)
                except (urllib.error.URLError, OSError) as e:
                    log(f"Couldn't react to {mid}: {e}")
            state["unpushed"] = True
            push_if_ahead(state)
        else:
            git("checkout", "--", PROGRESS_PATH.relative_to(REPO).as_posix())  # retry next pass


def run():
    cfg = load_config()
    discord = Discord(cfg)
    state = load_state()
    names = tile_names()
    log(f"Tile bot running: watching channel {discord.channel}, polling every {cfg['poll_seconds']}s.")
    while True:
        try:
            run_pass(cfg, discord, state, names)
        except (urllib.error.URLError, OSError, ValueError, RuntimeError) as e:
            log(f"Pass failed ({e}); trying again next poll.")
        save_state(state)
        time.sleep(cfg["poll_seconds"])


def check():
    cfg = load_config()
    discord = Discord(cfg)
    run_pass(cfg, discord, load_state(), tile_names(), dry_run=True)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "run":
        run()
    elif cmd == "check":
        check()
    else:
        sys.exit(__doc__)
