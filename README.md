# jpy-rate-alert

Pushes a phone notification (via ntfy) when the JPY price at BCA drops to a target.

## Sources

- `market` (default): live JPY/IDR from Yahoo Finance, times BCA's markup (`MARKUP`, default 0.53%).
  Tracks the myBCA / Pocket Valas rate within a few rupiah cents and moves ahead of BCA's website.
  The markup was measured once (app 113.88 vs market 113.28) - recheck it now and then and adjust.
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
   - variable `TARGET` (e.g. `105`)
   - optional variables `SOURCE`, `MARKUP`, `RATE_TYPE`
4. Run the workflow once with "Run workflow" to confirm it can reach Yahoo and ntfy.

You get one notification each time the rate crosses the target.
The alert re-arms once the rate goes back above the target.
