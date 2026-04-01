Implement or update the Telegram inline-button approval flow for payment vouchers.

Context:
- Approval chain: chị Quỳnh → chị Linh → anh Long
- Each approver receives a Telegram message with voucher info + "Xác nhận" (approve) and "Hoàn" (reject) inline buttons
- On approve: forward to next approver in chain; if last approver, notify chị Quỳnh
- On reject: stop chain, notify the previous approver to update the voucher

The task: $ARGUMENTS

Implementation notes:
- Use Telegraf inline keyboards (`Markup.inlineKeyboard`)
- Handle callback queries with `@Action(...)` decorator in `telegram.update.ts`
- Store approval state in the `Approval` Prisma model (already in schema)
- Call the ERP API to update voucher status after each approval/rejection
- All messages in Vietnamese
