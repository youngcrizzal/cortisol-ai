// src/modules/report/report.service.ts

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as path from 'path';
import { PrismaService } from 'src/prisma/prisma.service';
import * as ExcelJS from 'exceljs';
import OpenAI from 'openai';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TkEntry {
  no: number; // Phát sinh Nợ (debit on cash = cash inflow)
  co: number; // Phát sinh Có (credit on cash = cash outflow)
}

export interface LedgerData {
  month: number; // 1–12
  year: number;
  tkMap: Map<string, TkEntry>; // TK đối ứng → totals
  rawRows: Array<{ date: Date | null; voucher: string; desc: string; tkDuong: string; no: number; co: number }>;
}

type UploadMode = 'tai_khoan' | 'so_cai';

// ─── Cashflow template categories ─────────────────────────────────────────────
// section: 'THU' → use .no (cash in), 'CHI' → use .co (cash out)
// accounts: comma-separated. Prefix with '-' to subtract.

interface CfRow {
  section: 'THU' | 'CHI' | 'HEADER';
  label: string;
  group?: string; // sub-group label
  accounts: string; // e.g. '+131,+515.1,-635.1' or ''
}

// Row-level account overrides for template rows with blank/partial/corrupt col A.
// Keys are Excel row numbers in the Cashflow_Misa sheet.
// Values use the same "+/-prefix" format as CASHFLOW_TEMPLATE accounts.
const ROW_ACCOUNTS_OVERRIDE = new Map<number, string>([
  // THU: blank rows (no col A or B)
  [8, ''],    // Thu dự án (Fixed Price) — no account mapping
  [9, ''],    // Thu doanh thu môi giới — no account mapping
  // Row 10 label-fallback would use +515.2,+515.3 but row 12 col A already includes 515.2 → override to avoid double-count
  [10, '+515.3'],  // Thu đầu tư tài chính, tiết kiệm — 515.2 is covered by row 12
  // CHI: Lương dự án group (rows 18-22 are completely blank)
  [18, '+334.1'],              // Lương NV nội bộ (dự án)
  [19, '+334.2'],              // Lương NV thuê ngoài (freelancer)
  [20, '+331'],                // Lương NV vendor
  [21, '+6421-17'],            // Chi phí đào tạo nhân lực
  [22, ''],                    // CP công tác, sự kiện team DA — TK 154.x tính ở Commission Sales (row 43)
  // CHI: Quản lý văn phòng (row 24 has note text, 25-27 blank)
  [24, '+242'],                // Chi phí thuê nhà
  [25, '+6422.2'],             // Điện/Nước/Dịch vụ VP
  [26, '+6422.3,+6422.5'],     // Mua sắm, phục vụ văn phòng
  [27, ''],                   // extra row — no mapping
  // CHI: Chi phí ĐBCL (not in CASHFLOW_TEMPLATE)
  [29, ''],
  [30, ''],
  // CHI: Hành chính/Nhân Sự (row 32 partial, row 33 blank)
  [32, '+334.5,+6421.2'],      // Lương/Thưởng HCNS (was only 6421.2)
  [33, ''],                   // Chi phí hoạt động nội bộ
  // CHI: Kế toán/Tài Chính (row 35 partial, row 36 blank)
  [35, '+334.3,+6422.6'],      // Lương bộ phận Kế toán (was only 6422.6)
  [36, '+6422.7'],             // CP xử lý thuế, kế toán
  // CHI: Sales (row 38 partial)
  [38, '+334.6,+6421.3'],         // Lương NV Sales (334.6 = BD)
  // CHI: Marketing (row 46 — 334.7 = Lương MKT nội bộ)
  [46, '+334.7,+6421.8'],         // Lương MKT nội bộ + công tác
  // CHI: rows with Date objects (ExcelJS parsed account codes like "6422-10" as dates)
  [48, ''],   // CP hạ tầng, công cụ Marketing — no account data
  [50, ''],   // CP Google Workspace — no account data
  [51, ''],   // CP Cloud Server — no account data
  [52, '+6421-11,+2411'],  // Hạ tầng IT + mua sắm tài sản
  // CHI: Chi phí khác (row 63 = col A: 811, row 65 blank)
  [63, '+811,+6422.4,+6421-19'],  // Chi phí khác + 6421-19
  [65, '+6423,+334.8'],           // CP khác + 334.8
]);

