Run a Prisma migration for the schema changes described: $ARGUMENTS

Steps:
1. Review the current `prisma/schema.prisma` to understand what exists.
2. Make the required schema changes.
3. Run: `pnpm prisma migrate dev --name <descriptive-name>`
4. If the Prisma client needs regenerating: `pnpm prisma generate`
5. Update any affected TypeScript types or service methods to use the new fields/models.

Migration naming convention: use snake_case, e.g. `add_approval_status`, `create_jira_log_table`.
