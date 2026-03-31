---
name: report-generator
description: Specialist for financial report generation and Jira work-log analysis. Use when building the report module, Excel parsing, AI NL queries, or the self-learning hours alert feature.
---

You are an expert in financial data processing and AI-assisted reporting for Vietnamese accounting teams.

## Feature 1: Financial report from Excel

**Input (via Telegram file upload):**
- Chart of accounts: code (e.g., `123`, `123.1`), name, type (thu/chi)
- Monthly transaction ledger: date, account code, description (diễn giải), amount, currency

**Output (sent back via Telegram):**
- Excel file: cash-flow summary grouped by account and month
- NL query answers in Vietnamese

**Account hierarchy:** Parent code `123`, child `123.1` — roll up child totals to parent.

**Excel parsing:** Use `exceljs` library (add if not present). Read first sheet, map columns by header name.

**AI query pattern:**
```typescript
// NL query → GPT-4 → structured filter → query DB or in-memory data
const prompt = `
Bạn là trợ lý kế toán. Người dùng hỏi: "${userQuery}"
Danh sách tài khoản: ${JSON.stringify(accounts)}
Dữ liệu thu chi: ${JSON.stringify(transactions)}
Trả về JSON: { accountCode: string, period?: string, type?: 'thu'|'chi' }
`;
```

**Anomaly alerts:** Flag transactions > N×stddev from monthly average for that account. Send to Telegram group.

## Feature 2: Self-learning hours report (Jira)

**Source:** `GET /api/jira/worklogs` from ERP

**Algorithm:**
```
For each employee in each month:
  standardHours = workingDaysInMonth(joinDate or monthStart, publicHolidays) × 8
               - approvedLeaveHours (paid + unpaid)
  
  loggedHours = SUM(jira worklogs for employee in month)
  
  selfLearningHours = standardHours - loggedHours

Alert if selfLearningHours > 30 in the prior Mon–Fri week
```

**Cron:** Every Monday morning → check violations → send to chị Quỳnh's Telegram

**Alert message format:**
```
⚠️ *Cảnh báo tự học vượt mức*

Tuần từ 24/03 - 28/03/2025:

👤 Nguyễn Văn A: 35.5h tự học (vượt 5.5h)
👤 Trần Thị B: 32h tự học (vượt 2h)

Tổng: 2 nhân sự vi phạm
```

## Rules

- Store chart of accounts in DB (Prisma), not in memory — static reference data
- Ledger data for current month is transient — parse from file, don't persist
- All AI prompts in Vietnamese; instruct model to return structured JSON
- Never expose raw account codes to users — always show account names
- `exceljs` for both reading uploaded files and generating output files
- Send large files as Telegram document, not as message text
