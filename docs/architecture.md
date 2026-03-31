# Cortisol AI — Architecture Document

## 1. Tổng quan hệ thống

```
┌─────────────────────────────────────────────────────────────────┐
│                        NGƯỜI DÙNG                               │
│            (chị Quỳnh, chị Linh, anh Long, kế toán)            │
└─────────────────────┬───────────────────────────────────────────┘
                      │ Telegram messages / inline buttons
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                     TELEGRAM BOT API                            │
└─────────────────────┬───────────────────────────────────────────┘
                      │ Webhooks / Long polling
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    CORTISOL AI (NestJS)                         │
│                                                                 │
│  ┌─────────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │  Telegram   │  │   Cron   │  │  Report  │  │    Jira    │  │
│  │   Module    │  │  Module  │  │  Module  │  │   Module   │  │
│  └──────┬──────┘  └────┬─────┘  └────┬─────┘  └─────┬──────┘  │
│         │              │             │               │          │
│  ┌──────▼──────────────▼─────────────▼───────────────▼──────┐  │
│  │                   HTTP Service                            │  │
│  │              (JWT auth + retry logic)                     │  │
│  └──────────────────────────┬────────────────────────────────┘  │
│                             │                                   │
│  ┌──────────────────────────▼────────────────────────────────┐  │
│  │               PostgreSQL (via Prisma)                     │  │
│  │   TelegramUser | VoucherPollState | ChartOfAccounts       │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────┬───────────────────────────────────────────┘
                      │ REST API (JWT Bearer)
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    TWENDEE ERP (NestJS)                         │
│   /api/accounting/vouchers  |  /api/jira/worklogs               │
│   /api/auth/login           |  /api/user-link                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Module breakdown

### 2.1 Telegram Module (`src/modules/telegram/`)

Điểm vào duy nhất cho tất cả tương tác Telegram.

```
telegram/
  telegram.module.ts      # Khai báo TelegrafModule với bot token
  telegram.update.ts      # Xử lý commands & callback queries (controller layer)
  telegram.service.ts     # Business logic: approve, reject, send notifications
```

**Trách nhiệm:**
- Nhận Telegram commands (`/start`, `/payment_voucher`, ...)
- Xử lý inline button callbacks (`approve:<id>`, `reject:<id>`)
- Gửi tin nhắn chủ động đến từng user qua `bot.telegram.sendMessage`
- Map Telegram chat ID ↔ ERP User ID

**KHÔNG làm:**
- Không gọi ERP trực tiếp — ủy quyền cho `HttpService`
- Không chứa Prisma queries — ủy quyền cho service

---

### 2.2 Cron Module (`src/modules/cron/`)

Điều phối toàn bộ công việc định kỳ.

```
cron/
  cron.module.ts
  cron.service.ts    # @Cron jobs
```

| Job | Schedule | Mô tả |
|---|---|---|
| `pollNewVouchers` | Mỗi 30 giây | Lấy phiếu `status=PROCESSING` từ ERP, gửi Telegram nếu chưa xử lý |
| `weeklyJiraAlert` | Thứ 2, 8:00 sáng | Tính giờ tự học tuần trước, cảnh báo vi phạm |

**Dedup voucher:** Lưu `voucherId` đã gửi vào bảng `VoucherPollState` để tránh gửi 2 lần.

---

### 2.3 HTTP Module (`src/modules/http/`)

Thin wrapper quanh `@nestjs/axios`. Xử lý JWT auth tập trung.

```
http/
  http.module.ts
  http.service.ts    # get/post/put/delete + auto auth header
```

**Token management flow:**
```
Request đến
    │
    ▼
Có accessToken trong memory?
    │ Không              │ Có
    ▼                    ▼
POST /auth/login    Đính kèm Authorization header
    │                    │
    ▼                    ▼
Lưu token           Gọi ERP
    │                    │
    │               Nhận 401?
    │                    │ Có
    │                    ▼
    │               POST /auth/refresh
    │                    │
    │               Retry request
    └────────────────────┘
```

---

### 2.4 Report Module (`src/modules/report/`) — Planned

Xử lý file Excel và tích hợp AI.

```
report/
  report.module.ts
  report.service.ts     # Parse Excel, build summary, call OpenAI
  report.update.ts      # Telegram @On('document') handler
```

**Pipeline:**
```
Nhận file .xlsx qua Telegram
        ↓
Validate headers (danh sách tài khoản / sổ cái)
        ↓
Parse với ExcelJS
        ↓
Build summary: group by (accountCode, month) với rollup cha-con
        ↓
Lưu vào memory (transient, không persist)
        ↓
Export file Excel tổng hợp → gửi Telegram document
        ↓
Sẵn sàng nhận NL queries từ user
```

**NL Query pipeline:**
```
User gửi câu hỏi
        ↓
Gọi OpenAI GPT-4 với context (danh sách TK + tóm tắt dữ liệu)
        ↓
Nhận JSON filter { accountCode, period, type }
        ↓
Query data trong memory
        ↓
Format kết quả → gửi Telegram
```

---

### 2.5 Jira Module (`src/modules/jira/`) — Planned

Lấy và tính toán giờ work-log từ ERP.

```
jira/
  jira.module.ts
  jira.service.ts    # getWorklogs, calcSelfLearningHours, findViolations
```

**Self-learning calculation:**
```typescript
selfLearning = standardHours - loggedHours

