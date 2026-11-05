// Pushes a notification via ntfy.sh when the JPY price you'd pay at BCA drops
// to or below TARGET. Zero dependencies (Node 18+).
//
// Two sources:
//   market (default) -- live JPY/IDR mid-market rate from Wise, plus BCA's
//                       markup. Updates about every minute, ahead of BCA's
//                       website. (Yahoo's JPYIDR=X was tried first but went
//                       stale for 30+ minutes at a time.)
//   bca              -- BCA's public kurs page: the price itself. Since Nov 2026
//                       BCA's JPY markup over market sits around 1% most of
//                       the day, so a fixed MARKUP no longer models it, and
//                       the website has matched the myBCA app when checked.
//
// Env:
//   TARGET      IDR per 1 JPY to alert at; comma-separated for several levels,
//               e.g. 113.5,113 -- each alerts once on its own
//   MARGIN_ALERT  alert when BCA's e-Rate sell is at most this fraction above
//               the Wise market rate, e.g. 0.003 (= 0.3%). A cheap moment to
//               buy regardless of the price level: BCA was +0.1% on 21 Oct
//               2026 but +1.0% on 5 Nov. Needs both BCA and Wise; skipped (not
//               failed) when either can't be fetched.
//               At least one of TARGET / MARGIN_ALERT is required.
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
  TARGET = "",
  MARGIN_ALERT = "",
  NTFY_TOPIC,
  SOURCE = "market",
  MARKUP = "0.001",
  BCA_TOLERANCE = "0.3",
  CURRENCY = "JPY",
  RATE_TYPE = "eRate-sell",
  STATE_FILE = "./state.json",
} = process.env;

if (!NTFY_TOPIC) {
  console.error("NTFY_TOPIC is required");
  process.exit(1);
}
// Number("") is 0, so drop empty entries before parsing.
const targets = TARGET.split(",").filter((s) => s.trim()).map(Number).filter(Number.isFinite).sort((a, b) => b - a);
const marginAlert = MARGIN_ALERT.trim() ? Number(MARGIN_ALERT) : null;
if (!targets.length && !Number.isFinite(marginAlert)) {
  console.error(`Need a valid TARGET and/or MARGIN_ALERT (got TARGET="${TARGET}", MARGIN_ALERT="${MARGIN_ALERT}")`);
  process.exit(1);
}
const markup = Number(MARKUP);
const bcaTolerance = Number(BCA_TOLERANCE);

// "24.231,55" -> 24231.55 (Indonesian number format)
const parseIdNumber = (s) => Number(s.replace(/\./g, "").replace(",", "."));

async function fetchBca() {
  const res = await fetch(BCA_URL, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
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
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
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
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`ntfy returned HTTP ${res.status}`);
}

let rate, detail;
// bcaWeb: BCA's own website price. With SOURCE=market it is the gate against
// off-hours spreads; either source may need both for MARGIN_ALERT.
let bcaWeb = null;
let mkt = null;
if (SOURCE === "bca") {
  bcaWeb = await fetchBca();
  rate = bcaWeb.rate;
  detail = `BCA ${RATE_TYPE}: Rp${rate} (updated ${bcaWeb.updated ?? "?"})`;
} else {
  mkt = await fetchMarket();
  rate = Math.round(mkt.market * (1 + markup) * 100) / 100;
  detail = `Market Rp${mkt.market} at ${mkt.updated}\nEst. BCA rate Rp${rate} (+${(markup * 100).toFixed(2)}%)`;
  try {
    bcaWeb = await fetchBca();
    detail += `\nBCA website ${RATE_TYPE}: Rp${bcaWeb.rate} (updated ${bcaWeb.updated ?? "?"})`;
  } catch (err) {
    console.error(`BCA check failed, alerting on the estimate alone: ${err.message}`);
    detail += "\nBCA website: UNCHECKED (fetch failed)";
  }
}
const bcaAllows = (target) => !bcaWeb || bcaWeb.rate <= target + bcaTolerance;

// BCA's markup over market, e.g. 0.0103 = BCA charges 1.03% above Wise.
let margin = null;
if (marginAlert !== null) {
  try {
    if (!bcaWeb) throw new Error("BCA website unavailable");
    if (!mkt) {
      mkt = await fetchMarket();
      detail += `\nMarket Rp${mkt.market} at ${mkt.updated}`;
    }
    margin = bcaWeb.rate / mkt.market - 1;
    detail += `\nBCA margin over market: ${(margin * 100).toFixed(2)}%`;
  } catch (err) {
    console.error(`Margin check skipped: ${err.message}`);
  }
}

// One entry per alert; key is what state.json remembers it by. rearm (default
// !hit) says when a sent alert may fire again.
const pct = (x) => `${(x * 100).toFixed(2)}%`;
const checks = targets.map((target) => ({
  key: String(target),
  hit: rate <= target && bcaAllows(target),
  title: (reminder) => `${CURRENCY} ~Rp${rate} ${reminder ? "still below" : "hit"} Rp${target} -- check myBCA`,
  why: `Target Rp${target}.`,
}));
if (margin !== null) {
  checks.push({
    key: `margin:${marginAlert}`,
    hit: margin <= marginAlert,
    // BCA's markup jumps around by tenths of a percent within minutes; without
    // this gap a margin hovering at the threshold would alert on every flap.
    rearm: margin > marginAlert + 0.001,
    title: (reminder) =>
      `BCA ${CURRENCY} margin ${pct(margin)} ${reminder ? "still" : "now"} <= ${pct(marginAlert)} -- cheap moment, check myBCA`,
    why: `BCA is only ${pct(margin)} above market (alert at ${pct(marginAlert)}).`,
  });
}

const state = await loadState();
// Older state files stored a single boolean; start fresh in that case.
const prev = typeof state.alerted === "object" ? state.alerted : {};
const alerted = {};
console.log(`${CURRENCY} ${SOURCE}: ${detail.replaceAll("\n", " | ")} | checks ${checks.map((c) => c.key).join(", ")}`);

// Alert when a check first hits, then remind once per WIB day while it stays
// hit. Re-arms once rearm is true. A failed push keeps the old memory, so the
// next run retries it instead of the whole run dying before state is saved.
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
let failedSends = 0;
for (const { key, hit, rearm = !hit, title, why } of checks) {
  if (hit && prev[key] !== today) {
    const reminder = Boolean(prev[key]);
    try {
      await notify(title(reminder), `${detail}\n${why} Confirm the real rate in the app before buying.`);
      console.log(`Notification sent for ${key}${reminder ? " (daily reminder)" : ""}`);
      alerted[key] = today;
    } catch (err) {
      console.error(`Notification for ${key} failed, retrying next run: ${err.message}`);
      alerted[key] = prev[key] ?? false;
      failedSends++;
    }
    continue;
  }
  alerted[key] = hit ? prev[key] : rearm ? false : (prev[key] ?? false);
}
// A skipped margin check keeps its memory, so a Wise blip can't re-send today's alert.
if (marginAlert !== null && margin === null) {
  const key = `margin:${marginAlert}`;
  alerted[key] = prev[key] ?? false;
}
await writeFile(STATE_FILE, JSON.stringify({ alerted, lastRate: rate, margin, source: SOURCE }, null, 2));
// Still fail the run (after saving) so GitHub shows a red run for a lost alert.
if (failedSends) process.exit(1);
