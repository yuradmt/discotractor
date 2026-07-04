// Daily sales volume (in ETH) for the Art Blocks sales-feed Discord channel.
//
// Paginates the sales-feed backwards from "now" until it crosses a target
// date, parses the "Sale Price" embed field on each artbot sale message, sums
// ETH (WETH counts as ETH) per UTC day, and prints an ASCII bar chart.
//
// Usage:
//   bun sales-volume.ts            # last 90 days
//   bun sales-volume.ts 30         # last 30 days
//   bun sales-volume.ts 180        # last 180 days
//
// DISCORD_TOKEN is auto-loaded from .env. A cache file (./sales-cache.json)
// holds the fetched sales so re-renders don't re-hit the API.

import { Database } from "bun:sqlite";

const DISCORD_API = "https://discord.com/api/v10";
const CHANNEL_ID = "859312767105105941"; // Art Blocks #sales-feed
const CACHE_FILE = "./sales-cache.json";
const DB_FILE = "./messages.db";

const daysArg = Number(process.argv[2] ?? 90);
const DAYS = Number.isFinite(daysArg) && daysArg > 0 ? daysArg : 90;

interface Sale {
  id: string;
  ts: string; // ISO
  eth: number;
  title: string;
}

// --- Price parsing -------------------------------------------------------
// Field value looks like "0.25 ETH" or "0.0064 WETH". Only ETH/WETH count
// (both are ETH-denominated); anything else is skipped.
function parsePrice(fields: { name: string; value: string }[] | undefined): number | null {
  if (!fields) return null;
  const f = fields.find((x) => x.name.startsWith("Sale Price"));
  if (!f) return null;
  const m = f.value.match(/([\d.]+)\s*(ETH|WETH)\b/i);
  if (!m) return null; // non-ETH denomination — ignore
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseSale(msg: any): Sale | null {
  for (const e of msg.embeds ?? []) {
    const eth = parsePrice(e.fields);
    if (eth !== null) {
      return { id: msg.id, ts: msg.timestamp, eth, title: e.title ?? "" };
    }
  }
  return null;
}

// --- Fetching with rate-limit handling ----------------------------------
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN not set");
  process.exit(1);
}

async function fetchPage(before?: string): Promise<any[]> {
  const url = new URL(`${DISCORD_API}/channels/${CHANNEL_ID}/messages`);
  url.searchParams.set("limit", "100");
  if (before) url.searchParams.set("before", before);
  let lastErr = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: token } });
    } catch (e) {
      // network blip — back off and retry
      lastErr = String(e);
      await Bun.sleep(1500 * (attempt + 1));
      continue;
    }
    if (res.status === 429) {
      const retry = (await res.json().catch(() => ({}))).retry_after ?? 1;
      await Bun.sleep(retry * 1000 + 200);
      continue;
    }
    if (res.status >= 500) {
      // transient gateway error (cloudflare 502/503/504) — back off and retry
      lastErr = `${res.status}`;
      await Bun.sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      console.error(`fetch failed: ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    return (await res.json()) as any[];
  }
  console.error(`fetch failed after retries: ${lastErr}`);
  process.exit(1);
}

const cutoffMs = Date.now() - DAYS * 86400_000;

async function collect(): Promise<Sale[]> {
  const sales: Sale[] = [];
  let before: string | undefined;
  let pages = 0;
  while (true) {
    const batch = await fetchPage(before);
    pages++;
    if (batch.length === 0) break;
    let stop = false;
    for (const msg of batch) {
      if (new Date(msg.timestamp).getTime() < cutoffMs) {
        stop = true;
        break;
      }
      const sale = parseSale(msg);
      if (sale) sales.push(sale);
    }
    process.stderr.write(`\rfetched ${pages} pages, ${sales.length} sales…`);
    before = batch[batch.length - 1].id;
    if (stop || batch.length < 100) break;
    await Bun.sleep(450);
  }
  process.stderr.write("\n");
  return sales;
}

// Persist into messages.db too (summarized=1 so it never feeds a digest),
// as channel_name "artblocks-sales-feed". Best-effort: ignore if table missing.
function persistDb(sales: Sale[]) {
  let db: Database;
  try {
    db = new Database(DB_FILE);
  } catch {
    return;
  }
  try {
    const ins = db.prepare(
      `INSERT OR IGNORE INTO messages (id, channel_id, channel_name, author, content, timestamp, summarized)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    );
    const tx = db.transaction((rows: Sale[]) => {
      for (const s of rows)
        ins.run(s.id, CHANNEL_ID, "artblocks-sales-feed", "artbot", `${s.eth} ETH — ${s.title}`, s.ts);
    });
    tx(sales);
  } catch (e) {
    // non-fatal
  } finally {
    db.close();
  }
}

