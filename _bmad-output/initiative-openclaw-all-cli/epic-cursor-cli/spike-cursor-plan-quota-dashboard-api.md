# Spike: Cursor plan quota from the dashboard API (ticket 26, issue #82)

Date: 2026-11-10. Host: Linux, `CURSOR_API_KEY` (user API key, Ultra plan, personal account), `NODE_USE_ENV_PROXY=1`, OpenClaw 2026.10.3. No secret, token, or account id is recorded here.

## Answer

**Cursor returns usable plan quota data.** With the access token that `POST https://api2.cursor.sh/auth/exchange_user_api_key` returns for the key (the exchange `src/adapters/cursor/usage.ts` already does; JWT `type: api_key_token`, lifetime 3 600 s), these Connect-JSON calls (`POST /aiserver.v1.DashboardService/<Method>`, body `{}`, header `Connect-Protocol-Version: 1`) answer 200:

| Need | Method | Fields |
| --- | --- | --- |
| Plan, period end | `GetPlanInfo` | `planInfo.planName` ("Ultra"), `price` ("$200/mo"), `billingCycleEnd` (epoch ms, string), `planOwner`, `includedUsagePeriod` (`INCLUDED_USAGE_PERIOD_MONTHLY`) |
| Period, limits, spend, reset | `GetCurrentPeriodUsage` | `billingCycleStart`, `billingCycleEnd` (epoch ms, strings), `planUsage.{totalSpend, includedSpend, bonusSpend, limit}` (cents, numbers; `limit` = included spend, 40000 = $400 on Ultra), `planUsage.{totalPercentUsed, autoPercentUsed, apiPercentUsed}` (0-100 floats), `spendLimitUsage.limitType` ("user"; no amounts on this account, which has no on-demand limit), `displayThreshold`, `enabled`, three display messages, `autoBucketModels` |
| Per-model usage and spend | `GetAggregatedUsageEvents` | `aggregations[{modelIntent, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalCents, tier}]`, `totalCostCents`, token totals, `startDate`; the cycle to date (a date range in the body is accepted) |
| Spend limit policy | `GetUsageLimitStatusAndActiveGrants`, `GetUsageLimitPolicyStatus`, `GetHardLimit` | `canConfigureSpendLimit`, `onDemandMinCents`/`onDemandMaxCents`/`recommendedOnDemandLimitCents`, `noUsageBasedAllowed` |
| Identity | `GetMe` | account fields; not needed, not read |

Empty (`{}`): `GetUsageBasedPremiumRequests`, `GetCreditGrantsBalance`, `GetTeams`, `GetPricingHistory`. 404: `GetDailyUsage`, `GetUsageSummary`, `GetMonthlyUsage`, `GetSpendLimit`. `GetTeamSpend`: 401 "Team ID is required" (personal account).

## Facts that decide the design

- Cheap: about 100 ms per call; no rate-limit headers seen. A bad token answers 401, a bad key at the exchange 401.
- Only values Cursor reports are needed: the three percents map to quota windows (Total, Auto + Composer, API models) with `billingCycleEnd` as the reset time; the cents fields give a spend summary line (included spend of its limit, bonus). Percent and cents are Cursor's own numbers; spend is in cents (`totalCostCents` of the aggregation, 102 099, agrees with `totalSpend`, 102 122).
- `totalSpend` can exceed the included `limit` through `bonusSpend` (Cursor's free usage on top of the plan), so `used / limit` is not the Total percent: use Cursor's percent.
- **API key against a login-only account: not tested.** No login-only account was available (this host has the key only). A login-only host has no key for the plugin to exchange, and the plugin does not read the login's token files, so it shows no quota there.
- Team accounts: not tested (`GetTeamSpend` needs a team id).
- Chosen cache TTL: 60 s (the host's own Models-page usage cache is 60 s; a reading is 2 calls and the token is reused), back-off 10 minutes after a failure (as the per-turn reader).

## OpenClaw 2026.10.3 hook contract (read from `.spike/openclaw`)

- `ProviderPlugin.resolveUsageAuth(ctx)` returns `{token, accountId?}`, `{handled: true}`, or nothing; `fetchUsageSnapshot(ctx)` (ctx has `token`, `signal`, `timeoutMs`, `fetchFn`, `config`, `env`) returns `ProviderUsageSnapshot {provider, displayName, windows[{label, usedPercent, resetAt?}], billing?, summary?, plan?, error?}`; `null` becomes "Unsupported provider".
- The provider is listed for usage only when the manifest declares `contracts.usageProviders: ["cursor-cli"]`.
- **Gate:** the host calls `resolveUsageAuth` only when it sees a credential source for the provider: a `models.providers.<id>.apiKey`, a provider auth env var set in the Gateway's env, a manifest `providerUsageAuthEnvVars` entry set in the Gateway's env, or an auth profile for the provider (`models auth paste-api-key`). A key held only in the plugin config (`cursor-cli.env`, the preferred setup) opens none of these, so the quota shows only with one of the others; that must be in the docs.
- The Control UI caches usage for 60 s per agent.

## Build

Built in ticket 26: port `readQuota`, `src/adapters/cursor/quota.ts`, `src/core/quota.ts`, wiring in `register.ts`, manifest entries, `test/quota.test.ts`, docs. Tested offline; live read with the key returned a snapshot.