const CASHFLOW_TEMPLATE: CfRow[] = [
  // ── THU ────────────────────────────────────────────────────────────────────
  { section: 'THU', label: 'Thu dự án (T&M)', group: 'Thu dự án', accounts: '+131,+515.1,-635.1' },
  { section: 'THU', label: 'Thu dự án (Fixed Price)', group: 'Thu dự án', accounts: '' },
  { section: 'THU', label: 'Thu doanh thu môi giới', group: 'Thu dự án', accounts: '' },
  { section: 'THU', label: 'Thu đầu tư tài chính, tiết kiệm', accounts: '+515.2,+515.3' },
  { section: 'THU', label: 'Thu đầu tư R&D', accounts: '' },
  { section: 'THU', label: 'Thu khác (hoàn lương, cp gửi xe...)', accounts: '+515.2,+711.2' },
  { section: 'THU', label: 'Thu từ khấu trừ thuế CTV', accounts: '+711.1' },
  { section: 'THU', label: 'Lãi/lỗ TG thanh toán', accounts: '+515.1,-635.1' },
  { section: 'THU', label: 'Lãi/lỗ TG rút tiền', accounts: '+515.4,-635.2' },
  // ── CHI ────────────────────────────────────────────────────────────────────
  { section: 'CHI', label: 'Lương NV nội bộ (dự án)', group: 'Lương dự án', accounts: '+334.1' },
  { section: 'CHI', label: 'Lương NV thuê ngoài (freelancer)', group: 'Lương dự án', accounts: '+334.2' },
  { section: 'CHI', label: 'Lương NV vendor', group: 'Lương dự án', accounts: '+331' },
  { section: 'CHI', label: 'Chi phí đào tạo nhân lực', group: 'Lương dự án', accounts: '+6421-17' },
  { section: 'CHI', label: 'CP công tác, công cụ, sự kiện team DA', group: 'Lương dự án', accounts: '+154' },
  { section: 'CHI', label: 'Chi phí thuê nhà', group: 'Quản lý văn phòng', accounts: '+242' },
  { section: 'CHI', label: 'Điện/Nước/Dịch vụ VP', group: 'Quản lý văn phòng', accounts: '+6422.2' },
  { section: 'CHI', label: 'Mua sắm, phục vụ văn phòng', group: 'Quản lý văn phòng', accounts: '+6422.3,+6422.5' },
  { section: 'CHI', label: 'Lương/Thưởng HCNS', group: 'Hành chính/Nhân Sự', accounts: '+334.5,+6421.2' },
  { section: 'CHI', label: 'Chi phí hoạt động nội bộ', group: 'Hành chính/Nhân Sự', accounts: '' },
  { section: 'CHI', label: 'Lương bộ phận Kế toán', group: 'Kế toán/Tài chính', accounts: '+334.3,+6422.6' },
  { section: 'CHI', label: 'CP xử lý thuế, kế toán', group: 'Kế toán/Tài chính', accounts: '+6422.7' },
  { section: 'CHI', label: 'Lương NV Sales', group: 'Sales', accounts: '+334.6,+6421.3' },
  { section: 'CHI', label: 'Công cụ phục vụ Sales', group: 'Sales', accounts: '+6421.4' },
  { section: 'CHI', label: 'Tiếp khách', group: 'Sales', accounts: '+6421.5' },
  { section: 'CHI', label: 'Công tác (Sales)', group: 'Sales', accounts: '+6421.6' },
  { section: 'CHI', label: 'Hội phí tổ chức, hiệp hội', group: 'Sales', accounts: '+6421.7' },
  { section: 'CHI', label: 'Commission Sales', group: 'Sales', accounts: '+154' },
  { section: 'CHI', label: 'Lương NV Marketing', group: 'Marketing', accounts: '+6421-15' },
  { section: 'CHI', label: 'Công tác (Marketing)', group: 'Marketing', accounts: '+6421.8' },
  { section: 'CHI', label: 'Event Marketing', group: 'Marketing', accounts: '+6421.9' },
  { section: 'CHI', label: 'CP hạ tầng, công cụ Marketing', group: 'Marketing', accounts: '' },
  { section: 'CHI', label: 'CP Google Workspace', group: 'Hạ tầng IT', accounts: '' },
  { section: 'CHI', label: 'CP Cloud Server', group: 'Hạ tầng IT', accounts: '' },
  { section: 'CHI', label: 'Mua sắm máy móc', group: 'Hạ tầng IT', accounts: '' },
  { section: 'CHI', label: 'Thuế các loại', group: 'Thuế & Bảo hiểm', accounts: '+3334,+3335,+3339' },
  { section: 'CHI', label: 'BHXH', group: 'Thuế & Bảo hiểm', accounts: '+3383' },
  { section: 'CHI', label: 'BH Tự nguyện', group: 'Thuế & Bảo hiểm', accounts: '+6422.8' },
  { section: 'CHI', label: 'Thưởng bonus dự án', group: 'Thưởng (Bonus)', accounts: '+334.4' },
  { section: 'CHI', label: 'Thưởng bonus tuyển dụng', group: 'Thưởng (Bonus)', accounts: '+334.9,+6421-12' },
  { section: 'CHI', label: 'Thưởng Marketing', group: 'Thưởng (Bonus)', accounts: '+6421-13' },
  { section: 'CHI', label: 'CP tài chính (lãi vay...)', accounts: '+635.1,+635.2' },
  { section: 'CHI', label: 'Chi phí khác', accounts: '+811,+6422.4,+6421-19' },
];