// --- Main ---------------------------------------------------------------
console.error(`Art Blocks #sales-feed — daily ETH volume (last ${DAYS} days)`);

let sales: Sale[];
const cache = await Bun.file(CACHE_FILE).exists()
  ? await Bun.file(CACHE_FILE).json().catch(() => null)
  : null;

// Only reuse cache if it covers the requested window.
const cacheOldest = cache?.sales?.length ? cache.sales[cache.sales.length - 1].ts : null;
const cacheFresh = cache && cacheOldest && new Date(cacheOldest).getTime() <= cutoffMs;

if (cacheFresh) {
  console.error(`using cache (${cache.sales.length} sales, oldest ${cacheOldest})`);
  sales = cache.sales;
} else {
  sales = await collect();
  await Bun.write(CACHE_FILE, JSON.stringify({ fetched_at: new Date().toISOString(), days: DAYS, sales }, null, 2));
  console.error(`cached ${sales.length} sales → ${CACHE_FILE}`);
  persistDb(sales);
}

// Aggregate per UTC day.
const byDay = new Map<string, { vol: number; count: number }>();
for (const s of sales) {
  const day = s.ts.slice(0, 10); // YYYY-MM-DD (UTC, ISO Z already)
  const cur = byDay.get(day) ?? { vol: 0, count: 0 };
  cur.vol += s.eth;
  cur.count += 1;
  byDay.set(day, cur);
}

// Fill missing days in range with zeros.
const days: { day: string; vol: number; count: number }[] = [];
for (let i = DAYS - 1; i >= 0; i--) {
  const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
  const v = byDay.get(d) ?? { vol: 0, count: 0 };
  days.push({ day: d, vol: v.vol, count: v.count });
}

const totalVol = days.reduce((a, d) => a + d.vol, 0);
const totalSales = days.reduce((a, d) => a + d.count, 0);
const maxVol = Math.max(1, ...days.map((d) => d.vol));
const maxCount = days.reduce((a, d) => Math.max(a, d.count), 0);

console.log("");
console.log(`range: ${days[0].day} → ${days[days.length - 1].day}  (${days.length} days)`);
console.log(
  `total: ${totalVol.toFixed(2)} ETH across ${totalSales} sales  |  avg ${totalSales / days.length | 0} sales/day, ${(totalVol / days.length).toFixed(2)} ETH/day`,
);
console.log("");

// --- ASCII chart (one row per day, newest at bottom) --------------------
const BAR = 40;
const labelW = String(maxCount).length;
for (const d of days) {
  const bars = Math.round((d.vol / maxVol) * BAR);
  const bar = "█".repeat(bars).padEnd(BAR);
  const marker = d.count === maxCount ? " ◄ peak" : "";
  console.log(
    `${d.day} │ ${bar} │ ${d.vol.toFixed(2).padStart(8)} ETH  (${String(d.count).padStart(labelW)} sales)${marker}`,
  );
}

console.log("");
console.log(`scale: 1 block ≈ ${(maxVol / BAR).toFixed(3)} ETH  |  tallest day = ${maxVol.toFixed(2)} ETH (${maxCount} sales)`);
