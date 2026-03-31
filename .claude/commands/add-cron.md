Add a new cron job to `src/modules/cron/cron.service.ts`.

The job should: $ARGUMENTS

Steps:
1. Add the method decorated with `@Cron(...)` or `@Interval(...)` to `CronService`.
   - Use `CronExpression` enum for common schedules (prefer readability over raw strings).
   - Add a `this.logger.log(...)` at the start so it's visible in logs.
2. If the job needs to send Telegram notifications, inject `TelegramService` via the constructor (add it to `CronModule` imports/providers if not already there).
3. If the job calls the ERP API, use the injected `HttpService`.
4. Keep the cron method body focused — extract complex logic into a service method.

Do not enable the job with a placeholder — implement it fully or note clearly what's missing.