standardHours = workingDaysInWeek × 8
              - approvedLeaveHoursInWeek
              - publicHolidayHoursInWeek

// loggedHours: sum of timeSpentSeconds / 3600 từ /api/jira/worklogs
```

---

## 3. Data flow: Phê duyệt phiếu chi

```
┌──────────┐         ┌──────────────┐         ┌──────────┐
│   ERP    │         │  Cortisol AI │         │ Telegram │
└────┬─────┘         └──────┬───────┘         └────┬─────┘
     │                      │                      │
     │   [Cron: 30s]        │                      │
     │◄─────────────────────│                      │
     │  GET /vouchers        │                      │
     │  ?status=PROCESSING   │                      │
     │──────────────────────►│                      │
     │  { data: [voucher] }  │                      │
     │                      │                      │
     │                      │ Check VoucherPollState│
     │                      │ (dedup đã gửi chưa?) │
     │                      │                      │
     │  GET /vouchers/:id   │                      │
     │◄─────────────────────│                      │
     │  { voucher details } │                      │
     │──────────────────────►│                      │
     │                      │                      │
     │                      │ sendMessage(Quỳnh)   │
     │                      │─────────────────────►│
     │                      │  [Phiếu + 2 nút]    │
     │                      │                      │
     │                      │◄─────────────────────│
     │                      │ callbackQuery        │
     │                      │ "approve:<voucherId>"│
     │                      │                      │
     │  POST /approve       │                      │
     │◄─────────────────────│                      │
     │  { status: ok }      │                      │
     │──────────────────────►│                      │
     │                      │                      │
     │  GET /vouchers/:id   │                      │
     │◄─────────────────────│                      │
     │  { approvals: [...] }│                      │
     │──────────────────────►│                      │
     │                      │                      │
     │                      │ editMessage(Quỳnh)   │ ← xóa nút
     │                      │─────────────────────►│
     │                      │                      │
     │                      │ sendMessage(Linh)    │ ← người tiếp theo
     │                      │─────────────────────►│
     │                      │  [Phiếu + 2 nút]    │
```

---

## 4. Database Schema (local)

Cortisol AI chỉ lưu trạng thái local cần thiết — **không** mirror toàn bộ ERP.

```prisma
// Đã có
model TelegramUser {
  telegramId  String  @id          // Telegram chat ID
  username    String?
  firstName   String?
  lastName    String?
  erpUserId   String?              // ERP User.id — để map
}

// Cần thêm
model VoucherPollState {
  voucherId       String   @id     // ERP Voucher.id
  lastKnownStatus String           // PROCESSING | APPROVED | REJECTED
  notifiedAt      DateTime         // Lần cuối gửi thông báo
  messageIds      Json             // { telegramId: messageId } để edit/delete
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model ChartOfAccounts {
  code        String  @id          // e.g. "123", "123.1"
  name        String
  parentCode  String?              // null = tài khoản gốc
  type        String               // "thu" | "chi"
  isActive    Boolean @default(true)
}
```

---

## 5. Approval chain config

Chuỗi duyệt không hard-code — lấy từ `VoucherApproval.index` của ERP:

```
index 0 → chị Quỳnh  (ERP User ID: lấy từ approvals[0].approverId)
index 1 → chị Linh   (ERP User ID: lấy từ approvals[1].approverId)
index 2 → anh Long   (ERP User ID: lấy từ approvals[2].approverId)
```

Map ERP User ID → Telegram chat ID qua `TelegramUser.erpUserId`.

---

## 6. Security

| Điểm | Biện pháp |
|---|---|
| ERP credentials | Lưu trong `.env`, inject qua `ConfigService`, không log |
| Telegram bot token | Lưu trong `.env` |
| ERP access token | Chỉ lưu trong memory process (không persist ra DB/disk) |
| Callback query auth | Validate `ctx.from.id` → phải là người được phép duyệt phiếu đó |
| OpenAI API key | Lưu trong `.env` |
| File upload | Chỉ chấp nhận `.xlsx`/`.xls`; giới hạn size |

---

## 7. Environment variables

```bash
# Telegram
TELEGRAM_BOT_TOKEN=

# ERP
ERP_BASE_URL=https://erp.company.com
ERP_USERNAME=
ERP_PASSWORD=

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/cortisol

# AI
OPENAI_API_KEY=

# App
NODE_ENV=production
PORT=3000
```

---

## 8. Deployment

```
┌────────────────────────────────┐
│          VPS / Docker          │
│                                │
│  ┌──────────────────────────┐  │
│  │   cortisol-ai (NestJS)   │  │
│  │   node dist/main.js      │  │
│  │   PORT=3000              │  │
│  └──────────────────────────┘  │
│                                │
│  ┌──────────────────────────┐  │
│  │   PostgreSQL             │  │
│  │   port 5432              │  │
│  └──────────────────────────┘  │
└────────────────────────────────┘
```

**Telegram bot mode:** Long polling (không cần public URL). Phù hợp cho internal deployment.

**Build & run:**
```bash
pnpm build
node dist/main.js
```

---

## 9. Phụ thuộc cần bổ sung (chưa có trong package.json)

| Package | Dùng cho |
|---|---|
| `exceljs` | Parse + generate file Excel |
| `openai` | Gọi GPT-4 cho NL queries |
| `@types/multer` | Nhận file upload qua Telegram / HTTP |
