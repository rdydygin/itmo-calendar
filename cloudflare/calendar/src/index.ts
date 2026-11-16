// Cloudflare Worker port of src/ (Flask app): ISU login -> personal schedule -> iCalendar feed.
// The last good calendar is kept in KV: requests within FRESH_MS are served from it, and if ITMO
// is down the stale copy is served instead of an error.

interface Env {
  ISU_USERNAME: string;
  ISU_PASSWORD: string;
  CALENDAR_TOKEN: string;
  CACHE: KVNamespace;
}

interface RawLesson {
  date: string;
  time_start: string;
  time_end: string;
  subject: string;
  type: string;
  [key: string]: unknown;
}

const CLIENT_ID = "student-personal-cabinet";
const REDIRECT_URI = "https://my.itmo.ru/login/callback";
const PROVIDER = "https://id.itmo.ru/auth/realms/itmo";
const API_BASE_URL = "https://my.itmo.ru/api";
const UA = "Mozilla/5.0 (compatible; my-itmo-ru-to-ical)";
const FRESH_MS = 30 * 60 * 1000;

// ---------- auth (src/auth.py) ----------

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function htmlUnescape(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const LOGIN_ACTION_RE = new RegExp(
  `"loginAction":\\s*"(${PROVIDER.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}[^"]*)"`,
);

async function getAccessToken(username: string, password: string): Promise<string> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(40))).replace(/[^a-zA-Z0-9]+/g, "");
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

  const authUrl = new URL(PROVIDER + "/protocol/openid-connect/auth");
  authUrl.search = new URLSearchParams({
    protocol: "oauth2",
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid",
    state: "im_not_a_browser",
    code_challenge_method: "S256",
    code_challenge: challenge,
  }).toString();
  const authResp = await fetch(authUrl, { headers: { "User-Agent": UA } });
  if (!authResp.ok) throw new Error(`ITMO auth page: HTTP ${authResp.status}`);
  const match = (await authResp.text()).match(LOGIN_ACTION_RE);
  if (!match) throw new Error("Keycloak loginAction not found on ITMO auth page");
  const formAction = htmlUnescape(match[1]);
  const cookies = authResp.headers
    .getSetCookie()
    .map((c) => c.split(";", 1)[0])
    .join("; ");

  const formResp = await fetch(formAction, {
    method: "POST",
    redirect: "manual",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies },
    body: new URLSearchParams({ username, password }),
  });
  if (formResp.status !== 302) {
    throw new Error(`ITMO login failed (HTTP ${formResp.status}); check credentials or interactive login requirements`);
  }
  const code = new URL(formResp.headers.get("Location") ?? "", formAction).searchParams.get("code");
  if (!code) throw new Error("ITMO login redirect has no code");

  const tokenResp = await fetch(PROVIDER + "/protocol/openid-connect/token", {
    method: "POST",
    redirect: "manual",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code,
      code_verifier: verifier,
    }),
  });
  if (!tokenResp.ok) throw new Error(`ITMO token exchange: HTTP ${tokenResp.status}`);
  const token = ((await tokenResp.json()) as { access_token?: string }).access_token;
  if (!token) throw new Error("ITMO token response has no access_token");
  return token;
}

// ---------- schedule API (src/main_api.py) ----------

