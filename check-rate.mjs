// Pushes a notification via ntfy.sh when the JPY price you'd pay at BCA drops
// to or below TARGET. Zero dependencies (Node 18+).
//
// Two sources:
//   market (default) -- live JPY/IDR mid-market rate from Wise, plus BCA's
//                       markup. Updates about every minute, ahead of BCA's
//                       website. (Yahoo's JPYIDR=X was tried first but went
//                       stale for 30+ minutes at a time.)
//   bca              -- BCA's public kurs page. Exact e-Rate, but the page
//                       lags the myBCA app, sometimes by hours.
//
// Env:
//   TARGET      IDR per 1 JPY to alert at; comma-separated for several levels,
//               e.g. 113.5,113 -- each alerts once on its own  (required)
//   NTFY_TOPIC  ntfy.sh topic name to publish to           (required)
//   SOURCE      market (default) | bca
//   MARKUP      BCA markup over market, default 0.001 (= 0.10%). Seven myBCA app
//               readings on 21 Oct 2026, 09:10-09:49 WIB, were +0.07% to +0.14%
//               over Wise (mean 0.103%): BCA steps its rate a few minutes behind
//               the market, so expect the estimate within about +/-Rp0.04.
//   BCA_TOLERANCE  market source only, default 0.3. The alert also needs BCA's
//               website eRate-sell <= target + this. Outside business hours BCA
//               widens its spread (5 Nov 2026 07:44 WIB: +1.1% over Wise, vs
//               +0.1% in the day), which the website shows but the market
//               estimate can't. The slack covers the website lagging the app
//               by ~Rp0.20 in the day. If BCA can't be fetched, the alert still
//               goes out, marked as unchecked.
//   CURRENCY    default JPY
//   RATE_TYPE   bca source only: eRate-sell (default) | TTCounter-sell | BankNotes-sell ...
//   STATE_FILE  default ./state.json -- remembers whether we already alerted

import { readFile, writeFile } from "node:fs/promises";

const BCA_URL = "https://www.bca.co.id/id/informasi/kurs";
const {
  TARGET,
  NTFY_TOPIC,
  SOURCE = "market",
  MARKUP = "0.001",
  BCA_TOLERANCE = "0.3",
  CURRENCY = "JPY",
  RATE_TYPE = "eRate-sell",
  STATE_FILE = "./state.json",
} = process.env;

if (!TARGET || !NTFY_TOPIC) {
  console.error("TARGET and NTFY_TOPIC are required");
  process.exit(1);
}
const targets = TARGET.split(",").map(Number).filter(Number.isFinite).sort((a, b) => b - a);
if (!targets.length) {
  console.error(`TARGET has no valid numbers: ${TARGET}`);
  process.exit(1);
}
const markup = Number(MARKUP);
const bcaTolerance = Number(BCA_TOLERANCE);

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

// Wise's public rate endpoint (what wise.com's own charts use): keyless, but
// undocumented, so it can change without notice.
async function fetchMarket() {
  const url = `https://wise.com/rates/live?source=${CURRENCY}&target=IDR`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Wise returned HTTP ${res.status}`);
  const { value, time } = await res.json();
  if (!value || !time) throw new Error("Wise response missing value/time");
  const ageMin = (Date.now() - time) / 60000;
  return {
    market: value,
    updated:
      new Date(time).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) + " WIB" +
      (ageMin > 30 ? ` (STALE: ${Math.round(ageMin)} min old)` : ""),
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
// Market source only: BCA's own website price, the gate against off-hours spreads.
let bcaWeb = null;
if (SOURCE === "bca") {
  const bca = await fetchBca();
  rate = bca.rate;
  detail = `BCA ${RATE_TYPE}: Rp${rate} (updated ${bca.updated ?? "?"})`;
} else {
  const { market, updated } = await fetchMarket();
  rate = Math.round(market * (1 + markup) * 100) / 100;
  detail = `Market Rp${market} at ${updated}\nEst. BCA rate Rp${rate} (+${(markup * 100).toFixed(2)}%)`;
  try {
    bcaWeb = await fetchBca();
    detail += `\nBCA website ${RATE_TYPE}: Rp${bcaWeb.rate} (updated ${bcaWeb.updated ?? "?"})`;
  } catch (err) {
    console.error(`BCA check failed, alerting on the estimate alone: ${err.message}`);
    detail += "\nBCA website: UNCHECKED (fetch failed)";
  }
}
const bcaAllows = (target) => !bcaWeb || bcaWeb.rate <= target + bcaTolerance;

const state = await loadState();
// Older state files stored a single boolean; start fresh in that case.
const prev = typeof state.alerted === "object" ? state.alerted : {};
const alerted = {};
console.log(`${CURRENCY} ${SOURCE}: ${detail.replace("\n", " | ")} | targets ${targets.join(", ")}`);

// Alert when a target is crossed, then remind once per WIB day while the rate
// stays at or below it. Climbing back above re-arms it.
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
for (const target of targets) {
  const hit = rate <= target && bcaAllows(target);
  if (hit && prev[target] !== today) {
    const reminder = Boolean(prev[target]);
    await notify(
      `${CURRENCY} ~Rp${rate} ${reminder ? "still below" : "hit"} Rp${target} -- check myBCA`,
      `${detail}\nTarget Rp${target}. Confirm the real rate in the app before buying.`
    );
    console.log(`Notification sent for ${target}${reminder ? " (daily reminder)" : ""}`);
  }
  alerted[target] = hit ? today : false;
}
await writeFile(STATE_FILE, JSON.stringify({ alerted, lastRate: rate, source: SOURCE }, null, 2));
