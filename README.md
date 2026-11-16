# ITMO schedule to iCalendar converter

A Cloudflare Worker that exports your personal schedule from [my.itmo.ru](https://my.itmo.ru)
as an iCalendar feed. Subscribe to the URL in Google Calendar, Apple Calendar, or another
calendar app to receive schedule updates.

The Worker uses ISU credentials stored as Cloudflare secrets and keeps the last successful
calendar in Workers KV. Event UIDs are preserved when migrating from an older installation.

## Deploy

You need [Bun](https://bun.sh), [Node.js 24 or newer](https://nodejs.org) to run Wrangler,
and a Cloudflare account. Run these commands from the repository root:

```bash
bun install --frozen-lockfile
bun run wrangler login
```

The KV namespace in [wrangler.jsonc](wrangler.jsonc) belongs to the existing deployment.
For a new Cloudflare account, create a namespace and replace its `id` in `wrangler.jsonc`:

```bash
bun run wrangler kv namespace create CACHE
```

Deploy the Worker, then set its three secrets:

```bash
bun run deploy
bun run wrangler secret put ISU_USERNAME
bun run wrangler secret put ISU_PASSWORD
TOKEN=$(openssl rand -hex 32)
printf '%s' "$TOKEN" | bun run wrangler secret put CALENDAR_TOKEN
printf 'Calendar token: %s\n' "$TOKEN"
```

The calendar is available once all three secrets are set:

```text
https://itmo-calendar.<your-subdomain>.workers.dev/calendar/<CALENDAR_TOKEN>
```

Open the URL first to check that it downloads an `.ics` file. In Google Calendar, choose
**Other calendars → + → From URL** to subscribe. Calendar apps choose their own refresh
interval; importing the file once does not subscribe to updates.

The URL token is a random secret, independent of your ISU password. Anyone with the link
can read the calendar. If it leaks, change `CALENDAR_TOKEN` and resubscribe. Changing ISU
credentials alone does not change the URL.

## Caching

- A calendar fetched less than 30 minutes ago is served from KV.
- Otherwise, the Worker fetches a fresh calendar from ITMO.
- If ITMO fails, the last successful calendar is served. With no cached calendar, the Worker returns HTTP 502.

The `X-Calendar-Source` response header is `cache`, `itmo`, or `stale-cache`, respectively.

## Local development

```bash
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
```

Set `ISU_USERNAME`, `ISU_PASSWORD`, and a random `CALENDAR_TOKEN` in `.dev.vars`, then run:

```bash
bun run dev
```

Visit `http://localhost:8787/calendar/<CALENDAR_TOKEN>`. Local development uses local KV;
it does not read or write the production cache. `.dev.vars` is ignored by Git.

```bash
bun run check   # formatting and strict TypeScript checks, with generated Workers types
bun run build   # bundle the Worker without deploying or requiring Cloudflare credentials
bun run format  # format source, configuration, and documentation
```

Workers runtime and binding types are generated from `wrangler.jsonc` before each type check,
following [Cloudflare's TypeScript guidance](https://developers.cloudflare.com/workers/languages/typescript/).
Generated types, local state, dependencies, and build output are ignored by Git.

## CI and automatic deployment

Pull requests run formatting, TypeScript checks, and a Wrangler dry-run build using the
committed Bun lockfile. Pushes to `main` run the same checks, then deploy the Worker.

Configure these GitHub Actions repository secrets before using automatic deployment:

- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with Workers deployment permissions
  (the **Edit Cloudflare Workers** template).
- `CLOUDFLARE_ACCOUNT_ID`: the account ID containing the Worker and its KV namespace.

See [Cloudflare's GitHub Actions setup](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
for authentication details. `ISU_USERNAME`, `ISU_PASSWORD`, and `CALENDAR_TOKEN` remain Worker
secrets set with Wrangler; CI does not need their values.

## Operations

View logs with `bun run wrangler tail` or in the Cloudflare dashboard under **Workers →
itmo-calendar → Logs**. The schedule API covers the current academic year, August through July.
Lesson times are converted from Moscow time to UTC; calendar apps display them in their own time zone.
