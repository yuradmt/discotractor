// Print "id<TAB>name" for every text channel the daily digest covers
// (same filters as index.ts: type 0, minus ignored + no-access lists).
const IGNORED_CHANNELS = [
  "intro-votes",
  "introduce-yourself",
  "lobby",
  "deal-requests",
  "pacts",
  "raises",
];
const IGNORED_CHANNEL_IDS = ["1239546875191885874"];

const noAccess = new Set<string>(
  (await Bun.file("./no-access-channels.json").json().catch(() => [])) as string[],
);
const res = await fetch(
  `https://discord.com/api/v10/guilds/${process.env.GUILD_ID}/channels`,
  { headers: { Authorization: process.env.DISCORD_TOKEN! } },
);
if (!res.ok) throw new Error(`channels: ${res.status}`);
const channels = (await res.json()) as { id: string; name: string; type: number }[];
for (const c of channels) {
  if (c.type !== 0) continue;
  if (IGNORED_CHANNELS.includes(c.name)) continue;
  if (IGNORED_CHANNEL_IDS.includes(c.id) || noAccess.has(c.id)) continue;
  console.log(`${c.id}\t${c.name}`);
}