async function getRawLessons(token: string): Promise<RawLesson[]> {
  const today = new Date();
  const year = today.getUTCFullYear();
  const termStart = today.getUTCMonth() < 7 ? year - 1 : year; // before Aug 1 -> previous academic year
  const url = new URL(API_BASE_URL + "/schedule/schedule/personal");
  url.search = new URLSearchParams({ date_start: `${termStart}-08-01`, date_end: `${termStart + 1}-07-31` }).toString();

  const resp = await fetch(url, { headers: { "User-Agent": UA, Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`ITMO schedule API: HTTP ${resp.status}`);
  const days = ((await resp.json()) as { data: { date: string; lessons: Omit<RawLesson, "date">[] }[] }).data;
  return days.flatMap((day) => day.lessons.map((lesson) => ({ date: day.date, ...lesson }) as RawLesson));
}

// ---------- lesson -> event (src/lessons_to_events.py) ----------

const LESSON_TYPE_TAGS: Record<string, string> = {
  "Лекции": "Лек",
  "Практические занятия": "Прак",
  "Лабораторные занятия": "Лаб",
  "Занятия спортом": "Спорт",
};

const DESCRIPTION_FIELDS: [string, string][] = [
  ["group", "Группа"],
  ["teacher_name", "Преподаватель"],
  ["teacher_fio", "Преподаватель"],
  ["zoom_url", "Ссылка на Zoom"],
  ["zoom_password", "Пароль Zoom"],
  ["zoom_info", "Доп. информация для Zoom"],
  ["note", "Примечание"],
];

function description(lesson: RawLesson, updatedMsk: string): string {
  const lines = DESCRIPTION_FIELDS.filter(([key]) => lesson[key]).map(([key, name]) => `${name}: ${lesson[key]}`);
  lines.push(`Обновлено: ${updatedMsk} MSK`);
  return lines.join("\n");
}

function location(lesson: RawLesson): string | null {
  const place = [lesson.room, lesson.building].filter(Boolean).join(", ");
  if (lesson.zoom_url) return place ? `Zoom / ${place}` : "Zoom";
  return place || null;
}

// Same UID as the Python version: UUID formatted md5 of "date, time_start, subject".
async function uid(lesson: RawLesson): Promise<string> {
  const data = new TextEncoder().encode(`${lesson.date}, ${lesson.time_start}, ${lesson.subject}`);
  const hex = [...new Uint8Array(await crypto.subtle.digest("MD5", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------- iCalendar serialization (RFC 5545) ----------

function icsDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // 20260901T060000Z
}

function icsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

const encoder = new TextEncoder();

// Fold to 75 octets per line without splitting UTF-8 characters.
function fold(line: string): string {
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + size > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

async function buildCalendar(lessons: RawLesson[]): Promise<string> {
  const now = Date.now();
  const updatedMsk = new Date(now + 3 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:my-itmo-ru-to-ical"];

  for (const lesson of lessons) {
    let begin = Date.parse(`${lesson.date}T${lesson.time_start}:00+03:00`);
    let end = Date.parse(`${lesson.date}T${lesson.time_end}:00+03:00`);
    if (begin > end) [begin, end] = [end, begin]; // mistakes in the source data
    const tag = LESSON_TYPE_TAGS[lesson.type] ?? lesson.type;
    const loc = location(lesson);

    lines.push(
      "BEGIN:VEVENT",
      `UID:${await uid(lesson)}`,
      `DTSTAMP:${icsDate(now)}`,
      `DTSTART:${icsDate(begin)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${icsText(`[${tag}] ${lesson.subject}`)}`,
      `DESCRIPTION:${icsText(description(lesson, updatedMsk))}`,
    );
    if (loc) lines.push(`LOCATION:${icsText(loc)}`);
    if (lesson.zoom_url) lines.push(`URL:${lesson.zoom_url}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// ---------- routing (src/app.py) ----------

async function refresh(env: Env, cacheKey: string): Promise<string> {
  const token = await getAccessToken(env.ISU_USERNAME, env.ISU_PASSWORD);
  const lessons = await getRawLessons(token);
  const ics = await buildCalendar(lessons);
  console.log(`Refreshed calendar: ${lessons.length} events`);
  try {
    await env.CACHE.put(cacheKey, ics, { metadata: { fetchedAt: Date.now() } });
  } catch (e) {
    console.error("Saving the calendar to KV failed:", e); // still serve the fresh calendar
  }
  return ics;
}

function icsResponse(ics: string, source: string): Response {
  return new Response(ics, {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store", "X-Calendar-Source": source },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.ISU_USERNAME || !env.ISU_PASSWORD || !env.CALENDAR_TOKEN) {
      return new Response("ISU_USERNAME / ISU_PASSWORD / CALENDAR_TOKEN secrets are not set", { status: 500 });
    }
    // The URL token is an independent random secret: deriving it from the password (as the Python
    // version does) would let anyone holding the link test password guesses offline.
    if (new URL(request.url).pathname !== "/calendar/" + env.CALENDAR_TOKEN) {
      return new Response("not found", { status: 404 });
    }

    // Keyed by the ISU account, so switching accounts never serves the previous account's calendar.
    const cacheKey = "ics:" + env.ISU_USERNAME;
    let cached: { value: string | null; metadata: { fetchedAt: number } | null } = { value: null, metadata: null };
    try {
      cached = await env.CACHE.getWithMetadata<{ fetchedAt: number }>(cacheKey);
    } catch (e) {
      console.error("Reading the calendar from KV failed:", e); // fall through to ITMO
    }
    if (cached.value && cached.metadata && Date.now() - cached.metadata.fetchedAt < FRESH_MS) {
      return icsResponse(cached.value, "cache");
    }

    try {
      return icsResponse(await refresh(env, cacheKey), "itmo");
    } catch (e) {
      console.error("Calendar refresh failed:", e);
      if (cached.value) return icsResponse(cached.value, "stale-cache");
      return new Response("Failed to fetch the schedule from ITMO", { status: 502 });
    }
  },
};
