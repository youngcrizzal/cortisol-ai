# Cortisol AI — Project Guide

## What this is

NestJS backend powering a Telegram bot that automates accounting/ERP workflows for the finance team. Acts as a middleware layer between the Twendee ERP (twendee-erp-main) and Telegram.

Three core features:

1. **Payment voucher approval flow** — Poll ERP for vouchers awaiting approval, push Telegram messages with inline "Xác nhận / Hoàn" buttons, call ERP approve/reject API on button press, route through chain: chị Quỳnh → chị Linh → anh Long.
2. **Financial report generation** — Parse uploaded Excel ledger files, generate cash-flow summary reports, and answer natural-language queries via AI (GPT-4, Vietnamese).
3. **Project participation % report** — Pull Jira work-log data from ERP, compute self-learning hours per employee (max 30h/month), alert chị Quỳnh every Monday for violations.

## Stack

| Layer | Tech |
|---|---|
| Framework | NestJS 11 (TypeScript) |
| DB | PostgreSQL via Prisma 7 |
| Bot | Telegraf 4 + nestjs-telegraf |
| HTTP client | @nestjs/axios (wrapped in `HttpService`) |
| Scheduler | @nestjs/schedule |
| AI | ChatGPT-4 (Vietnamese NL queries) |
| Package manager | pnpm |

## ERP Integration

### Base URL & Auth

```
ERP_BASE_URL=<erp host>      # e.g. https://erp.company.com/api
ERP_USERNAME=<service account>
ERP_PASSWORD=<password>
```

**Auth flow:**
1. `POST /api/auth/login` → `{ accessToken, refreshToken }`
2. All requests: `Authorization: Bearer <accessToken>`
3. Refresh: `POST /api/auth/refresh` when 401 received

Store tokens in memory (or Redis if needed). The `HttpService` wrapper should handle token injection.

> **No webhooks exist.** The ERP uses internal EventEmitter2 only. cortisol-ai must **poll** for new/changed vouchers.

### Key ERP Endpoints

#### Vouchers
| Method | Path | Use |
|---|---|---|
| GET | `/api/accounting/vouchers` | Poll for new PROCESSING vouchers |
| GET | `/api/accounting/vouchers/:id/detail` | Get full voucher details |
| POST | `/api/accounting/vouchers/:id/approve` | Approve one step `{ comments? }` |
| POST | `/api/accounting/vouchers/:id/reject` | Reject `{ comments? }` |

**Poll query params for vouchers needing approval:**
```
voucherType=PAYMENT&status=PROCESSING&page=1&limit=20&sortBy=postingDate&sortOrder=desc
```

#### Jira / Work-logs
| Method | Path | Use |
|---|---|---|
| GET | `/api/jira/worklogs` | Get work-log hours per employee |
| POST | `/api/jira/sync` | Trigger full Jira data sync |

#### User Links
| Method | Path | Use |
|---|---|---|
| GET | `/api/user-link` | Map ERP user → Telegram chat ID |

### Voucher status lifecycle
```
DRAFT → PROCESSING → APPROVED
                   → REJECTED
         (any step) → CANCELLED
```

### Approval step fields
```ts
{
  id: string
  voucherId: string
  approverId: string        // ERP User ID
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SKIPPED'
  index: number             // 0-based step order
  comments?: string
  approver: { id, username, email }
}
```

Next approver to notify = approval with `status === 'PENDING'` and lowest `index`.

## Module layout

```
src/
  modules/
    telegram/     # Bot commands, inline keyboards, approval flow
    cron/         # Scheduled jobs (Monday alert, periodic ERP poll)
    http/         # Axios wrapper — all external calls go here
    report/       # (planned) Financial report generation
    jira/         # (planned) Jira work-log integration
  prisma/         # PrismaService
  lib/            # Pure helpers (voucher.ts, etc.)
  types/          # Global TypeScript declarations (erp.d.ts, payment.d.ts)
```

## Approval chain

```
chị Quỳnh (index 0) → chị Linh (index 1) → anh Long (index 2)
```

- ERP maps `approverId` to ERP User IDs; we map those to Telegram chat IDs via `UserLink` table or our own `TelegramUser` table.
- If any approver rejects → stop chain, call `POST /api/accounting/vouchers/:id/reject`, notify previous approver.
- If anh Long approves → ERP status becomes APPROVED → notify chị Quỳnh.

## Self-learning hours logic

```
Standard hours = working days in month (from join date or month start) × 8h
               - approved leave hours (paid + unpaid)
               - public holiday hours

Self-learning hours = Standard hours − Sum of Jira logged hours

Alert if self-learning > 30h in rolling week (check every Monday, flag prior Mon–Fri)
```

## Coding rules

- All Telegram reply text is in **Vietnamese**.
- Use `HttpService` (not raw Axios) for every external call.
- Put Prisma queries in `*Service`, never in `*Update`.
- New Telegram commands → `telegram.update.ts`; logic → `telegram.service.ts`.
- New cron jobs → `cron.service.ts`; use `CronExpression.*` enum.
- Use `@nestjs/config` + `.env` for all secrets — never hard-code.
- All Prisma schema changes must have a migration.
- Type all ERP response payloads in `src/types/erp.d.ts`.

## Environment variables

```
TELEGRAM_BOT_TOKEN=
ERP_BASE_URL=
ERP_USERNAME=
ERP_PASSWORD=
DATABASE_URL=
OPENAI_API_KEY=
```

## Common commands

```bash
pnpm start:dev               # Run in watch mode
pnpm prisma studio           # Browse DB
pnpm prisma migrate dev      # Apply schema changes
pnpm build                   # Compile
pnpm lint                    # Lint + fix
```