@Injectable()
export class ReportService implements OnModuleInit {
  private readonly logger = new Logger(ReportService.name);

  private readonly uploadModes = new Map<string, UploadMode>();
  private ledgerData: LedgerData | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.loadLatestLedgerFromDb();
  }

  private async loadLatestLedgerFromDb() {
    // Find the most recently uploaded month
    const latest = await this.prisma.ledgerEntry.findFirst({
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    if (!latest) return;

    const entries = await this.prisma.ledgerEntry.findMany({
      where: { month: latest.month, year: latest.year },
    });

    const tkMap = new Map<string, TkEntry>();
    for (const e of entries) {
      tkMap.set(e.tkDuong, { no: e.no, co: e.co });
    }

    this.ledgerData = { month: latest.month, year: latest.year, tkMap, rawRows: [] };
    this.logger.log(`Loaded ledger ${latest.month}/${latest.year} from DB (${entries.length} entries)`);
  }

  // ─── Upload mode ──────────────────────────────────────────────────────────

  setUploadMode(userId: string, mode: UploadMode) {
    this.uploadModes.set(userId, mode);
  }

  consumeUploadMode(userId: string): UploadMode | null {
    const mode = this.uploadModes.get(userId) ?? null;
    this.uploadModes.delete(userId);
    return mode;
  }

  // ─── Chart of accounts: Danh_sach_he_thong_tai_khoan_.xlsx ──────────────
  // Columns: A=STT, B=Số TK, C=Tên TK, D=Tính chất (Dư Nợ/Dư Có), E=Diễn giải, F=Trạng thái

  async parseChartOfAccounts(buffer: Buffer): Promise<number> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];

    let count = 0;
    const upserts: Promise<unknown>[] = [];

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber <= 2) return; // skip title + header
      const code = String(row.getCell(2).value ?? '').trim();
      const name = String(row.getCell(3).value ?? '').trim();
      const tinh_chat = String(row.getCell(4).value ?? '').toLowerCase().trim();
      const status = String(row.getCell(6).value ?? '').toLowerCase().trim();

      if (!code || !name) return;

      const isActive = !status.includes('ngừng');
      const type = tinh_chat.includes('có') ? 'thu' : 'chi';

      upserts.push(
        this.prisma.chartOfAccount.upsert({
          where: { code },
          update: { name, type, isActive },
          create: { code, name, type, isActive, parentCode: null },
        }),
      );
      count++;
    });

    await Promise.all(upserts);
    this.logger.log(`Saved ${count} accounts`);
    return count;
  }

  // ─── Sổ chi tiết: So_chi_tiet_cac_tai_khoan.xlsx ────────────────────────
  // Structure:
  //   Row 1: title "SỔ CHI TIẾT CÁC TÀI KHOẢN"
  //   Row 2: "Loại tiền: ..., Tháng X năm YYYY"
  //   Row 3: blank
  //   Row 4: header (Ngày hạch toán | Ngày CT | Số CT | Diễn giải | TK ĐƯ | Phát sinh Nợ | Phát sinh Có)
  //   Row 5+: "Tài khoản: XXXX" section headers, transaction rows, "Cộng" totals

  async parseSoChi(buffer: Buffer): Promise<{ month: number; year: number; count: number }> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];

    // Extract month/year from row 2
    const row2 = sheet.getRow(2);
    const headerText = String(row2.getCell(1).value ?? '');
    const monthMatch = headerText.match(/Tháng\s+(\d+)\s+năm\s+(\d{4})/i);
    const month = monthMatch ? parseInt(monthMatch[1]) : new Date().getMonth() + 1;
    const year = monthMatch ? parseInt(monthMatch[2]) : new Date().getFullYear();

    const tkMap = new Map<string, TkEntry>();
    const rawRows: LedgerData['rawRows'] = [];

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber <= 4) return; // skip headers

      const colA = String(row.getCell(1).value ?? '').trim();
      const colD = String(row.getCell(4).value ?? '').trim();

      // Skip section headers and summary rows
      if (colA.startsWith('Tài khoản:')) return;
      if (colD === 'Cộng' || colD === 'Số dư đầu kỳ' || colD === 'Số dư cuối kỳ') return;
      if (!colA) return;

      const tkDuong = String(row.getCell(5).value ?? '').trim();
      if (!tkDuong) return;

      const noVal = Number(row.getCell(6).value ?? 0) || 0;
      const coVal = Number(row.getCell(7).value ?? 0) || 0;

      if (noVal === 0 && coVal === 0) return;

      // Parse date (may be Excel serial number or Date object)
      let date: Date | null = null;
      const rawDate = row.getCell(1).value;
      if (rawDate instanceof Date) {
        date = rawDate;
      } else if (typeof rawDate === 'number') {
        // Excel serial → JS Date (correcting for Excel's 1900 leap-year bug)
        date = new Date(Date.UTC(1900, 0, 1) + (rawDate - 2) * 86400000);
      }

      const voucher = String(row.getCell(3).value ?? '').trim();
      const desc = String(row.getCell(4).value ?? '').trim();

      rawRows.push({ date, voucher, desc, tkDuong, no: noVal, co: coVal });

      // Aggregate into tkMap
      if (!tkMap.has(tkDuong)) {
        tkMap.set(tkDuong, { no: 0, co: 0 });
      }
      const entry = tkMap.get(tkDuong)!;
      entry.no += noVal;
      entry.co += coVal;
    });

    this.ledgerData = { month, year, tkMap, rawRows };
    this.logger.log(
      `Parsed sổ chi tiết: ${month}/${year}, ${rawRows.length} transactions, ${tkMap.size} unique TK ĐƯ`,
    );

    // Persist to DB (upsert each TK entry for this month/year)
    await this.prisma.ledgerEntry.deleteMany({ where: { month, year } });
    await this.prisma.ledgerEntry.createMany({
      data: [...tkMap.entries()].map(([tkDuong, entry]) => ({
        month,
        year,
        tkDuong,
        no: entry.no,
        co: entry.co,
      })),
    });
    this.logger.log(`Saved ${tkMap.size} ledger entries to DB for ${month}/${year}`);

    return { month, year, count: rawRows.length };
  }

  hasLedgerData(): boolean {
    return this.ledgerData !== null;
  }

  getLedgerMonthLabel(): string {
    if (!this.ledgerData) return '';
    return `${this.ledgerData.month}/${this.ledgerData.year}`;
  }

  // ─── Abnormal spending check ──────────────────────────────────────────────

  /**
   * So sánh từng hạng mục CHI với ngưỡng cấu hình.
   * Ngưỡng đọc từ env ABNORMAL_CHI_THRESHOLD (đơn vị VND, mặc định 500 triệu).
   * Trả về danh sách các hạng mục vượt ngưỡng.
   */
  checkAbnormalSpending(): Array<{ label: string; amount: number; threshold: number }> {
    if (!this.ledgerData) return [];

    const threshold = Number(process.env.ABNORMAL_CHI_THRESHOLD ?? 500_000_000);
    const { tkMap } = this.ledgerData;
    const anomalies: Array<{ label: string; amount: number; threshold: number }> = [];

    for (const row of CASHFLOW_TEMPLATE) {
      if (row.section !== 'CHI' || !row.accounts) continue;
      const amount = this.computeValue(row.accounts, 'CHI', tkMap);
      if (amount > threshold) {
        anomalies.push({ label: row.label, amount, threshold });
      }
    }

    return anomalies;
  }

  // ─── Account name lookup ──────────────────────────────────────────────────

  private async getAccountName(code: string): Promise<string> {
    try {
      const acc = await this.prisma.chartOfAccount.findFirst({
        where: { code: { startsWith: code.split('.')[0] } },
      });
      return acc?.name ?? code;
    } catch {
      return code;
    }
  }

  // ─── Cashflow value computation ───────────────────────────────────────────

  private computeValue(accounts: string, section: 'THU' | 'CHI', tkMap: Map<string, TkEntry>): number {
    if (!accounts) return 0;

    let total = 0;
    // Parse tokens like "+131", "-635.1", "+515.2,+711.2"
    const tokens = accounts.split(',').map((t) => t.trim());

    for (const token of tokens) {
      const sign = token.startsWith('-') ? -1 : 1;
      const code = token.replace(/^[+-]/, '').trim();

      // Sum all TK ĐƯ entries that start with this code (prefix match)
      for (const [tk, entry] of tkMap) {
        if (tk === code || tk.startsWith(code + '.') || tk.startsWith(code + '-')) {
          // THU: use .no (cash debited = cash inflow associated with this counter account)
          // CHI: use .co (cash credited = cash outflow associated with this counter account)
          const amount = section === 'THU' ? entry.no : entry.co;
          total += sign * amount;
        }
      }
    }

    return Math.max(0, total); // cashflow amounts are always shown as positive
  }

  // ─── Generate cashflow Excel ──────────────────────────────────────────────
  // Loads the accumulation template (CASHFLOW_REPORT_PATH), fills the current
  // month column, overwrites the file on disk, returns buffer for Telegram.

  async generateCashflowExcel(): Promise<Buffer> {
    if (!this.ledgerData) throw new Error('No ledger data loaded');
    const { month, year, tkMap } = this.ledgerData;

    const reportsDir = process.env.REPORTS_DIR ?? path.join(process.cwd(), 'reports');
    const reportPath = path.join(reportsDir, `${year}_cashflows.xlsx`);
    const templatePath = path.join(process.cwd(), 'src', 'assets', 'cashflow_template.xlsx');

    // Auto-create year file from template if not exists
    const fs = await import('fs');
    if (!fs.existsSync(reportPath)) {
      fs.copyFileSync(templatePath, reportPath);
      this.logger.log(`Created new report file: ${reportPath}`);
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(reportPath);

    const sheet = workbook.getWorksheet('Cashflow_Misa');
    if (!sheet) throw new Error('Sheet "Cashflow_Misa" not found in template');

    // Jan → col 7 (G), Feb → col 9 (I), Mar → col 11 (K), ...
    const dataCol = 7 + (month - 1) * 2;

    // Build label→CfRow map for fallback when col A is missing from the Excel template
    const labelToCfRow = new Map<string, CfRow>();
    for (const cfRow of CASHFLOW_TEMPLATE) {
      labelToCfRow.set(cfRow.label, cfRow);
    }

    // ── Compute monthly value for each data row ───────────────────────────
    const rowValues = new Map<number, number>(); // rn → value
    let section: 'THU' | 'CHI' | null = null;

    sheet.eachRow((row, rn) => {
      const rawA = row.getCell(1).value;
      const colB = String(row.getCell(2).value ?? '').trim();
      const colBUp = colB.toUpperCase();

      if (colBUp === 'THU') { section = 'THU'; return; }
      if (colBUp === 'CHI') { section = 'CHI'; return; }
      if (!section) return;

      // Row-level override (blank/partial/corrupt col A)
      const override = ROW_ACCOUNTS_OVERRIDE.get(rn);
      if (override !== undefined) {
        rowValues.set(rn, this.computeValue(override, section, tkMap));
        return;
      }

      // Col A empty + col B label: check if data row (via label fallback) or group header
      if ((rawA === null || rawA === undefined || rawA === '') && colB) {
        const fallback = labelToCfRow.get(colB);
        if (fallback && fallback.section === section && fallback.accounts) {
          rowValues.set(rn, this.computeValue(fallback.accounts, section, tkMap));
        }
        return;
      }
      if (rawA === null || rawA === undefined || rawA === '') return;

      // Data row with account code in col A
      const codeStr = rawA instanceof Date
        ? `${rawA.getUTCFullYear()}-${rawA.getUTCMonth() + 1}`
        : String(rawA).trim();
      if (!codeStr) return;

      rowValues.set(rn, this.computeFromCode(codeStr, section, tkMap));
    });

    // ── Fill ONLY the data column for this month ──────────────────────────
    // All other columns (TỔNG, %, LÃI/LỖ, CUỐI KỲ, group subtotals) are
    // formula-driven and will auto-calculate when the user opens the file.
    for (const [rn, value] of rowValues) {
      sheet.getRow(rn).getCell(dataCol).value = value || null;
    }

    // ── Fix shared formulas so ExcelJS can write without errors ──────────
    // ExcelJS can't round-trip shared formulas. Strategy:
    //   - Master cells (formula + ref): keep formula, strip sharing metadata
    //   - Clone cells (sharedFormula): convert to adjusted individual formula
    const masterFormulas = new Map<string, { formula: string; masterRow: number; masterCol: number }>();

    sheet.eachRow((row, rn) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (!v || typeof v !== 'object') return;
        const obj = v as unknown as Record<string, unknown>;
        if ('formula' in obj && 'ref' in obj) {
          masterFormulas.set(cell.address, {
            formula: obj['formula'] as string,
            masterRow: rn,
            masterCol: Number(cell.col),
          });
          cell.value = { formula: obj['formula'] as string } as ExcelJS.CellValue;
        }
      });
    });

    sheet.eachRow((row, rn) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (!v || typeof v !== 'object') return;
        const obj = v as unknown as Record<string, unknown>;
        if (!('sharedFormula' in obj)) return;

        const master = masterFormulas.get(obj['sharedFormula'] as string);
        if (master) {
          const adjusted = this.adjustFormula(master.formula, rn - master.masterRow, Number(cell.col) - master.masterCol);
          cell.value = { formula: adjusted } as ExcelJS.CellValue;
        } else {
          // Master not found — fall back to cached result
          const res = obj['result'];
          const isError = res && typeof res === 'object' && 'error' in (res as object);
          cell.value = (isError || res === undefined) ? null : (res as ExcelJS.CellValue);
        }
      });
    });

    // Overwrite file on disk so all months accumulate
    await workbook.xlsx.writeFile(reportPath);

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  // Parse account code expressions from the template (col A) and compute value.
  // Handles: "131+515.1-635.1", "3334, 3335, 3339", "6421-17", "334.9 +6421-12"
  private computeFromCode(raw: string, section: 'THU' | 'CHI', tkMap: Map<string, TkEntry>): number {
    // Normalize commas to + then tokenize with regex
    const normalized = raw.replace(/,\s*/g, '+');

    // Pattern: optional sign, then account code (digits/dots, optional -NN suffix ≤2 digits)
    // (?:-\d{1,2}(?!\d))? = optional sub-account suffix like -17, -12 (≤2 digits, not followed by more digits)
    // This prevents "515.4-635.2" from being parsed as "515.4-63" + "5.2"
    const tokenRegex = /([+-]?)(\d[\d.]*(?:-\d{1,2}(?!\d))?)/g;
    let total = 0;
    let m: RegExpExecArray | null;

    while ((m = tokenRegex.exec(normalized)) !== null) {
      const sign: 1 | -1 = m[1] === '-' ? -1 : 1;
      const code = m[2];

      for (const [tk, entry] of tkMap) {
        if (tk === code || tk.startsWith(code + '.') || tk.startsWith(code + '-')) {
          total += sign * (section === 'THU' ? entry.no : entry.co);
        }
      }
    }

    return Math.max(0, total);
  }

  // ─── Formula helpers ──────────────────────────────────────────────────────

  // Adjust a shared formula for a clone cell by offsetting relative cell references.
  // Absolute references ($A$1) are not moved; relative ones (A1) are shifted.
  private adjustFormula(formula: string, rowOffset: number, colOffset: number): string {
    return formula.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g, (_m, absCol, col, absRow, rowStr) => {
      const newCol = absCol ? col : this.shiftCol(col, colOffset);
      const newRow = absRow ? rowStr : String(parseInt(rowStr) + rowOffset);
      return `${absCol}${newCol}${absRow}${newRow}`;
    });
  }

  private shiftCol(col: string, offset: number): string {
    const n = col.split('').reduce((acc, c) => acc * 26 + c.charCodeAt(0) - 64, 0);
    const newN = n + offset;
    let result = '';
    let rem = newN;
    while (rem > 0) {
      const mod = (rem - 1) % 26;
      result = String.fromCharCode(65 + mod) + result;
      rem = Math.floor((rem - 1) / 26);
    }
    return result;
  }

  // ─── AI query ─────────────────────────────────────────────────────────────

  async answerQuery(question: string): Promise<string> {
    if (!this.ledgerData) return '⚠️ Chưa có dữ liệu sổ cái.';
    if (!process.env.GROQ_API_KEY) {
      return '⚠️ GROQ_API_KEY chưa được cấu hình.';
    }

    const openai = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1',
    });
    const { month, year, tkMap } = this.ledgerData;

    // Build summary for AI context
    const summaryLines = [...tkMap.entries()]
      .sort((a, b) => b[1].co + b[1].no - (a[1].co + a[1].no))
      .slice(0, 30) // limit context size
      .map(
        ([tk, e]) =>
          `TK ${tk}: Nợ(vào) = ${e.no.toLocaleString('vi-VN')} | Có(ra) = ${e.co.toLocaleString('vi-VN')}`,
      )
      .join('\n');

    const prompt = `Bạn là trợ lý kế toán chuyên nghiệp. Phân tích dữ liệu dòng tiền tháng ${month}/${year} và trả lời câu hỏi bằng tiếng Việt ngắn gọn, chính xác.

Dữ liệu dòng tiền theo TK đối ứng:
${summaryLines}

Câu hỏi: ${question}

Trả lời (tối đa 3-4 câu, dùng số có dấu phân cách nghìn):`;

    const response = await openai.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
    });

    return response.choices[0].message.content ?? 'Không thể xử lý câu hỏi.';
  }
}
