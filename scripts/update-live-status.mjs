import fs from "node:fs/promises";

const INDEX_FILE = "index.html";
const OUTPUT_FILE = "live-status.json";

function extractMembers(html) {
  const match = html.match(
    /const\s+DEFAULT_VTUBERS\s*=\s*(\[[\s\S]*?\]);\s*\/\*\s*State Management/
  );

  if (!match) {
    throw new Error("No se encontró DEFAULT_VTUBERS en index.html");
  }

  return JSON.parse(match[1]);
}

async function twitchToken() {
  const body = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
    grant_type: "client_credentials",
  });

  const r = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!r.ok) throw new Error(`Twitch OAuth ${r.status}: ${await r.text()}`);
  return r.json();
}

async function updateTwitch(members) {
  const result = {};
  const logins = [...new Set(members.map(m => m.twitch).filter(Boolean).map(x => x.toLowerCase()))];

  if (!logins.length) return result;

  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
    console.warn("Faltan TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET; se omite Twitch.");
    return result;
  }

  const token = await twitchToken();

  const params = new URLSearchParams();
  for (const login of logins) params.append("user_login", login);

  const r = await fetch(`https://api.twitch.tv/helix/streams?${params}`, {
    headers: {
      "Client-Id": process.env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token.access_token}`,
    },
  });

  if (!r.ok) throw new Error(`Twitch streams ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const liveByLogin = new Map(data.data.map(s => [s.user_login.toLowerCase(), s]));

  for (const member of members) {
    if (!member.twitch) continue;
    const stream = liveByLogin.get(member.twitch.toLowerCase());

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

async function youtubeJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`YouTube ${r.status}: ${await r.text()}`);
  return r.json();
}

async function updateYouTube(members) {
  const result = {};
  if (!process.env.YOUTUBE_API_KEY) {
    console.warn("Falta YOUTUBE_API_KEY; se omite YouTube.");
    return result;
  }

  for (const member of members) {
    if (!member.youtube) continue;

    const handle = member.youtube.replace(/^@/, "");
    const channelUrl =
      "https://www.googleapis.com/youtube/v3/channels?" +
      new URLSearchParams({
        part: "id",
        forHandle: `@${handle}`,
        key: process.env.YOUTUBE_API_KEY,
      });

    const channelData = await youtubeJson(channelUrl);
    const channelId = channelData.items?.[0]?.id;
    if (!channelId) continue;

    const liveUrl =
      "https://www.googleapis.com/youtube/v3/search?" +
      new URLSearchParams({
        part: "snippet",
        channelId,
        eventType: "live",
        type: "video",
        maxResults: "1",
        key: process.env.YOUTUBE_API_KEY,
      });

    const liveData = await youtubeJson(liveUrl);
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

const html = await fs.readFile(INDEX_FILE, "utf8");
const members = extractMembers(html);

const [twitch, youtube] = await Promise.all([
  updateTwitch(members),
  updateYouTube(members),
]);

// YouTube wins only if a member is not already marked live on Twitch.
// If both are live, expose Twitch as the primary platform.
const merged = {};
for (const member of members) {
  merged[member.id] =
    twitch[member.id] ||
    youtube[member.id] ||
    {
      isLive: false,
      platform: "",
      title: "",
      url: "",
    };
}

const payload = {
  updatedAt: new Date().toISOString(),
  members: merged,
};

await fs.writeFile(OUTPUT_FILE, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log(`Estado actualizado para ${members.length} miembros.`);
