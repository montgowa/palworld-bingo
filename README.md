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

Edit `site/progress.json` (the GitHub web editor is fine) and commit to `main`:

```json
{ "name": "Alex", "restarts": 1, "tiles": ["Grizzly Situation", "Starter Pack", "Chill Pill"] }
```

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
5. Run `python3 clock/player_clock.py run` and keep it running: `clock/palworld-clock.service` is a
   systemd example, or use Task Scheduler on Windows. Progress is saved every minute, so restarting the
   script loses nothing.

Admin commands, usable while the clock is running:

```sh
python3 clock/player_clock.py status           # everyone's used and remaining time
python3 clock/player_clock.py adjust Alex 30   # refund 30 minutes (e.g. after a server outage)
python3 clock/player_clock.py adjust Alex -15  # charge 15 minutes
```

Time is only counted while the server answers, so server downtime never costs anyone playtime.
