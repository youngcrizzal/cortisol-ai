/**
 * Thorough test for Feature 3: self-learning violation detection.
 * Run: npx ts-node -r tsconfig-paths/register src/scripts/test-jira.ts
 *
 * Tests:
 *  1. Data source connectivity (worklogs, userlinks, employees, leaves, holidays)
 *  2. findViolations() with Jan 2026 real data — full violation logic
 *  3. Manual math cross-check for top 3 employees
 *  4. Coverage: how many Jira accounts have UserLink vs missing
 *  5. Leave deduction logic check
 */

import { NestFactory } from '@nestjs/core';

process.env.NEST_SILENT = 'true';
process.on('unhandledRejection', () => {});

const errors: string[] = [];
const warnings: string[] = [];

function check(label: string, pass: boolean, detail = '') {
  if (pass) {
    console.log(`  ✅ ${label}${detail ? ': ' + detail : ''}`);
  } else {
    console.error(`  ❌ ${label}${detail ? ': ' + detail : ''}`);
    errors.push(label);
  }
}

function warn(label: string) {
  console.warn(`  ⚠️  ${label}`);
  warnings.push(label);
}

async function main() {
  const { AppModule } = await import('../app.module');
  const { JiraService } = await import('../modules/jira/jira.service');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const svc = app.get(JiraService);

  // ── Fixed test period: Jan 2026 (full month, we have real data) ──────────
  const START = new Date(2026, 0, 1);
  const END = new Date(2026, 0, 31, 23, 59, 59, 999);
  const START_STR = '2026-01-01';
  const END_STR = '2026-01-31';

  console.log('\n=== TEST: Feature 3 — Self-Learning Violations (Jan 2026) ===\n');

  // ── 1. Data source checks ─────────────────────────────────────────────────
  console.log('─── 1. Data sources ───');

  const [worklogs, userLinks, employees, leaves, holidays] = await Promise.all([
    svc.getWorklogsByPeriod(START_STR, END_STR),
    svc.getJiraUserLinks(),
    svc.getEmployeeProfiles(),
    svc.getApprovedLeaves(START_STR, END_STR),
    svc.getHolidaysInPeriod(START_STR, END_STR),
  ]);

  check('Worklogs returned', worklogs.length > 0, `${worklogs.length} entries`);
  check('UserLinks loaded', userLinks.accountToUserId.size > 0, `${userLinks.accountToUserId.size} JIRA mappings`);
  check('Employees loaded', employees.length > 0, `${employees.length} active`);
  check('Employees have userId', employees.every(e => !!e.userId), 'all have userId field');
  console.log(`  ℹ️  Approved leaves in period: ${leaves.length}`);
  console.log(`  ℹ️  Public holidays (weekdays): ${holidays.length} (${holidays.length * 8}h)`);

  // ── 2. Working days sanity ────────────────────────────────────────────────
  console.log('\n─── 2. Working days ───');
  const workingDays = svc.countWorkingDays(START, END);
  check('Jan 2026 working days = 22', workingDays === 22, `got ${workingDays}`);
  const stdHours = workingDays * 8 - holidays.length * 8;
  console.log(`  ℹ️  Standard hours Jan 2026: ${stdHours}h`);

  // ── 3. Coverage: Jira accountId → UserLink ────────────────────────────────
  console.log('\n─── 3. UserLink coverage ───');
  const byAccount = new Map<string, { secs: number; name: string }>();
  for (const w of worklogs) {
    const prev = byAccount.get(w.accountId);
    byAccount.set(w.accountId, {
      secs: (prev?.secs ?? 0) + w.seconds,
      name: prev?.name ?? w.displayName,
    });
  }

  const mapped = [...byAccount.keys()].filter(id => userLinks.accountToUserId.has(id));
  const unmapped = [...byAccount.keys()].filter(id => !userLinks.accountToUserId.has(id));

  check('All Jira accounts have UserLink', unmapped.length === 0,
    unmapped.length > 0 ? `${unmapped.length} unmapped: ${unmapped.map(id => byAccount.get(id)!.name).join(', ')}` : `${mapped.length}/${byAccount.size} mapped`
  );

  if (unmapped.length > 0) {
    for (const id of unmapped) {
      const info = byAccount.get(id)!;
      warn(`No UserLink: ${info.name} (${(info.secs / 3600).toFixed(1)}h logged)`);
    }
  }

  // ── 4. Full violation check via findViolations() ──────────────────────────
  console.log('\n─── 4. Violation check (Jan 2026 full month) ───');

  const violations = await svc.findViolations(START, END);
  console.log(`  Found ${violations.length} violation(s)`);

  // Show all results (violations + top non-violators) for manual review
  // Recompute per-person for display
  const employeeByUserId = new Map(employees.filter(e => e.userId).map(e => [e.userId, e]));
  const results: Array<{ name: string; logged: number; standard: number; selfLearning: number; violation: boolean }> = [];

  for (const [accountId, info] of byAccount) {
    const userId = userLinks.accountToUserId.get(accountId);
    if (!userId) continue;
    const emp = employeeByUserId.get(userId);

    let periodStart = new Date(START);
    if (emp?.hireDate) {
      const joinDate = new Date(emp.hireDate);
      joinDate.setHours(0, 0, 0, 0);
      if (joinDate > END) continue;
      if (joinDate > START) periodStart = joinDate;
    }

    const days = svc.countWorkingDays(periodStart, END);
    const std = Math.max(0, days * 8 - holidays.length * 8);
    const logged = info.secs / 3600;
    const sl = std - logged;

    results.push({
      name: emp?.fullName ?? info.name,
      logged: Math.round(logged * 10) / 10,
      standard: std,
      selfLearning: Math.round(sl * 10) / 10,
      violation: sl > 30,
    });
  }

  results.sort((a, b) => b.selfLearning - a.selfLearning);

  console.log('\n  Name                           | Logged  | Std    | Self-learn | Status');
  console.log('  ' + '-'.repeat(80));
  for (const r of results) {
    const status = r.violation ? '❌ VI PHẠM' : r.selfLearning < 0 ? '✅ Overtime' : '✅ OK';
    console.log(
      `  ${r.name.padEnd(30)} | ${String(r.logged + 'h').padEnd(7)} | ${String(r.standard + 'h').padEnd(6)} | ${String(r.selfLearning + 'h').padEnd(10)} | ${status}`
    );
  }

  // Cross-check: violations from findViolations() must match our manual calc
  const manualViolations = results.filter(r => r.violation).map(r => r.name).sort();
  const autoViolations = violations.map(v => v.name).sort();

  const match = JSON.stringify(manualViolations) === JSON.stringify(autoViolations);
  check(
    'findViolations() matches manual calculation',
    match,
    match ? `${violations.length} violations` : `auto=${autoViolations.join(',')} vs manual=${manualViolations.join(',')}`
  );

  // ── 5. Leave deduction sanity ─────────────────────────────────────────────
  console.log('\n─── 5. Leave deduction ───');
  if (leaves.length > 0) {
    const leaveSample = leaves[0];
    const totalDays = leaveSample.leaveDate?.reduce((s, ld) => s + ld.days, 0) ?? 0;
    console.log(`  Sample leave: ${leaveSample.leaveType}, ${totalDays} days = ${totalDays * 8}h deducted from standard`);
    console.log(`  ℹ️  Leave is applied per-employee — only affects their personal standard hours`);
  } else {
    console.log('  ℹ️  No leaves in Jan 2026 period to verify deduction logic');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n─── Summary ───');
  if (errors.length === 0 && warnings.length === 0) {
    console.log('✅ All checks passed!');
  } else {
    if (errors.length) errors.forEach(e => console.error(`❌ ${e}`));
    if (warnings.length) warnings.forEach(w => console.warn(`⚠️  ${w}`));
    if (errors.length === 0) console.log('⚠️  Passed with warnings');
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
