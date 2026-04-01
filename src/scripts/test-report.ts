/**
 * Standalone test for report generation.
 * Run: npx ts-node -r tsconfig-paths/register src/scripts/test-report.ts
 *
 * Boots NestJS app context (no HTTP port), generates the cashflow report,
 * validates the output, and prints a detailed result.
 */

import { NestFactory } from '@nestjs/core';
import * as ExcelJS from 'exceljs';
import * as fs from 'fs';
import * as path from 'path';

// Silence nest boot logs
process.env.NEST_SILENT = 'true';

async function main() {
  // Lazy import to avoid circular dep at top level
  const { AppModule } = await import('../app.module');
  const { ReportService } = await import('../modules/report/report.service');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const svc = app.get(ReportService);

  console.log('\n=== TEST: generateCashflowExcel ===\n');

  // ── 1. Generate ─────────────────────────────────────────────────────────
  let buffer: Buffer;
  try {
    buffer = await svc.generateCashflowExcel();
  } catch (err: unknown) {
    console.error('❌ generateCashflowExcel threw:', (err as Error).message);
    await app.close();
    process.exit(1);
  }

  const outPath = '/tmp/test_cashflow_output.xlsx';
  fs.writeFileSync(outPath, buffer);
  console.log(`✅ File written: ${outPath} (${buffer.length} bytes)`);

  if (buffer.length < 5000) {
    console.error('❌ File too small — likely corrupt');
    await app.close();
    process.exit(1);
  }

  // ── 2. Parse output and validate ────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(outPath);
  const sheet = wb.getWorksheet('Cashflow_Misa');

  if (!sheet) {
    console.error('❌ Sheet "Cashflow_Misa" not found');
    await app.close();
    process.exit(1);
  }

  // Jan data column = col G (7)
  const dataCol = 7;
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check formula rows still have formulas (not plain values)
  const formulaRows = [
    { rn: 4, label: 'LÃI/LỖ' },
    { rn: 5, label: 'THU total' },
    { rn: 16, label: 'CHI total' },
    { rn: 66, label: 'CUỐI KỲ' },
  ];

  for (const { rn, label } of formulaRows) {
    const cell = sheet.getRow(rn).getCell(dataCol);
    const v = cell.value;
    const hasFormula = v && typeof v === 'object' && 'formula' in (v as object);
    if (!hasFormula) {
      errors.push(`Row ${rn} (${label}) col G should be a formula but got: ${JSON.stringify(v)}`);
    } else {
      console.log(`✅ Row ${rn} (${label}): formula preserved = "${(v as { formula: string }).formula}"`);
    }
  }

  // Check data rows have non-null values (for accounts we know have data in Jan 2026)
  // Row 7: 131+515.1-635.1 (Thu dự án T&M) — should have value
  // Row 12: 515.2+711.2 (Thu khác) — should have value
  const expectedDataRows = [
    { rn: 7, label: 'Thu dự án T&M (row 7)' },
    { rn: 12, label: 'Thu khác (row 12)' },
  ];

  for (const { rn, label } of expectedDataRows) {
    const v = sheet.getRow(rn).getCell(dataCol).value;
    if (!v || v === 0) {
      warnings.push(`Row ${rn} (${label}): value is ${v} — expected non-zero`);
    } else {
      console.log(`✅ Row ${rn} (${label}): ${Number(v).toLocaleString('vi-VN')} VND`);
    }
  }

  // Print all Jan column data rows
  console.log('\n─── Jan column (G) data dump ───');
  for (let rn = 3; rn <= 66; rn++) {
    const row = sheet.getRow(rn);
    const b = String(row.getCell(2).value ?? '').trim();
    const a = row.getCell(1).value;
    const gCell = row.getCell(dataCol);
    const g = gCell.value;
    const isFormula = g && typeof g === 'object' && 'formula' in (g as object);
    const displayVal = isFormula
      ? `[formula: ${(g as { formula: string }).formula}]`
      : g ? Number(g).toLocaleString('vi-VN') : '-';
    if (g !== null && g !== undefined) {
      const rowLabel = b || (a ? String(a).substring(0, 20) : `row${rn}`);
      console.log(`  Row ${rn.toString().padStart(2)} | ${rowLabel.padEnd(35)} | ${displayVal}`);
    }
  }

  // ── 3. Summary ──────────────────────────────────────────────────────────
  console.log('\n─── Summary ───');
  if (errors.length) {
    for (const e of errors) console.error('❌', e);
  }
  if (warnings.length) {
    for (const w of warnings) console.warn('⚠️ ', w);
  }
  if (!errors.length && !warnings.length) {
    console.log('✅ All checks passed!');
  } else if (!errors.length) {
    console.log('⚠️  Passed with warnings (see above)');
  } else {
    console.log('❌ FAILED');
    await app.close();
    process.exit(1);
  }

  // Force exit — Telegraf polling throws on close in test context
  process.exit(errors.length ? 1 : 0);
}

// Suppress unhandled Telegraf 409 conflicts from background polling
process.on('unhandledRejection', () => {});

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
