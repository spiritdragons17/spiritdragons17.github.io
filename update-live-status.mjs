import fs from "node:fs/promises";

const INDEX_FILE = "index.html";
const OUTPUT_FILE = "live-status.json";

const EMPTY_STATUS = {
  isLive: false,
  platform: "",
  title: "",
  url: "",
};

function extractMembers(html) {
  const match = html.match(
    /const\s+DEFAULT_VTUBERS\s*=\s*(\[[\s\S]*?\]);\s*\/\*\s*State Management/
  );

  if (!match) {
    throw new Error("No se encontró DEFAULT_VTUBERS en index.html");
  }

  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`DEFAULT_VTUBERS no contiene JSON válido: ${error.message}`);
  }
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timeout);
  }
}

async function twitchToken() {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Faltan TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  });

  return fetchJson("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

async function updateTwitch(members) {
  const result = {};
  const logins = [
    ...new Set(
      members
        .map((member) => member.twitch)
        .filter(Boolean)
        .map((login) => login.trim().replace(/^@/, "").toLowerCase())
        .filter(Boolean)
    ),
  ];

  if (!logins.length) return result;

  const token = await twitchToken();

  const params = new URLSearchParams();
  for (const login of logins) {
    params.append("user_login", login);
  }

  const data = await fetchJson(`https://api.twitch.tv/helix/streams?${params}`, {
    headers: {
      "Client-Id": process.env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token.access_token}`,
    },
  });

  const liveByLogin = new Map(
    (data.data || []).map((stream) => [
      stream.user_login.toLowerCase(),
      stream,
    ])
  );

  for (const member of members) {
    if (!member.twitch) continue;

    const login = member.twitch.trim().replace(/^@/, "").toLowerCase();
    const stream = liveByLogin.get(login);

    if (stream) {
      result[member.id] = {
        isLive: true,
        platform: "twitch",
        title: stream.title || "",
        url: `https://twitch.tv/${stream.user_login}`,
      };
    }
  }

  return result;
}

async function updateYouTube(members) {
  const result = {};
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!apiKey) {
    throw new Error("Falta YOUTUBE_API_KEY");
  }

  for (const member of members) {
    if (!member.youtube) continue;

    const handle = member.youtube.trim().replace(/^@/, "");
    if (!handle) continue;

    const channelUrl =
      "https://www.googleapis.com/youtube/v3/channels?" +
      new URLSearchParams({
        part: "id",
        forHandle: `@${handle}`,
        key: apiKey,
      });

    const channelData = await fetchJson(channelUrl);
    const channelId = channelData.items?.[0]?.id;

    if (!channelId) {
      console.warn(`YouTube: no se encontró el canal @${handle}`);
      continue;
    }

    const liveUrl =
      "https://www.googleapis.com/youtube/v3/search?" +
      new URLSearchParams({
        part: "snippet",
        channelId,
        eventType: "live",
        type: "video",
        maxResults: "1",
        key: apiKey,
      });

    const liveData = await fetchJson(liveUrl);
    const live = liveData.items?.[0];

    if (live?.id?.videoId) {
      result[member.id] = {
        isLive: true,
        platform: "youtube",
        title: live.snippet?.title || "",
        url: `https://www.youtube.com/watch?v=${live.id.videoId}`,
      };
    }
  }

  return result;
}

async function readPreviousStatus() {
  try {
    const raw = await fs.readFile(OUTPUT_FILE, "utf8");
    const previous = JSON.parse(raw);

    if (previous && previous.members) {
      return previous;
    }
  } catch {
    // The first run is expected to have no previous file.
  }

  return null;
}

function statusEqual(a, b) {
  return (
    Boolean(a?.isLive) === Boolean(b?.isLive) &&
    (a?.platform || "") === (b?.platform || "") &&
    (a?.title || "") === (b?.title || "") &&
    (a?.url || "") === (b?.url || "")
  );
}

const html = await fs.readFile(INDEX_FILE, "utf8");
const members = extractMembers(html);
const previous = await readPreviousStatus();

const [twitch, youtube] = await Promise.all([
  updateTwitch(members),
  updateYouTube(members),
]);

const merged = {};

for (const member of members) {
  const liveStatus = twitch[member.id] || youtube[member.id];

  merged[member.id] = liveStatus
    ? liveStatus
    : { ...EMPTY_STATUS };
}

const previousMembers = previous?.members || {};
const changed = members.some(
  (member) => !statusEqual(previousMembers[member.id], merged[member.id])
);

if (!changed && previous) {
  console.log("Sin cambios: no se modifica live-status.json.");
  process.exit(0);
}

const payload = {
  updatedAt: new Date().toISOString(),
  members: merged,
};

await fs.writeFile(
  OUTPUT_FILE,
  JSON.stringify(payload, null, 2) + "\n",
  "utf8"
);

console.log(
  `Estado actualizado para ${members.length} miembros. Cambios: ${changed ? "sí" : "primera ejecución"}.`
);
