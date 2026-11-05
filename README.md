# jpy-rate-alert

Pushes a phone notification (via ntfy) when the JPY price at BCA drops to a target.

## Sources

- `market` (default): live JPY/IDR mid-market rate from Wise, times BCA's markup (`MARKUP`, default 0.10%).
  Moves ahead of BCA's website, which lags the app.
  Measured on 21 Oct 2026 (7 readings, 09:10-09:49 WIB): the myBCA app was 0.07-0.14% above Wise, mean 0.103%.
  BCA moves its rate in steps behind the market, so expect the estimate within about +/-Rp0.04.
  Recheck it now and then and set the `MARKUP` variable if it drifts.
  Outside BCA business hours (evenings, nights, early mornings) BCA widens its spread: on 5 Nov 2026 at 07:44 WIB its e-Rate sell was 1.1% over Wise, not 0.1%.
  So this source also reads BCA's website and only alerts when its e-Rate sell is at or below the target plus `BCA_TOLERANCE` (default 0.3, covering the website lagging the app during the day).
  If the BCA page can't be fetched, the alert still goes out, marked "UNCHECKED".
- `bca`: the public page https://www.bca.co.id/id/informasi/kurs, the price itself.
  The website has matched the myBCA app when checked, and BCA's markup changes through the day, so this is the recommended source.
  On 5 Nov 2026 it was 115.84 (+1.0% over market) at 08:00 WIB and 114.96 (+0.3%) at 08:06 WIB.

## Margin alert

`MARGIN_ALERT` (e.g. `0.003` = 0.3%) alerts when BCA's e-Rate sell is at most that far above the Wise market rate.
It flags a cheap moment to buy whatever the price level, and works with either source, alongside `TARGET` or on its own.
If Wise or BCA can't be fetched, the margin check is skipped for that run instead of failing it.

The alert says "check myBCA": always confirm the real rate in the app before buying.

## Setup

1. Install the ntfy app (Android/iOS) and subscribe to a hard-to-guess topic, e.g. `jpy-alert-7f3k9q`.
   Topics are public, so anyone who knows the name can read or post to it.
2. Local test: `TARGET=115 NTFY_TOPIC=jpy-alert-7f3k9q node check-rate.mjs` (115 triggers right away).
   Delete `state.json` afterwards to re-arm.
3. Push to a GitHub repo, then under Settings > Secrets and variables > Actions add:
   - secret `NTFY_TOPIC`
   - variable `TARGET`: one level (`113.25`) or several, comma-separated (`113.5,113.25`)
   - and/or variable `MARGIN_ALERT` (at least one of the two)
   - optional variables `SOURCE`, `MARKUP`, `BCA_TOLERANCE`, `RATE_TYPE`
4. Run the workflow once with "Run workflow" to confirm it can reach Wise and ntfy.

You get a notification when the rate crosses a target, then one reminder per day (WIB) while it stays at or below it.
Going back above the target re-arms it, so the next drop alerts immediately.
