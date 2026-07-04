// Backfill a Discord channel or thread's history into messages.db.
//
// Inserts with summarized=1 by DEFAULT, so a historical import can never be
// swept into the next "daily" digest (which summarizes summarized=0 rows). This
// is the safe path for any manual import — the recency guard in index.ts is only
// defense-in-depth on top of this.
//
// Usage:
//   bun backfill.ts <channel-id> [channel-name] [--unsummarized] [--since=YYYY-MM-DD]
//
// Examples:
//   bun backfill.ts 1486386305175650305 "Tori Finance"
//   bun backfill.ts 1486386305175650305 "Tori Finance" --since=2026-06-01
//   bun backfill.ts 1486386305175650305 "Tori Finance" --unsummarized   # rarely wanted
//
// Reads DISCORD_TOKEN from the env (Bun auto-loads .env).

import { Database } from "bun:sqlite";

const DISCORD_API = "https://discord.com/api/v10";

const [, , channelId, ...rest] = process.argv;
if (!channelId) {
  console.error(
    "usage: bun backfill.ts <channel-id> [channel-name] [--unsummarized] [--since=YYYY-MM-DD]",
  );
  process.exit(1);
}

const flags = rest.filter((a) => a.startsWith("--"));
const positionals = rest.filter((a) => !a.startsWith("--"));
const channelNameArg = positionals[0];

// summarized=1 unless the caller explicitly opts into feeding the next digest.
const summarized = flags.includes("--unsummarized") ? 0 : 1;
const sinceFlag = flags.find((f) => f.startsWith("--since="))?.split("=")[1];
const sinceTs = sinceFlag ? new Date(sinceFlag + "T00:00:00Z").getTime() : null;
if (sinceFlag && Number.isNaN(sinceTs)) {
  console.error(`bad --since date: ${sinceFlag} (expected YYYY-MM-DD)`);
  process.exit(1);
}

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN not set");
  process.exit(1);
}

interface Message {
  id: string;
  content: string;
  author: { username: string };
  timestamp: string;
}

const db = new Database("messages.db");
const insert = db.prepare(`
  INSERT OR IGNORE INTO messages (id, channel_id, channel_name, author, content, timestamp, summarized)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

// Resolve a display name: caller-supplied, else fall back to whatever the DB
// already has for this channel, else the raw id.
let channelName = channelNameArg;
if (!channelName) {
  const existing = db
    .query<{ channel_name: string }, [string]>(
      `SELECT channel_name FROM messages WHERE channel_id = ? LIMIT 1`,
    )
    .get(channelId);
  channelName = existing?.channel_name ?? channelId;
}

console.error(
  `backfilling channel ${channelId} as "${channelName}" (summarized=${summarized}` +
    `${sinceFlag ? `, since ${sinceFlag}` : ", full history"})`,
);

let before: string | undefined;
let fetched = 0;
let inserted = 0;
let stop = false;

while (!stop) {
  const url = new URL(`${DISCORD_API}/channels/${channelId}/messages`);
  url.searchParams.set("limit", "100");
  if (before) url.searchParams.set("before", before);

  const res = await fetch(url.toString(), { headers: { Authorization: token } });
  if (!res.ok) {
    console.error(`fetch failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const batch: Message[] = await res.json();
  if (batch.length === 0) break;

  const tx = db.transaction((msgs: Message[]) => {
    for (const m of msgs) {
      if (sinceTs !== null && new Date(m.timestamp).getTime() < sinceTs) {
        stop = true;
        break;
      }
      fetched++;
      const r = insert.run(m.id, channelId, channelName!, m.author.username, m.content, m.timestamp, summarized);
      if (r.changes > 0) inserted++;
    }
  });
  tx(batch);

  before = batch[batch.length - 1].id;
  if (batch.length < 100) break;
  await Bun.sleep(500); // be gentle with the API
}

console.error(`done: ${fetched} messages scanned, ${inserted} new rows inserted (${fetched - inserted} already present)`);
