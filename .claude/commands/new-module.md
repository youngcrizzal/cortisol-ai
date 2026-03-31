Create a new NestJS feature module named `$ARGUMENTS`.

Steps:
1. Create `src/modules/$ARGUMENTS/` with these files:
   - `$ARGUMENTS.module.ts` — imports HttpModule and PrismaModule if needed
   - `$ARGUMENTS.service.ts` — injectable service with Logger
   - `$ARGUMENTS.controller.ts` (only if HTTP endpoints are needed)
2. Register the new module in `src/app.module.ts` imports array.
3. Follow the patterns in `src/modules/telegram/` as the reference implementation.
4. Use `HttpService` (from `src/modules/http/http.service.ts`) for any external calls.
5. Use `PrismaService` (from `src/prisma/prisma.service.ts`) for DB access.

Do not add unnecessary boilerplate. Only create what the module actually needs.
