// Resumable backward fetch of the Art Blocks #sales-feed into sales-cache.json.
//
//   bun fetch-sales.ts <days>
//
// Extends whatever the cache already holds backwards until it covers the last
// <days> days, then runs a gap-repair pass: any timestamp gap > 6h between two
// adjacent (snowflake-ordered) sales is re-probed between the two message ids
// and merged — this recovers sales lost to transient API glitches (the earlier
// cloudflare-502 skip) while harmlessly no-op'ing on genuine feed outages.

const DISCORD_API = "https://discord.com/api/v10";
const CHANNEL_ID = "859312767105105941";
const CACHE_FILE = "./sales-cache.json";
const GAP_HOURS = 12; // gap threshold that triggers a re-probe (catches outages/glitches, skips overnight lulls)

const days = Number(process.argv[2] ?? 180);
const cutoffMs = Date.now() - days * 86400_000;

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN not set");
  process.exit(1);
}

interface Sale {
  id: string;
  ts: string;
  eth: number;
  title: string;
}

function parseSale(msg: any): Sale | null {
  for (const e of msg.embeds ?? []) {
    const f = (e.fields ?? []).find((x: any) => x.name.startsWith("Sale Price"));
    if (!f) continue;
    const m = (f.value as string).match(/([\d.]+)\s*(ETH|WETH)\b/i);
    if (m) return { id: msg.id, ts: msg.timestamp, eth: Number(m[1]), title: e.title ?? "" };
  }
  return null;
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
      lastErr = String(e);
      await Bun.sleep(1500 * (attempt + 1));
      continue;
    }
    if (res.status === 429) {
      const retry = (await res.json().catch(() => ({} as any))).retry_after ?? 1;
      await Bun.sleep(retry * 1000 + 200);
      continue;
    }
    if (res.status >= 500) {
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

// Load existing cache (or start fresh).
let sales: Sale[] = [];
const exists = await Bun.file(CACHE_FILE).exists();
if (exists) sales = (await Bun.file(CACHE_FILE).json()).sales ?? [];
const before = sales.length;
console.error(`cache: ${sales.length} sales, oldest ${sales.length ? sales.sort((a, b) => (a.ts < b.ts ? -1 : 1))[0].ts : "—"}`);

// --- Phase 1: extend backward from the oldest cached id to the cutoff -------
let cursor: string | undefined;
{
  const sorted = [...sales].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  cursor = sorted[0]?.id; // oldest snowflake
}

let pages = 0;
let added = 0;
let stop = false;
const ids = new Set(sales.map((s) => s.id)); // hoisted: built once, extended as we go
while (!stop) {
  const batch = await fetchPage(cursor);
  if (batch.length === 0) break;
  pages++;
  for (const msg of batch) {
    if (new Date(msg.timestamp).getTime() < cutoffMs) {
      stop = true;
      break;
    }
    const sale = parseSale(msg);
    if (sale && !ids.has(sale.id)) {
      sales.push(sale);
      ids.add(sale.id);
      added++;
    }
  }
  cursor = batch[batch.length - 1].id;
  if (pages % 10 === 0) {
    console.error(`  +${pages} pages, +${added} sales, reached ${batch[batch.length - 1].timestamp.slice(0, 10)}`);
    // flush periodically so an interrupt/restart resumes from here
    if (pages % 25 === 0)
      await Bun.write(CACHE_FILE, JSON.stringify({ fetched_at: new Date().toISOString(), days, sales }, null, 2));
  }
  if (stop || batch.length < 100) break;
  await Bun.sleep(450);
}
console.error(`phase 1: +${added} sales in ${pages} pages → ${sales.length} total`);

await Bun.write(CACHE_FILE, JSON.stringify({ fetched_at: new Date().toISOString(), days, sales }, null, 2));

// --- Phase 2: gap repair ---------------------------------------------------
sales.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
const gaps: [Sale, Sale][] = [];
for (let i = 1; i < sales.length; i++) {
  const dt = new Date(sales[i].ts).getTime() - new Date(sales[i - 1].ts).getTime();
  if (dt > GAP_HOURS * 3600_000) gaps.push([sales[i - 1], sales[i]]);
}
console.error(`phase 2: ${gaps.length} gap(s) > ${GAP_HOURS}h found — re-probing`);

let repaired = 0;
for (const [older, newer] of gaps) {
  const beforeCount = sales.length;
  let c: string | undefined = newer.id;
  let guard = 0;
  let recovered = 0;
  const ids = new Set(sales.map((s) => s.id));
  while (guard++ < 80) {
    const batch = await fetchPage(c);
    if (batch.length === 0) break;
    let done = false;
    for (const msg of batch) {
      if (BigInt(msg.id) <= BigInt(older.id)) {
        done = true;
        break;
      }
      const sale = parseSale(msg);
      if (sale && !ids.has(sale.id)) {
        sales.push(sale);
        ids.add(sale.id);
        recovered++;
      }
    }
    c = batch[batch.length - 1].id;
    if (done || batch.length < 100) break;
    await Bun.sleep(350);
  }
  if (recovered > 0) {
    repaired += recovered;
    console.error(`  repaired gap ${older.ts.slice(0, 10)}→${newer.ts.slice(0, 10)}: +${recovered} sales`);
  } else {
    console.error(`  gap ${older.ts.slice(0, 10)}→${newer.ts.slice(0, 10)}: real (0 recovered)`);
  }
}
if (repaired > 0) console.error(`phase 2: recovered ${repaired} sales from glitches`);

await Bun.write(CACHE_FILE, JSON.stringify({ fetched_at: new Date().toISOString(), days, sales }, null, 2));
sales.sort((a, b) => (a.ts < b.ts ? -1 : 1));
console.error(`done: ${sales.length} sales (${sales.length - before} new), span ${sales[0].ts} → ${sales[sales.length - 1].ts}`);
