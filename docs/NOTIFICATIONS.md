# In-app notifications (the bell)

The bell in the dashboard header tells signed-in users about things that need their attention or that they will want to know about. These are **inbox notifications**, separate from the email/SMS/WhatsApp `notifications` the worker sends through API vendors (docs/VENDORS.md).

## 1. Model

`inbox_notifications`: one row **per recipient user**, so read state is per user.

| Column | Notes |
| --- | --- |
| `id` | `inb_<ulid>` |
| `user_id`, `organization_id` | The recipient, and the organization the event belongs to |
| `category` | `PAYMENT`, `PAYOUT`, `SETTLEMENT`, `COMPLIANCE`, `RISK`, `SECURITY`, `WEBHOOK`, `REPORT`, `SYSTEM`. Picks the icon. |
| `severity` | `INFO`, `SUCCESS`, `WARNING`, `CRITICAL`. Picks the colour. |
| `title` (≤140), `body` (≤500) | Plain text. **Never** full account numbers, secrets, OTPs or tokens: account numbers are masked (`XXXXXX4521`). |
| `link` | Optional in-app path. A CHECK constraint allows only relative paths (`/…`, not `//…`), so a notification can never link off-site. |
| `resource_type`, `resource_id` | What it is about |
| `dedupe_key` | Unique per user. A replayed event (a duplicate bank callback, a retried job) does not notify twice. |
| `read_at` | Null while unread |

Recipients are resolved by `notifyInbox()` (`packages/database/src/inbox.ts`). The audience is either a **permission** within the organization (e.g. every ACTIVE member whose role has `payout.approve`) or explicit user ids, minus any exclusions (e.g. the maker of a payout is not asked to approve it). Tenancy comes from the event, never from a request body.

`notifyInbox()` runs **in the caller's transaction**, so a notification exists only if the business change it describes committed.

## 2. What rings the bell

| Event | Who | Severity |
| --- | --- | --- |
| Payout awaiting approval | Merchant `payout.approve` holders, except the maker | WARNING |
| Payout held for risk review | Merchant `payout.read`; platform `risk.review` | WARNING |
| Payout failed / returned by the bank | Merchant `payout.read` | WARNING / CRITICAL |
| Payout rejected (risk, or by a checker) | Merchant `payout.read` / the maker | WARNING / INFO |
| Refund failed | Merchant `payin.read` | WARNING |
| Settlement sent / failed | Merchant `settlement.read` | SUCCESS / CRITICAL |
| Application submitted | Platform `compliance.approve` | INFO |
| Application approved, information requested, rejected, suspended, reactivated | Merchant `merchant.read` | varies |
| Risk rule hit (non-payout subjects) | Platform `risk.review` | WARNING |
| Webhook endpoint disabled after repeated failures | Merchant `webhook.manage` | CRITICAL |
| Report export ready / failed | The requester | SUCCESS / WARNING |
| Sign-in from a new browser/OS + IP (not the first sign-in) | That user | WARNING |

Merchant-event rules live in `apps/api/src/infra/inbox-rules.ts`; the others sit next to the code that causes them.

## 3. Real time, no polling

```
INSERT inbox_notifications ──trigger──▶ pg_notify('inbox_notification', {id, user_id})
                                          │ (delivered only on COMMIT)
             every API node: LISTEN ◀─────┘
                    │ load row, check owner
                    ▼
     SSE  GET /v1/inbox/stream  ──▶  browser (fetch stream, bearer token)
                                          │
                       merge into React Query cache: badge, drawer, toast
```

- **Delivery:** an AFTER INSERT trigger calls `pg_notify`. Postgres delivers notifications only when the transaction commits, so a rolled-back change pushes nothing. The payload holds ids only; the API node reloads the row.
- **Server:** each API node keeps **one** dedicated `pg` connection doing `LISTEN` (`DATABASE_LISTEN_URL`, default `DATABASE_URL`). It must be a direct or session-mode connection, not a transaction-mode pooler such as PgBouncer.
  - **Streams:** each open stream is keyed by user. An event is written only to that user's streams, at most 10 per user.
  - **Keep-alive:** a heartbeat comment is sent every 25 s, and streams are recycled every 10 minutes so token expiry and load balancers are respected.
  - **Proxies:** `X-Accel-Buffering: no` disables proxy buffering.
- **Reconnects:** if the LISTEN connection drops, the node reconnects with backoff and sends `resync` to every stream so clients refetch anything they missed.
- **Client** (`apps/web/src/features/notifications/`):
  - **Transport:** `EventSource` cannot send an `Authorization` header, so the stream is read with `fetch` and parsed as SSE.
  - **First event:** `ready` carries the unread count.
  - **New items:** each `notification` event is prepended to the cached lists and increments the badge. A toast appears when the drawer is closed, and the tab title shows `(n)`.
  - **Recovery:** the client reconnects with backoff. On 401 it refreshes the session first. On `resync`, or when the browser comes back online, it refetches.
- **No polling:** while connected, the dashboard makes **no** periodic `/v1/inbox` requests. The drawer header shows **Live** or **Offline**.

## 4. API

All routes are for the signed-in user only. Another user's id returns 404.

| Route | |
| --- | --- |
| `GET /v1/inbox?unread=true&limit=&cursor=` | Newest first, keyset-paginated |
| `GET /v1/inbox/unread-count` | `{ unread }` |
| `GET /v1/inbox/stream` | `text/event-stream`: `ready`, `notification`, `resync` |
| `POST /v1/inbox/:id/read`, `POST /v1/inbox/:id/unread` | Returns the new `{ unread }` |
| `POST /v1/inbox/read-all` | |

## 5. The drawer

- **Opening:** click the bell. The red badge shows the unread count (99+).
- **Header:** a right-side drawer with the **Live** indicator and **Mark all as read**.
- **Tabs:** **All** and **Unread**. Items are grouped Today / Yesterday / Earlier.
- **Items:** each shows a category icon in its severity colour and a blue dot when unread. Hovering shows mark read / unread.
- **Click:** opens the item's page and marks it read.
- **Paging:** **Load older** pages back through history.
- Works in light and dark mode.

## 6. Retention and operations

- **Retention:** rows are not ledger data and may be pruned. An index on `created_at` supports a periodic delete of read items older than 90 days (not yet scheduled).
- **Scaling:** every API node holds one extra Postgres connection for LISTEN. With N nodes that is N connections, regardless of how many browsers are connected.
- **If pushes stop:** check the API log for `Inbox LISTEN` warnings and that `DATABASE_LISTEN_URL` points at a direct connection. Clients still get correct data on reconnect, because of the `resync` refetch.
