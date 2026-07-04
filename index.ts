import { Database } from "bun:sqlite";

const db = new Database("messages.db");
db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    summarized INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`);

// Migration: add summarized column if it doesn't exist
try {
  db.run(`ALTER TABLE messages ADD COLUMN summarized INTEGER DEFAULT 0`);
} catch {
  // Column already exists
}
db.run(`CREATE INDEX IF NOT EXISTS idx_messages_summarized ON messages(summarized)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_name)`);

const insertMessage = db.prepare(`
  INSERT OR IGNORE INTO messages (id, channel_id, channel_name, author, content, timestamp)
  VALUES (?, ?, ?, ?, ?, ?)
`);

// Recency guard: the digest is "the last day's activity", enforced at both
// ingestion (fetchTodayMessages only inserts today's) AND here. Without the
// timestamp bound, any out-of-band insert with summarized=0 — e.g. a manual
// backfill of a channel's history — gets swept into the next digest even though
// it's months old. The 2-day window still catches a missed cron day (the next
// fetch re-inserts the gap) but can't pull in historical backfills.
const getUnsummarizedMessages = db.prepare(`
  SELECT id, channel_name, author, content, timestamp
  FROM messages
  WHERE summarized = 0 AND timestamp >= datetime('now', '-2 days')
  ORDER BY channel_name, timestamp ASC
`);

const getTodayMessages = db.prepare(`
  SELECT id, channel_name, author, content, timestamp
  FROM messages
  WHERE date(timestamp) = date('now')
  ORDER BY channel_name, timestamp ASC
`);

const markAsSummarized = db.prepare(`UPDATE messages SET summarized = 1 WHERE id = ?`);

const dryRun = process.argv.includes("--dry-run");

const IGNORED_CHANNELS = [
  "intro-votes",
  "introduce-yourself",
  "lobby",
  // deals category
  "deal-requests",
  "pacts",
  "raises",
];

const IGNORED_CHANNEL_IDS = [
  "1239546875191885874", // tweets
];

const NO_ACCESS_FILE = "./no-access-channels.json";

async function loadNoAccessChannels(): Promise<Set<string>> {
  try {
    const file = Bun.file(NO_ACCESS_FILE);
    if (await file.exists()) {
      const data = await file.json();
      return new Set(data);
    }
  } catch {}
  return new Set();
}

async function saveNoAccessChannels(channels: Set<string>): Promise<void> {
  await Bun.write(NO_ACCESS_FILE, JSON.stringify([...channels], null, 2));
}

const DISCORD_API = "https://discord.com/api/v10";
const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";

interface Channel {
  id: string;
  name: string;
  type: number;
}

interface Message {
  id: string;
  content: string;
  author: { username: string };
  timestamp: string;
}

interface ChannelMessages {
  channelName: string;
  messages: Message[];
}

interface DbMessage {
  id: string;
  channel_name: string;
  author: string;
  content: string;
  timestamp: string;
}

async function fetchChannels(): Promise<Channel[]> {
  const res = await fetch(`${DISCORD_API}/guilds/${process.env.GUILD_ID}/channels`, {
    headers: { Authorization: process.env.DISCORD_TOKEN! },
  });
  if (!res.ok) throw new Error(`Failed to fetch channels: ${res.status}`);
  const channels: Channel[] = await res.json();
  // type 0 = text channel
  return channels.filter(
    (c) => c.type === 0 && !IGNORED_CHANNELS.includes(c.name) && !IGNORED_CHANNEL_IDS.includes(c.id)
  );
}

async function fetchTodayMessages(
  channelId: string,
  channelName: string,
  noAccessChannels: Set<string>
): Promise<Message[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTimestamp = today.getTime();

  const messages: Message[] = [];
  let lastId: string | undefined;

  while (true) {
    const url = new URL(`${DISCORD_API}/channels/${channelId}/messages`);
    url.searchParams.set("limit", "100");
    if (lastId) url.searchParams.set("before", lastId);

    const res = await fetch(url.toString(), {
      headers: { Authorization: process.env.DISCORD_TOKEN! },
    });
    if (!res.ok) {
      if (res.status === 403) {
        noAccessChannels.add(channelId);
        console.error(`  ⚠ No access to #${channelName} - saved to ignore list`);
      } else {
        console.error(`  ⚠ Error fetching #${channelName} (${res.status})`);
      }
      break;
    }

    const batch: Message[] = await res.json();
    if (batch.length === 0) break;

    for (const msg of batch) {
      const msgTime = new Date(msg.timestamp).getTime();
      if (msgTime >= todayTimestamp) {
        messages.push(msg);
        insertMessage.run(msg.id, channelId, channelName, msg.author.username, msg.content, msg.timestamp);
      } else {
        return messages;
      }
    }

    lastId = batch[batch.length - 1].id;
    await Bun.sleep(500);
  }

  return messages;
}

