#!/usr/bin/env python3
"""
Palworld Hardcore Bingo: player clock.

Gives every player a fixed playtime budget for the whole event (40 hours by
default) and enforces it through the dedicated server's official REST API:
counts minutes while players are online, warns them as time runs low, then
saves the world and kicks them when their budget is spent. Players who
reconnect with no time left are kicked again straight away.

Runs on the same machine as the server. Python 3.9+, standard library only.

Usage:
  python3 player_clock.py run                     # the long-running clock
  python3 player_clock.py status                  # print everyone's time
  python3 player_clock.py adjust <name> <minutes> # e.g. adjust Alex 30  (refund)
                                                  #      adjust Alex -15 (charge)
"""

import base64
import json
import math
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
PLAYTIME_PATH = REPO / "site" / "playtime.json"
OUT_OF_TIME = "You have run out of play-time."
KICK_DELAY_SECONDS = 5  # time to read the chat message before the kick
CONFIG_PATH = Path(os.environ.get("CLOCK_CONFIG", HERE / "clock_config.json"))


# ---------------------------------------------------------------- config / state

def load_config():
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    cfg.setdefault("api_url", "http://127.0.0.1:8212")
    cfg.setdefault("budget_hours", 40)
    cfg.setdefault("poll_seconds", 15)
    cfg.setdefault("warn_minutes", [120, 60, 30, 10, 1])
    cfg.setdefault("state_file", "clock_state.json")
    cfg.setdefault("adjust_file", "clock_adjustments.jsonl")
    cfg.setdefault("enforce_start", True)
    cfg.setdefault("exempt_userids", [])
    cfg.setdefault("discord_update_minutes", 5)
    cfg.setdefault("publish_minutes", 30)
    cfg.setdefault("player_names", {})
    cfg["admin_password"] = os.environ.get("PALWORLD_ADMIN_PASSWORD", cfg.get("admin_password", ""))
    cfg["discord_webhook_url"] = os.environ.get("CLOCK_DISCORD_WEBHOOK_URL", cfg.get("discord_webhook_url", ""))
    for key in ("state_file", "adjust_file"):
        p = Path(cfg[key])
        cfg[key] = p if p.is_absolute() else HERE / p
    cfg["start_ts"] = parse_time(cfg.get("event_start"))
    cfg["end_ts"] = parse_time(cfg.get("event_end"))
    if not cfg["admin_password"]:
        sys.exit("No admin password. Set PALWORLD_ADMIN_PASSWORD or admin_password in clock_config.json.")
    return cfg


def parse_time(value):
    if not value:
        return None
    return datetime.fromisoformat(value).timestamp()


def load_state(cfg):
    try:
        return json.loads(cfg["state_file"].read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"players": {}, "discord_message_id": None}


def save_state(cfg, state):
    tmp = cfg["state_file"].with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    tmp.replace(cfg["state_file"])  # atomic, so a crash never leaves a half-written file


def budget_seconds(cfg):
    return cfg["budget_hours"] * 3600


def remaining(cfg, rec):
    return max(0, budget_seconds(cfg) - rec["used_seconds"])


def fmt(seconds):
    m = math.ceil(seconds / 60)  # round up, so 59 seconds left reads "0h 01m", not "0h 00m"
    return f"{m // 60}h {m % 60:02d}m"


def log(msg):
    print(f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  {msg}", flush=True)


# ---------------------------------------------------------------- REST API

class Api:
    def __init__(self, cfg):
        self.base = cfg["api_url"].rstrip("/") + "/v1/api"
        token = base64.b64encode(f"admin:{cfg['admin_password']}".encode()).decode()
        self.headers = {"Authorization": f"Basic {token}", "Content-Type": "application/json"}

    def _call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=self.headers)
        with urllib.request.urlopen(req, timeout=10) as res:
            raw = res.read()
            return json.loads(raw) if raw.strip() else None

    def players(self):
        return (self._call("GET", "/players") or {}).get("players", [])

    def announce(self, message):
        self._call("POST", "/announce", {"message": message})

    def kick(self, userid, message):
        self._call("POST", "/kick", {"userid": userid, "message": message})

    def save(self):
        self._call("POST", "/save")


# ---------------------------------------------------------------- Discord

