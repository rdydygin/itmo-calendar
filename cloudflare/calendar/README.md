# ITMO calendar on Cloudflare Workers (free plan)

A TypeScript port of the Flask app in `src/`. It serves the same calendar with the same event UIDs,
so switching from the Docker version doesn't duplicate events.

The URL is `/calendar/<CALENDAR_TOKEN>`, where the token is a random secret. Unlike the Docker
version, it isn't derived from the ISU password, so a leaked link can't be used to guess the password.

The last good calendar is kept in Workers KV:

- if it is less than 30 minutes old, it's served straight away;
- otherwise the Worker fetches a fresh one from ITMO, which takes about 7 seconds;
- if ITMO fails, the old copy is served instead of an error.

The `X-Calendar-Source` response header shows which case happened: `cache`, `itmo` or `stale-cache`.

## Deploy

Needs [Bun](https://bun.sh) and a free Cloudflare account.

```bash
cd cloudflare/calendar
bunx wrangler login
bunx wrangler kv namespace create CACHE     # only for a new account: put the printed id into wrangler.jsonc
bunx wrangler deploy
bunx wrangler secret put ISU_USERNAME
bunx wrangler secret put ISU_PASSWORD
TOKEN=$(openssl rand -hex 32); printf '%s' "$TOKEN" | bunx wrangler secret put CALENDAR_TOKEN; echo "$TOKEN"
```

## Calendar URL

```
https://itmo-calendar.<your-subdomain>.workers.dev/calendar/<CALENDAR_TOKEN>
```

Open the URL in a browser first: a `.ics` file should download.
Then add it in Google Calendar: Other calendars → + → From URL.

The URL only changes when you change `CALENDAR_TOKEN`. If the link leaks, set a new token and
resubscribe; the ISU password doesn't need to change.

## Notes

- Logs: `bunx wrangler tail`, or Workers → itmo-calendar → Logs in the dashboard.
- The free plan allows 10 ms of CPU time per request. Waiting on ITMO doesn't count toward it.
  Building the calendar should fit within that limit; if requests fail with "exceeded CPU", check
  the CPU time in the dashboard.
- Free KV allows 1,000 writes a day. This Worker writes at most once every 30 minutes.
- In Russia, some internet providers slow down Cloudflare. Google Calendar fetches the feed from
  Google's servers, so it's unaffected. Apple Calendar on a device may fetch it directly.
