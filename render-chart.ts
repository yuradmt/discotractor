// Render sales volume (ETH) for the last N days from sales-cache.json to a JPEG.
// Granularity is automatic: daily for short windows, weekly beyond ~400 days.
//
//   bun render-chart.ts [days=180] [out=chart.jpg]

import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

const DAYS = Number(process.argv[2] ?? 180);
const OUT = process.argv[3] ?? "chart.jpg";
const WEEKLY = DAYS > 400;

GlobalFonts.registerFromPath("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DejaVu");
GlobalFonts.registerFromPath("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "DejaVuBold");

const cache = await Bun.file("./sales-cache.json").json();
const sales: { ts: string; eth: number }[] = cache.sales;

// Daily series for the window (with zero-filled days).
const cutoffMs = Date.now() - DAYS * 86400_000;
const byDay = new Map<string, { vol: number; count: number }>();
for (const s of sales) {
  if (new Date(s.ts).getTime() < cutoffMs) continue;
  const day = s.ts.slice(0, 10);
  const cur = byDay.get(day) ?? { vol: 0, count: 0 };
  cur.vol += s.eth;
  cur.count += 1;
  byDay.set(day, cur);
}
const daily: { day: string; vol: number; count: number }[] = [];
for (let i = DAYS - 1; i >= 0; i--) {
  const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
  const v = byDay.get(d) ?? { vol: 0, count: 0 };
  daily.push({ day: d, vol: v.vol, count: v.count });
}

// Fold into weekly buckets if the window is long.
const points: { day: string; vol: number; count: number }[] = [];
if (WEEKLY) {
  for (let i = 0; i < daily.length; i += 7) {
    const slice = daily.slice(i, i + 7);
    points.push({
      day: slice[0].day,
      vol: slice.reduce((a, d) => a + d.vol, 0),
      count: slice.reduce((a, d) => a + d.count, 0),
    });
  }
} else {
  points.push(...daily);
}

const n = points.length;
const totalVol = points.reduce((a, d) => a + d.vol, 0);
const totalSales = points.reduce((a, d) => a + d.count, 0);
const maxVol = Math.max(1, ...points.map((d) => d.vol));
const peakIdx = points.reduce((best, d, i) => (d.vol > points[best].vol ? i : best), 0);
const grain = WEEKLY ? "weekly" : "daily";
const perPeriod = WEEKLY ? "ETH/week" : "ETH/day";

function niceCeil(v: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const x = v / pow;
  const step = x <= 1 ? 1 : x <= 2 ? 2 : x <= 2.5 ? 2.5 : x <= 5 ? 5 : 10;
  return step * pow;
}
const yMax = niceCeil(maxVol * 1.08);

// ---- Canvas -------------------------------------------------------------
const W = 1900;
const H = 860;
const ML = 76, MR = 36, MT = 104, MB = 76;
const chartW = W - ML - MR;
const chartH = H - MT - MB;
const slot = chartW / n;
const barW = Math.max(2, slot * 0.72);

const canvas = createCanvas(W, H);
const ctx = canvas.getContext("2d");
ctx.textBaseline = "alphabetic";

ctx.fillStyle = "#0d0f14";
ctx.fillRect(0, 0, W, H);

// Title
ctx.fillStyle = "#f8fafc";
ctx.font = "bold 30px DejaVuBold";
ctx.textAlign = "left";
ctx.fillText(`Art Blocks #sales-feed — ${grain} sales volume`, ML, 52);

// Subtitle
ctx.fillStyle = "#94a3b8";
ctx.font = "17px DejaVu";
const span = `${daily[0].day} → ${daily[daily.length - 1].day}`;
ctx.fillText(
  `${span}  ·  ${totalSales.toLocaleString()} sales  ·  ${totalVol.toFixed(1)} ETH total  ·  ${(totalVol / n).toFixed(1)} ${perPeriod} avg`,
  ML,
  80,
);

// Y gridlines + labels
const GRID = 6;
ctx.font = "13px DejaVu";
ctx.textAlign = "right";
for (let g = 0; g <= GRID; g++) {
  const y = MT + (chartH * g) / GRID;
  const val = yMax * (1 - g / GRID);
  ctx.strokeStyle = g === GRID ? "#334155" : "#1b2330";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ML, y);
  ctx.lineTo(W - MR, y);
  ctx.stroke();
  ctx.fillStyle = "#64748b";
  ctx.fillText(`${val.toFixed(val < 10 ? 1 : 0)}`, ML - 10, y + 4);
}

ctx.save();
ctx.translate(22, MT + chartH / 2);
ctx.rotate(-Math.PI / 2);
ctx.fillStyle = "#94a3b8";
ctx.font = "14px DejaVu";
ctx.textAlign = "center";
ctx.fillText("ETH volume", 0, 0);
ctx.restore();

// Bars
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
let lastMonth = -1;
for (let i = 0; i < n; i++) {
  const d = points[i];
  const h = (d.vol / yMax) * chartH;
  const x = ML + i * slot + (slot - barW) / 2;
  const y = MT + chartH - h;
  if (i === peakIdx) {
    ctx.fillStyle = "#f59e0b";
  } else {
    const grad = ctx.createLinearGradient(0, y, 0, MT + chartH);
    grad.addColorStop(0, "#2dd4bf");
    grad.addColorStop(1, "#0f766e");
    ctx.fillStyle = grad;
  }
  ctx.fillRect(x, y, barW, Math.max(h, d.vol > 0 ? 1 : 0));

  const mm = Number(d.day.slice(5, 7));
  if (mm !== lastMonth) {
    lastMonth = mm;
    ctx.fillStyle = "#94a3b8";
    ctx.font = "13px DejaVu";
    ctx.textAlign = "center";
    ctx.fillText(MON[mm - 1], x + barW / 2, MT + chartH + 22);
    ctx.strokeStyle = "#1b2330";
    ctx.beginPath();
    ctx.moveTo(x + barW / 2, MT + chartH);
    ctx.lineTo(x + barW / 2, MT + chartH + 6);
    ctx.stroke();
  }
}

// Peak annotation
const pd = points[peakIdx];
const px = ML + peakIdx * slot + slot / 2;
const py = MT + chartH - (pd.vol / yMax) * chartH;
ctx.fillStyle = "#fbbf24";
ctx.font = "bold 15px DejaVuBold";
ctx.textAlign = "center";
ctx.fillText(`${pd.vol.toFixed(pd.vol < 100 ? 1 : 0)} ETH`, px, py - 10);

// Footer
ctx.fillStyle = "#64748b";
ctx.font = "13px DejaVu";
ctx.textAlign = "left";
ctx.fillText(
  `peak ${grain}: ${pd.day} (${pd.count} sales)  ·  source: Art Blocks #sales-feed via artbot  ·  ${grain} ETH volume (WETH counted as ETH)`,
  ML,
  H - 28,
);

const buf = canvas.toBuffer("image/jpeg", { quality: 0.92 });
await Bun.write(OUT, buf);
console.log(
  `wrote ${OUT}  (${(buf.length / 1024).toFixed(0)} KB)  ·  ${grain}, ${n} bars, ${totalSales} sales, ${totalVol.toFixed(1)} ETH, peak ${pd.vol.toFixed(1)} ETH on ${pd.day}`,
);
