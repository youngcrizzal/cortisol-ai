Add a new Telegram bot command `/$ARGUMENTS` to the existing bot.

Steps:
1. In `src/modules/telegram/telegram.update.ts`, add a `@Command('$ARGUMENTS')` handler method.
   - Reply text must be in **Vietnamese**.
   - Keep the handler thin — delegate business logic to `TelegramService`.
2. In `src/modules/telegram/telegram.service.ts`, add the corresponding service method.
3. Update the help text in the `@Help()` handler in `telegram.update.ts` to include the new command.
4. If the command needs a new Prisma model, add it to `prisma/schema.prisma` and remind me to run `pnpm prisma migrate dev`.

Reference existing commands (`/payment_voucher`) for the pattern to follow.