async function loadPrompt(): Promise<string> {
  const file = Bun.file("./prompts/hedgefund.md");
  return await file.text();
}

function getUnsummarizedByChannel(): { channels: ChannelMessages[]; messageIds: string[] } {
  const rows = getUnsummarizedMessages.all() as DbMessage[];
  const messageIds = rows.map((r) => r.id);

  const byChannel = new Map<string, Message[]>();
  for (const row of rows) {
    if (!byChannel.has(row.channel_name)) {
      byChannel.set(row.channel_name, []);
    }
    byChannel.get(row.channel_name)!.push({
      id: row.id,
      content: row.content,
      author: { username: row.author },
      timestamp: row.timestamp,
    });
  }

  const channels: ChannelMessages[] = [];
  for (const [channelName, messages] of byChannel) {
    channels.push({ channelName, messages });
  }

  return { channels, messageIds };
}

function getTodayByChannel(): { channels: ChannelMessages[]; messageIds: string[] } {
  const rows = getTodayMessages.all() as DbMessage[];
  const messageIds = rows.map((r) => r.id);

  const byChannel = new Map<string, Message[]>();
  for (const row of rows) {
    if (!byChannel.has(row.channel_name)) {
      byChannel.set(row.channel_name, []);
    }
    byChannel.get(row.channel_name)!.push({
      id: row.id,
      content: row.content,
      author: { username: row.author },
      timestamp: row.timestamp,
    });
  }

  const channels: ChannelMessages[] = [];
  for (const [channelName, messages] of byChannel) {
    channels.push({ channelName, messages });
  }

  return { channels, messageIds };
}

function markMessagesAsSummarized(messageIds: string[]) {
  const tx = db.transaction(() => {
    for (const id of messageIds) {
      markAsSummarized.run(id);
    }
  });
  tx();
}

async function summarize(allChannelMessages: ChannelMessages[]): Promise<string | null> {
  const prompt = await loadPrompt();

  // Format all messages grouped by channel
  const formatted = allChannelMessages
    .filter((cm) => cm.messages.length > 0)
    .map((cm) => {
      const msgs = cm.messages
        .map((m) => `[${m.author.username}]: ${m.content}`)
        .reverse()
        .join("\n");
      return `=== #${cm.channelName} ===\n${msgs}`;
    })
    .join("\n\n");

  if (!formatted) return null;

  const fullPrompt = `${prompt}\n\n---\n\n**Today's Discord Messages:**\n\n${formatted}`;

  // Primary: grok. Fallback: minimax, but ONLY if grok was retired (deprecated 404).
  // Other failures (rate limit, network, auth) should NOT trigger fallback —
  // they're transient or environmental and we'd rather log+exit so cron retries.
  const PRIMARY = "x-ai/grok-4.3";
  const FALLBACK = "minimax/minimax-m2";

  async function callModel(model: string) {
    return fetch(OPENROUTER_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({ model, messages: [{ role: "user", content: fullPrompt }] }),
    });
  }

  let res = await callModel(PRIMARY);
  if (!res.ok) {
    const errText = await res.text();
    const isObsolete = res.status === 404 && /deprecat/i.test(errText);
    if (isObsolete) {
      console.warn(`Primary model ${PRIMARY} is obsolete — falling back to ${FALLBACK}`);
      res = await callModel(FALLBACK);
      if (!res.ok) {
        console.error(`Fallback ${FALLBACK} also failed: ${res.status} ${await res.text()}`);
        return null;
      }
    } else {
      console.error(`OpenRouter error: ${res.status} ${errText}`);
      return null;
    }
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || null;
}

