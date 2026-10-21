// Pushes a notification via ntfy.sh when the JPY price you'd pay at BCA drops
// to or below TARGET. Zero dependencies (Node 18+).
//
// Two sources:
//   market (default) -- live JPY/IDR from Yahoo Finance, plus BCA's markup.
//                       Updates every few minutes, ahead of BCA's website.
//   bca              -- BCA's public kurs page. Exact e-Rate, but the page
//                       lags the myBCA app, sometimes by hours.
//
// Env:
//   TARGET      IDR per 1 JPY to alert at, e.g. 105        (required)
//   NTFY_TOPIC  ntfy.sh topic name to publish to           (required)
//   SOURCE      market (default) | bca
//   MARKUP      BCA markup over market, default 0.0053 (= 0.53%, app 113.88 vs market 113.28)
//   CURRENCY    default JPY
//   RATE_TYPE   bca source only: eRate-sell (default) | TTCounter-sell | BankNotes-sell ...
//   STATE_FILE  default ./state.json -- remembers whether we already alerted

import { readFile, writeFile } from "node:fs/promises";

const BCA_URL = "https://www.bca.co.id/id/informasi/kurs";
const {
  TARGET,
  NTFY_TOPIC,
  SOURCE = "market",
  MARKUP = "0.0053",
  CURRENCY = "JPY",
  RATE_TYPE = "eRate-sell",
  STATE_FILE = "./state.json",
} = process.env;

if (!TARGET || !NTFY_TOPIC) {
  console.error("TARGET and NTFY_TOPIC are required");
  process.exit(1);
}
const target = Number(TARGET);
const markup = Number(MARKUP);

// "24.231,55" -> 24231.55 (Indonesian number format)
const parseIdNumber = (s) => Number(s.replace(/\./g, "").replace(",", "."));

async function fetchBca() {
  const res = await fetch(BCA_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`BCA returned HTTP ${res.status}`);
  const html = await res.text();

  const row = html.match(
    new RegExp(`<tr[^>]*code="${CURRENCY}"[^>]*>([\\s\\S]*?)</tr>`)
  );
  if (!row) throw new Error(`No ${CURRENCY} row found -- page layout changed?`);

  const rates = {};
  for (const m of row[1].matchAll(/rate-type="([\w-]+)">\s*<p>([\d.,]+)<\/p>/g)) {
    rates[m[1]] = parseIdNumber(m[2]);
  }
  const rate = rates[RATE_TYPE];
  if (rate === undefined) throw new Error(`Rate type ${RATE_TYPE} not found: ${JSON.stringify(rates)}`);
  const updated = html.match(/\d{1,2} \w{3} \d{4} \/ \d{2}\.\d{2} WIB/)?.[0];
  return { rate, updated };
}

// Unofficial Yahoo endpoint: free and keyless, but can change without notice.
async function fetchMarket() {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${CURRENCY}IDR=X?range=1d&interval=5m`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo returned HTTP ${res.status}`);
  const meta = (await res.json()).chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) throw new Error("Yahoo response missing price");
  return {
    market: meta.regularMarketPrice,
    updated: new Date(meta.regularMarketTime * 1000).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) + " WIB",
  };
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return { alerted: false };
  }
}

async function notify(title, message) {
  const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: "POST",
    headers: { Title: title, Priority: "high", Tags: "yen,chart_with_downwards_trend" },
    body: message,
  });
  if (!res.ok) throw new Error(`ntfy returned HTTP ${res.status}`);
}

let rate, detail;
if (SOURCE === "bca") {
  const bca = await fetchBca();
  rate = bca.rate;
  detail = `BCA ${RATE_TYPE}: Rp${rate} (updated ${bca.updated ?? "?"})`;
} else {
  const { market, updated } = await fetchMarket();
  rate = Math.round(market * (1 + markup) * 100) / 100;
  detail = `Market Rp${market} at ${updated}\nEst. BCA rate Rp${rate} (+${(markup * 100).toFixed(2)}%)`;
}

const state = await loadState();
const hit = rate <= target;
console.log(`${CURRENCY} ${SOURCE}: ${detail.replace("\n", " | ")} | target ${target} hit=${hit}`);

// Alert once per crossing: re-arm only after the rate climbs back above target.
if (hit && !state.alerted) {
  await notify(
    `${CURRENCY} ~Rp${rate} -- check myBCA`,
    `${detail}\nTarget Rp${target}. Confirm the real rate in the app before buying.`
  );
  console.log("Notification sent");
}
await writeFile(STATE_FILE, JSON.stringify({ alerted: hit, lastRate: rate, source: SOURCE }, null, 2));
