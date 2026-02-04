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

  const res = await fetch(OPENROUTER_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: "x-ai/grok-4.1-fast",
      messages: [{ role: "user", content: fullPrompt }],
    }),
  });

  if (!res.ok) {
    console.error(`OpenRouter error: ${res.status} ${await res.text()}`);
    return null;
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || null;
}

async function sendToWebhook(content: string) {
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

  for (const chunk of chunks) {
    const res = await fetch(process.env.DISCORD_WEBHOOK_URL!, {
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

  const totalMessages = allChannelMessages.reduce((sum, cm) => sum + cm.messages.length, 0);
  console.log(`\nTotal: ${totalMessages} messages across all channels`);

  if (totalMessages === 0) {
    console.log("No messages to summarize");
    return;
  }

  console.log("\nGenerating summary with Grok...");
  const summary = await summarize(allChannelMessages);

  if (!summary) {
    console.log("Failed to generate summary");
    return;
  }

  console.log("\nSending to webhook...");
  await sendToWebhook(`📊 **Daily Alpha Digest**\n${new Date().toDateString()}\n\n${summary}`);

  console.log("Done!");
}

main().catch(console.error);
