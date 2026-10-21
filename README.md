# jpy-rate-alert

Pushes a phone notification (via ntfy) when the JPY price at BCA drops to a target.

## Sources

- `market` (default): live JPY/IDR mid-market rate from Wise, times BCA's markup (`MARKUP`, default 0.10%).
  Tracks the myBCA / Pocket Valas rate within a few rupiah cents and moves ahead of BCA's website.
  Measured on 21 Oct 2026: the myBCA app was 0.07-0.10% above Wise. Recheck it now and then and adjust.
- `bca`: the public page https://www.bca.co.id/id/informasi/kurs.
  Exact e-Rate, but the page lags the app, sometimes by hours.

The alert says "check myBCA": always confirm the real rate in the app before buying.

## Setup

1. Install the ntfy app (Android/iOS) and subscribe to a hard-to-guess topic, e.g. `jpy-alert-7f3k9q`.
   Topics are public, so anyone who knows the name can read or post to it.
2. Local test: `TARGET=115 NTFY_TOPIC=jpy-alert-7f3k9q node check-rate.mjs` (115 triggers right away).
   Delete `state.json` afterwards to re-arm.
3. Push to a GitHub repo, then under Settings > Secrets and variables > Actions add:
   - secret `NTFY_TOPIC`
   - variable `TARGET`: one level (`113.25`) or several, comma-separated (`113.5,113.25`)
   - optional variables `SOURCE`, `MARKUP`, `RATE_TYPE`
4. Run the workflow once with "Run workflow" to confirm it can reach Wise and ntfy.

You get a notification when the rate crosses a target, then one reminder per day (WIB) while it stays at or below it.
Going back above the target re-arms it, so the next drop alerts immediately.
