# Payment routing

Each payin and payout tries an ordered list of gateways. The list is built by the pure engine in `@pay2all/providers` (`routing/engine.ts`) from:
- the routing rules (**Settings → Routing**);
- each gateway's status and capabilities;
- the routing policy for the service, described below.

The failover executor then walks the list. It moves to the next gateway only when the previous one provably did nothing (docs/PAYOUT_FLOW.md).

## 1. Strategies

A strategy is set separately for PAYIN and for PAYOUT, at `PUT /v1/routing/policies/:service`.

| | PRIORITY (default) | SCORE |
| --- | --- | --- |
| Order | Tier (PRIMARY → SECONDARY → FALLBACK), then healthy before degraded, then specific before global, then rule priority. Success rate, cost and latency only break ties | PRIMARY and SECONDARY form **one pool**. Within the pool: healthy before degraded, then merchant- or reseller-specific before global, then **score**, then priority. FALLBACK always comes after the pool |
| When to use | Fixed contracts or deliberate splits | Several equivalent gateways, where the best-converting one should get the traffic |

In both strategies:
- A rule pinned to a merchant or reseller always beats a generic one, and is never displaced by score.
- Down, disabled or in-maintenance gateways are excluded. Capability and amount limits are still enforced.

## 2. The score

```
score = smoothed conversion × API success rate
smoothed conversion = (success + k·prior) / (success + failed + k)
```

- **Conversion** covers transactions created in the last *window* minutes (default 60) that the gateway finally handled. Success and failure follow docs/ANALYTICS.md §1. It is computed per gateway **and method**: UPI QR and IMPS are scored separately.
- **Prior** is the pooled rate of every gateway for that method in the window. If there are fewer than *k* completed transactions in total, the prior is 0.9.
- **k** is the "Confidence" setting (default 20). A gateway with only a few completed transactions stays near the prior, so one lucky or unlucky payment can't swing routing.
- **API success rate** is the technical health from the provider health samples. It covers timeouts and errors on the create call, including failed attempts that were then routed elsewhere.
- Scores are cached for 30 seconds on each API node, and the policy for 15 seconds.

## 3. Exploration

Without exploration, a gateway that loses traffic stops getting fresh data, so it can never recover. To prevent this, *exploration %* of decisions (default 5%, maximum 20%) try the runner-up first.

This only happens between true peers: both in the pool, both healthy, and with the same specificity. A FALLBACK or a merchant-pinned rule is never promoted. The simulator marks an explored candidate.

## 4. Operating it

- **Settings → Routing** shows the strategy form and a live scoreboard per method: completed transactions, raw conversion, smoothed conversion, API health and score. The simulator shows the score of each candidate.
- Scores are visible even while the strategy is PRIORITY, so a switch can be judged in advance.
- Changing the policy needs `routing.manage`, a recent step-up and a reason. It is audited as `routing.policy.updated` with HIGH severity.
- Merchants and resellers never see gateway names or scores.

## 5. Limits

- Conversion counts the *final* gateway of each transaction. A gateway's definitive create-call failures, which failed over elsewhere, show up in its API health rather than in its conversion.
- Payin failures include customer drop-off (for example, an expired QR), which is not always the gateway's fault. Any difference between gateways is still real, but compare gateways on the same method.
- The default 60-minute window reacts within minutes to an outage, but a quiet night can leave scores close to the prior. The health monitor (DEGRADED/DOWN) remains the fast safety net.