function getWebhookUrls(): string[] {
  const isTest = process.argv.includes("--test");
  const isProd = process.argv.includes("--prod");
  // No flag = send to both (cron behavior)
  const sendTest = isTest || (!isTest && !isProd);
  const sendProd = isProd || (!isTest && !isProd);
  const urls: string[] = [];
  if (sendTest && process.env.DISCORD_WEBHOOK_URL_TEST) urls.push(process.env.DISCORD_WEBHOOK_URL_TEST);
  if (sendProd && process.env.DISCORD_WEBHOOK_URL_PROD) {
    urls.push(...process.env.DISCORD_WEBHOOK_URL_PROD.split(",").map((u) => u.trim()).filter(Boolean));
  }
  return urls;
}

async function sendToWebhooks(content: string) {
  const webhookUrls = getWebhookUrls();
  if (webhookUrls.length === 0) {
    console.error("No webhook URLs configured");
    return;
  }

  // Discord has 2000 char limit, split into multiple messages if needed
  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= 2000) {
      chunks.push(remaining);
      break;
    }
    // Find a good break point
    let breakPoint = remaining.lastIndexOf("\n", 2000);
    if (breakPoint === -1 || breakPoint < 1500) {
      breakPoint = 2000;
    }
    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint);
  }

  for (const webhookUrl of webhookUrls) {
    console.log(`Sending to webhook: ${webhookUrl.slice(0, 50)}...`);
    for (const chunk of chunks) {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: chunk }),
      });
      if (!res.ok) {
        console.error(`Webhook error: ${res.status}`);
      }
      await Bun.sleep(500);
    }
  }
}

async function main() {
  console.log("Loading no-access channels...");
  const noAccessChannels = await loadNoAccessChannels();
  console.log(`${noAccessChannels.size} channels in no-access list`);

  console.log("Fetching channels...");
  let channels = await fetchChannels();
  // Filter out channels we already know we can't access
  channels = channels.filter((c) => !noAccessChannels.has(c.id));
  console.log(`Found ${channels.length} text channels (excluding ignored)`);

  const allChannelMessages: ChannelMessages[] = [];

  for (const channel of channels) {
    console.log(`Fetching #${channel.name}...`);
    const messages = await fetchTodayMessages(channel.id, channel.name, noAccessChannels);
    console.log(`  ${messages.length} messages today`);
    allChannelMessages.push({ channelName: channel.name, messages });
  }

  // Save any newly discovered no-access channels
  await saveNoAccessChannels(noAccessChannels);

  const totalFetched = allChannelMessages.reduce((sum, cm) => sum + cm.messages.length, 0);
  console.log(`\nFetched: ${totalFetched} messages across all channels`);

  // Get messages from DB
  const { channels: targetChannels, messageIds } = dryRun ? getTodayByChannel() : getUnsummarizedByChannel();
  const totalMessages = targetChannels.reduce((sum, cm) => sum + cm.messages.length, 0);
  console.log(`${dryRun ? "Today's" : "Unsummarized"}: ${totalMessages} messages${dryRun ? " (dry-run, won't mark as summarized)" : ""}`);

  if (totalMessages === 0) {
    console.log("No messages to summarize");
    return;
  }

  console.log("\nGenerating summary with Grok...");
  const summary = await summarize(targetChannels);

  if (!summary) {
    console.log("Failed to generate summary");
    return;
  }

  if (!dryRun) {
    markMessagesAsSummarized(messageIds);
    console.log(`Marked ${messageIds.length} messages as summarized`);
  }

  const skipWebhook = process.argv.includes("--no-webhook");
  if (skipWebhook) {
    console.log("\n--no-webhook flag set, skipping webhook send");
    console.log("\n--- SUMMARY ---\n");
    console.log(summary);
  } else {
    console.log("\nSending to webhooks...");
    await sendToWebhooks(`📊 **Daily Alpha Digest**\n${new Date().toDateString()}\n\n${summary}`);
  }

  console.log("\nDone!");
}

main().catch(console.error);
