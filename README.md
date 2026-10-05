# Palworld Hardcore Bingo standings

A static standings site (GitHub Pages) plus a pinned Discord message that updates itself.
Approve a screenshot in Discord, add the tile to `site/progress.json`, push, and both update in a couple of minutes.

## One-time setup

1. **Create the repo.** Push this folder to a new GitHub repository with `main` as the default branch.
2. **Turn on Pages.** Settings → Pages → Source: **GitHub Actions**.
3. **Make a Discord webhook.** In your leaderboard channel: Edit Channel → Integrations → Webhooks → New Webhook. Copy its URL.
4. **Add the secret and variables.** Settings → Secrets and variables → Actions:
   - Secret `DISCORD_WEBHOOK_URL`: the webhook URL.
   - Variable `SITE_URL`: your Pages URL, e.g. `https://<user>.github.io/<repo>/`.
5. **Run it once.** Actions → Publish standings → Run workflow. The run summary shows the new message's ID.
6. **Save the message ID.** Add a variable `DISCORD_MESSAGE_ID` with that ID, then pin the message in Discord. From now on every run edits that message instead of posting a new one.

## Updating progress

The tile bot (below) does this when an admin reacts ✅ to a screenshot. To edit by hand (fixes,
`restarts`, removing a tile), edit `site/progress.json` (the GitHub web editor is fine) and commit to `main`:

```json
{ "name": "Alex", "restarts": 1, "tiles": ["Grizzly Situation", "Starter Pack", "Chill Pill"] }
```

- Players appear on the board by themselves after their first minute on the server (from the player
  clock's `site/playtime.json`). Add a player to `progress.json` when they get their first tile, using
  the name shown on the board; capitalisation doesn't matter.
- Tiles are listed by their title exactly as shown on the board (e.g. "Grizzly Situation", not "Zoe & Grizzbolt"). Capitalisation doesn't matter.
- `restarts` is how many times the player has died. It's shown on the leaderboard but doesn't affect the score.
- Set the real `start` and `end` times in `event` so the site shows "Day X of 14".
- A misspelled tile fails the run with a message naming the player and tile, so nothing wrong gets posted.

## Preview locally

```sh
npm install
npx playwright install chromium
npm run preview        # writes standings.png and prints the Discord embed, posts nothing
npx serve site         # or any static server, to view the site
```

## Changing the board

Tiles, points and line bonuses all live in `site/board.js`. The site and the Discord message both read from it, so a change there updates both.

## Player clock (40-hour budget)

`clock/player_clock.py` runs on the game server and gives each player 40 hours for the whole event.
It uses Palworld's official REST API: it counts minutes while each player is online, announces warnings
at 2 hours, 1 hour, 30, 10 and 1 minute left, then saves the world and kicks the player when time runs out.
Anyone who reconnects with no time left is kicked again. Before the start time, everyone is kicked so
nobody gets a head start. It also keeps a "Player clocks" message in Discord up to date.

Python 3.9+, no dependencies.

1. In `PalWorldSettings.ini` set `RESTAPIEnabled=True`, `RESTAPIPort=8212` and an `AdminPassword`.
   Keep port 8212 closed to the internet; the clock talks to it locally.
2. Copy `clock/clock_config.example.json` to `clock/clock_config.json` and set the event start and end.
   Put the admin password there or in the `PALWORLD_ADMIN_PASSWORD` environment variable.
3. Optional: set `discord_webhook_url` (it can be the same webhook as the leaderboard). The first run posts
   a message and prints its ID; pin it, and the clock edits it every 5 minutes after that.
4. Add your own Steam user ID to `exempt_userids` while testing before the event, then remove it.
5. Playtime on the standings: every `publish_minutes` (default 30) the clock writes `site/playtime.json`
   and commits and pushes it, so the clock must run from this repo on a PC that can `git push`. Set
   `publish_minutes` to 0 to turn it off. A new player is published as soon as they've played a full
   minute. Players appear under their Steam name, which stays the same across deaths (character names
   change). To show someone under another name, map their Steam name or user ID (shown by `status`) in
   `player_names`.
6. Run `python3 clock/player_clock.py run` and keep it running: `clock/palworld-clock.service` is a
   systemd example, or use Task Scheduler on Windows. Progress is saved every minute, so restarting the
   script loses nothing.

Admin commands, usable while the clock is running:

```sh
python3 clock/player_clock.py status           # everyone's used and remaining time
python3 clock/player_clock.py adjust Alex 30   # refund 30 minutes (e.g. after a server outage)
python3 clock/player_clock.py adjust Alex -15  # charge 15 minutes
```

Time is only counted while the server answers, so server downtime never costs anyone playtime.

## Tile bot (approve screenshots with ✅)

`bot/tile_bot.py` watches the tile screenshot channel. Players post a screenshot with the tile's title in
the same message, one tile per post. When an admin reacts ✅, the bot adds the tile to that player in
`site/progress.json`, pushes, and reacts 🎉. It replies once to posts it can't use (no title, two titles,
a poster it can't match to a board name) so the player can edit their post, and to duplicates.

Python 3.9+, no dependencies. Run it from this repo on the same PC as the clock.

1. Discord Developer Portal → New Application → **Bot**: copy the token and turn on
   **Message Content Intent**.
2. OAuth2 → URL Generator: scope `bot`; permissions View Channels, Read Message History, Send Messages
   and Add Reactions. Open the URL to invite the bot.
3. Copy `bot/bot_config.example.json` to `bot/bot_config.json` (git-ignored) and set `bot_token`,
   `channel_id` and `admin_ids` (Discord user IDs; turn on Developer Mode, then right-click → Copy ID).
4. `players` maps Discord user IDs to board names. Anyone whose Discord display name or username already
   matches a board name works without it.
5. `python bot/tile_bot.py check` prints what it would do without changing anything. Then run
   `python bot/tile_bot.py run` and keep it running.

Admins can't approve their own posts. Removing a ✅ doesn't remove a tile; edit `progress.json` for that.
