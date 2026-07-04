// Ad-hoc channel analysis: extract the top-N discussed farms from a channel
// over a given month.
//
// Usage:
//   bun analyze-channel.ts <channel-substring> <YYYY-MM> [topN]
//
// Examples:
//   bun analyze-channel.ts stable-yields 2026-05
//   bun analyze-channel.ts stable-yields 2026-05 15
//
// Reads messages.db (read-only), sends the month's messages to the LLM,
// prints a ranked list. Does NOT touch the summarized flag or post anywhere.

import { Database } from "bun:sqlite";

const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";
const PRIMARY = "x-ai/grok-4.3";
const FALLBACK = "minimax/minimax-m2";

const [, , channelArg, monthArg, topNArg] = process.argv;
if (!channelArg || !monthArg) {
  console.error("usage: bun analyze-channel.ts <channel-substring> <YYYY-MM> [topN]");
  process.exit(1);
}
const topN = topNArg ? Number(topNArg) : 10;

// Month window [start, end)
const [y, m] = monthArg.split("-").map(Number);
if (!y || !m) {
  console.error(`bad month: ${monthArg} (expected YYYY-MM)`);
  process.exit(1);
}
const start = `${monthArg}-01`;
const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;

const db = new Database("messages.db", { readonly: true });

// Resolve channel (substring match, case-insensitive — handles emoji prefixes)
const chans = db
  .query<{ channel_name: string }, [string]>(
    `SELECT DISTINCT channel_name FROM messages WHERE lower(channel_name) LIKE ?`,
  )
  .all(`%${channelArg.toLowerCase()}%`);
if (chans.length === 0) {
  console.error(`no channel matches "${channelArg}"`);
  process.exit(1);
}
if (chans.length > 1) {
  console.error(`ambiguous "${channelArg}" matches: ${chans.map((c) => c.channel_name).join(", ")}`);
  process.exit(1);
}
const channel = chans[0].channel_name;

const rows = db
  .query<{ author: string; content: string; timestamp: string }, [string, string, string]>(
    `SELECT author, content, timestamp FROM messages
     WHERE channel_name = ? AND timestamp >= ? AND timestamp < ?
     ORDER BY timestamp ASC`,
  )
  .all(channel, start, end);

if (rows.length === 0) {
  console.error(`no messages in ${channel} for ${monthArg}`);
  process.exit(1);
}

console.error(`channel: ${channel}  |  ${monthArg}  |  ${rows.length} messages\n`);

const transcript = rows
  .map((r) => `[${r.timestamp.slice(0, 10)}] ${r.author}: ${r.content}`)
  .join("\n");

const SYS = `You analyze a Discord channel transcript about DeFi stablecoin yield farming.
Extract the TOP ${topN} most-discussed farms / yield opportunities / protocols.

Rank by how much each was discussed (frequency of mentions + depth of discussion), most-discussed first.

For each, output exactly:
  N. <Farm / protocol name> — <chain or platform if known>
     mentions: ~<count>  |  sentiment: <positive/mixed/negative/neutral>
     <one or two sentences: the APYs cited, risks raised, who recommended it, any warnings>

Rules:
- Only use what's in the transcript. Do not invent farms, APYs, or numbers.
- A "farm" = a specific yield opportunity (e.g. "Pendle eUSDe PT", "Aave USDC on Base"),
  or a protocol if discussion stayed protocol-level.
- Merge obvious aliases (e.g. "ethena"/"USDe"/"sUSDe" → group sensibly, note the variants).
- If fewer than ${topN} distinct farms were genuinely discussed, list only what's real.
- End with a 2-3 sentence "Overall" note on the month's theme.
- Plain text. No markdown headers.`;

async function callModel(model: string, apiKey: string) {
  return fetch(OPENROUTER_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: `Channel: ${channel}\nMonth: ${monthArg}\n\nTranscript:\n${transcript}` },
      ],
      temperature: 0.2,
    }),
  });
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY not set");
  process.exit(1);
}

console.error(`querying ${PRIMARY}…`);
let res = await callModel(PRIMARY, apiKey);
if (!res.ok) {
  const errText = await res.text();
  if (res.status === 404 && /deprecat/i.test(errText)) {
    console.error(`${PRIMARY} obsolete — falling back to ${FALLBACK}`);
    res = await callModel(FALLBACK, apiKey);
    if (!res.ok) {
      console.error(`fallback failed: ${res.status} ${await res.text()}`);
      process.exit(1);
    }
  } else {
    console.error(`OpenRouter error: ${res.status} ${errText}`);
    process.exit(1);
  }
}

const data = await res.json();
const out = data.choices?.[0]?.message?.content;
if (!out) {
  console.error("empty response");
  process.exit(1);
}
console.log("\n" + out.trim());