def post_discord(cfg, state):
    url = cfg["discord_webhook_url"]
    if not url:
        return
    rows = sorted(state["players"].values(), key=lambda r: remaining(cfg, r), reverse=True)
    lines = []
    for r in rows:
        left = remaining(cfg, r)
        filled = round(10 * left / budget_seconds(cfg))
        bar = "▰" * filled + "▱" * (10 - filled)
        lines.append(f"`{bar}` **{r['name']}**: {fmt(left) if left else 'out of time'}")
    embed = {
        "title": "Player clocks",
        "description": "\n".join(lines) or "Nobody has played yet.",
        "color": 0xC9961A,
        "footer": {"text": f"{cfg['budget_hours']} hours each for the whole event · Updated"},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    body = json.dumps({"embeds": [embed], "allowed_mentions": {"parse": []}}).encode()
    base = url.rstrip("/")
    msg_id = cfg.get("discord_message_id") or state.get("discord_message_id")
    method, target = ("PATCH", f"{base}/messages/{msg_id}") if msg_id else ("POST", f"{base}?wait=true")
    req = urllib.request.Request(target, data=body, method=method,
                                 headers={"Content-Type": "application/json", "User-Agent": "palworld-bingo-clock"})
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            if not msg_id:
                state["discord_message_id"] = json.loads(res.read())["id"]
                log(f"Posted the player clock message in Discord ({state['discord_message_id']}). Pin it.")
    except urllib.error.HTTPError as e:
        log(f"Discord update failed ({e.code}). If the message was deleted, clear discord_message_id in the state file.")
    except OSError as e:
        log(f"Discord update failed: {e}")


# ---------------------------------------------------------------- standings site

def bingo_name(cfg, uid, rec):
    """The player's name on the bingo board: from player_names (by userid or
    in-game name), else the in-game name itself."""
    names = {k.lower(): v for k, v in cfg["player_names"].items()}
    return names.get(uid.lower()) or names.get(rec["name"].lower()) or rec["name"]


def publish_playtime(cfg, state):
    """Write site/playtime.json and push it, so the site and the Discord
    leaderboard show playtime. Only pushes when someone's minutes changed."""
    players = {}
    for uid, rec in state["players"].items():
        name = bingo_name(cfg, uid, rec)
        entry = players.setdefault(name, {"played_minutes": 0, "out": False})
        entry["played_minutes"] += int(rec["used_seconds"] // 60)
        entry["out"] = entry["out"] or rec["exhausted"]
    # Players join the standings after their first full minute.
    players = {name: p for name, p in players.items() if p["played_minutes"] >= 1}
    data ={"budget_minutes": int(cfg["budget_hours"] * 60), "players": dict(sorted(players.items()))}
    if data == state.get("published_playtime"):
        return
    PLAYTIME_PATH.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    rel = PLAYTIME_PATH.relative_to(REPO).as_posix()
    steps = [["git", "pull", "--rebase", "--autostash"], ["git", "push"]]
    # Commit only if the file differs from the last commit (it may already be committed but unpushed).
    if subprocess.run(["git", "diff", "--quiet", "HEAD", "--", rel], cwd=REPO).returncode != 0:
        steps.insert(0, ["git", "commit", "-m", "Update playtime", "--", rel])
    for cmd in steps:
        try:
            res = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=120)
        except (OSError, subprocess.TimeoutExpired) as e:
            log(f"Playtime push failed at '{' '.join(cmd[:2])}': {e}")
            return
        if res.returncode != 0:
            log(f"Playtime push failed at '{' '.join(cmd[:2])}': {(res.stderr or res.stdout).strip()}")
            return
    state["published_playtime"] = data  # saved with the clock state; failures retry next time
    log("Pushed updated playtime to the standings site.")


# ---------------------------------------------------------------- the clock

def apply_adjustments(cfg, state):
    path = cfg["adjust_file"]
    if not path.exists():
        return
    lines = path.read_text(encoding="utf-8").splitlines()
    path.unlink()
    for line in lines:
        if not line.strip():
            continue
        adj = json.loads(line)
        rec = find_record(state, adj["who"])
        if not rec:
            log(f"Adjustment skipped: no player matching {adj['who']!r} has been seen yet.")
            continue
        rec["used_seconds"] = max(0, rec["used_seconds"] - adj["minutes"] * 60)
        if remaining(cfg, rec) > 0:
            rec["exhausted"] = False
            rec["warned"] = [w for w in rec["warned"] if w * 60 >= remaining(cfg, rec)]
        verb = "refunded" if adj["minutes"] >= 0 else "charged"
        log(f"{rec['name']} {verb} {abs(adj['minutes'])} min; {fmt(remaining(cfg, rec))} left.")


def find_record(state, who):
    who = who.lower()
    for uid, rec in state["players"].items():
        if uid.lower() == who or rec["name"].lower() == who:
            return rec
    return None


def tick(cfg, api, state, prev_online, dt, now):
    """One poll. Returns the set of userids online now."""
    try:
        online = api.players()
    except (urllib.error.URLError, OSError, ValueError) as e:
        log(f"Server API unreachable ({e}); not counting this minute.")
        return set()

    in_event = (cfg["start_ts"] is None or now >= cfg["start_ts"]) and (cfg["end_ts"] is None or now < cfg["end_ts"])
    before_start = cfg["start_ts"] is not None and now < cfg["start_ts"]
    seen = set()
    exhausted_now = []
    rekick = []  # out of time already, but rejoined

    for p in online:
        uid, name = p.get("userId"), p.get("name") or p.get("accountName") or "Unknown"
        if not uid or uid in cfg["exempt_userids"]:
            continue
        seen.add(uid)

        if before_start and cfg["enforce_start"]:
            start = datetime.fromtimestamp(cfg["start_ts"]).strftime("%a %d %b %H:%M")
            try_kick(api, uid, name, f"The event hasn't started yet. Everyone starts together at {start}.")
            continue

        rec = state["players"].setdefault(uid, {"name": name, "used_seconds": 0, "warned": [], "exhausted": False})
        rec["name"] = name
        if not in_event:
            continue

        if rec["exhausted"] or remaining(cfg, rec) <= 0:
            if not rec["exhausted"]:
                exhausted_now.append((uid, rec))
            else:
                rekick.append((uid, name))
            continue

        # Only count players seen on the previous poll too, so a join is never
        # charged for time before it happened (at most a minute in their favour).
        if uid in prev_online:
            rec["used_seconds"] += dt

        left = remaining(cfg, rec)
        crossed = [w for w in cfg["warn_minutes"] if left <= w * 60 and w not in rec["warned"]]
        if crossed:
            rec["warned"].extend(crossed)  # one announcement even if several thresholds were passed at once
            if left > 0:
                try_announce(api, f"{name}: {fmt(left)} of playtime left. Get somewhere safe before it runs out.")
                log(f"Warned {name}: {fmt(left)} left.")
        if left <= 0:
            exhausted_now.append((uid, rec))

    if exhausted_now:
        try:
            api.save()
        except (urllib.error.URLError, OSError) as e:
            log(f"World save before kick failed: {e}")
        for uid, rec in exhausted_now:
            rec["exhausted"] = True
            log(f"{rec['name']} is out of time and was kicked.")
    for uid, name in rekick:
        log(f"{name} rejoined with no time left and was kicked again.")
    kick_out_of_time(api, [(uid, rec["name"]) for uid, rec in exhausted_now] + rekick)
    return seen


def kick_out_of_time(api, players):
    """The game client shows any kick as "connection lost" and never displays the
    kick reason, so say it in chat first and give players a moment to read it."""
    if not players:
        return
    for _, name in players:
        try_announce(api, f"{name}: {OUT_OF_TIME[0].lower()}{OUT_OF_TIME[1:]}")
    time.sleep(KICK_DELAY_SECONDS)
    for uid, name in players:
        try_kick(api, uid, name, OUT_OF_TIME)


def try_kick(api, uid, name, message):
    try:
        api.kick(uid, message)
    except (urllib.error.URLError, OSError) as e:
        log(f"Couldn't kick {name}: {e}")


def try_announce(api, message):
    try:
        api.announce(message)
    except (urllib.error.URLError, OSError) as e:
        log(f"Couldn't announce: {e}")


def run():
    cfg = load_config()
    api = Api(cfg)
    state = load_state(cfg)
    interval = cfg["poll_seconds"]
    log(f"Player clock running: {cfg['budget_hours']}h budget, polling every {interval}s.")
    prev_online, last = set(), time.monotonic()
    last_discord = last_publish = 0.0
    while True:
        now_mono = time.monotonic()
        dt = now_mono - last
        if dt > 3 * interval:  # script was paused or the machine slept: don't bill the gap
            dt = interval
        last = now_mono
        apply_adjustments(cfg, state)
        prev_online = tick(cfg, api, state, prev_online, dt, time.time())
        if now_mono - last_discord >= cfg["discord_update_minutes"] * 60:
            post_discord(cfg, state)
            last_discord = now_mono
        save_state(cfg, state)
        if cfg["publish_minutes"] and now_mono - last_publish >= cfg["publish_minutes"] * 60:
            publish_playtime(cfg, state)
            last_publish = now_mono
        time.sleep(max(1, interval - (time.monotonic() - now_mono)))


def status():
    cfg = load_config()
    state = load_state(cfg)
    rows = sorted(state["players"].items(), key=lambda kv: remaining(cfg, kv[1]))
    if not rows:
        print("No players have been seen yet.")
    for uid, r in rows:
        print(f"{r['name']:<20} board: {bingo_name(cfg, uid, r):<18} used {fmt(r['used_seconds']):>8}"
              f"   left {fmt(remaining(cfg, r)):>8}   {uid}" + ("   OUT OF TIME" if r["exhausted"] else ""))


def adjust(who, minutes):
    cfg = load_config()
    with open(cfg["adjust_file"], "a", encoding="utf-8") as f:
        f.write(json.dumps({"who": who, "minutes": minutes}) + "\n")
    print(f"Queued: {'refund' if minutes >= 0 else 'charge'} {abs(minutes)} min for {who}. "
          "The running clock applies it within one poll.")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "run":
        run()
    elif cmd == "status":
        status()
    elif cmd == "adjust" and len(sys.argv) == 4:
        adjust(sys.argv[2], float(sys.argv[3]))
    else:
        sys.exit(__doc__)
