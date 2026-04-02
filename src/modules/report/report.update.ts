// src/modules/report/report.update.ts

import { Logger } from '@nestjs/common';
import { Update, On, Command, Ctx } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { Message } from 'telegraf/types';
import axios from 'axios';
import { ReportService } from './report.service';

@Update()
export class ReportUpdate {
  private readonly logger = new Logger(ReportUpdate.name);

  constructor(private readonly reportService: ReportService) {}

  @Command('upload_tai_khoan')
  async onUploadTaiKhoan(@Ctx() ctx: Context) {
    this.reportService.setUploadMode(String(ctx.from!.id), 'tai_khoan');
    await ctx.reply(
      '📎 Vui lòng gửi file Excel danh sách tài khoản.\n\n' +
        'File: Danh_sach_he_thong_tai_khoan.xlsx\n' +
        'Cột B: Số TK | C: Tên TK | D: Tính chất | F: Trạng thái',
    );
  }

  @Command('upload_so_cai')
  async onUploadSoCai(@Ctx() ctx: Context) {
    this.reportService.setUploadMode(String(ctx.from!.id), 'so_cai');
    await ctx.reply(
      '📎 Vui lòng gửi file Excel sổ chi tiết.\n\n' +
        'File: So_chi_tiet_cac_tai_khoan.xlsx\n' +
        'Hệ thống sẽ tự động phát hiện tài khoản tiền mặt và nhóm theo TK đối ứng.',
    );
  }

  @On('document')
  async onDocument(@Ctx() ctx: Context) {
    const msg = ctx.message as Message.DocumentMessage;
    if (!msg?.document) return;

    const { document } = msg;
    const fileName = document.file_name?.toLowerCase() ?? '';

    if (!fileName.endsWith('.xlsx') && !fileName.endsWith('.xls')) {
      await ctx.reply('⚠️ Chỉ chấp nhận file Excel (.xlsx hoặc .xls).');
      return;
    }

    const userId = String(ctx.from!.id);
    let mode = this.reportService.consumeUploadMode(userId);

    // Auto-detect from filename
    if (!mode) {
      if (fileName.includes('so_chi') || fileName.includes('so_cai')) {
        mode = 'so_cai';
      } else if (fileName.includes('tai_khoan') || fileName.includes('danh_sach')) {
        mode = 'tai_khoan';
      }
    }

    if (!mode) {
      await ctx.reply(
        '⚠️ Không thể nhận diện loại file.\n' +
          'Tên file cần chứa "so_chi"/"so_cai" hoặc "tai_khoan"/"danh_sach".\n' +
          'Hoặc dùng /upload_tai_khoan hoặc /upload_so_cai trước khi gửi.',
      );
      return;
    }

    await ctx.reply('⏳ Đang xử lý file...');

    try {
      const fileLink = await ctx.telegram.getFileLink(document.file_id);
      const res = await axios.get(fileLink.href, {
        responseType: 'arraybuffer',
      });
      const buffer = Buffer.from(res.data as ArrayBuffer);

      if (mode === 'tai_khoan') {
        const count = await this.reportService.parseChartOfAccounts(buffer);
        await ctx.reply(
          `✅ Đã lưu ${count} tài khoản vào hệ thống.\n\nDùng /upload_so_cai để upload sổ cái.`,
        );
      } else {
        const { month, year, count } = await this.reportService.parseSoChi(buffer);
        await ctx.reply(
          `✅ Đã tải ${count} bút toán tháng ${month}/${year}.\n\n` +
            `📊 /bao_cao — Xuất file tổng hợp\n` +
            `💬 /query <câu hỏi> — Truy vấn AI`,
        );

        // Kiểm tra chi tiêu bất thường ngay sau khi parse
        const anomalies = this.reportService.checkAbnormalSpending();
        if (anomalies.length > 0) {
          const fmt = (n: number) => n.toLocaleString('vi-VN');
          const lines = anomalies
            .map((a) => `• ${a.label}: *${fmt(a.amount)}* đ (ngưỡng ${fmt(a.threshold)} đ)`)
            .join('\n');
          await ctx.reply(
            `⚠️ *Cảnh báo chi tiêu bất thường tháng ${month}/${year}*\n\n${lines}`,
            { parse_mode: 'Markdown' },
          );
        }
      }
    } catch (error) {
      this.logger.error(`Error processing document: ${error.message}`);
      await ctx.reply(
        '❌ Lỗi khi xử lý file. Vui lòng kiểm tra định dạng và thử lại.',
      );
    }
  }

  @Command('bao_cao')
  async onReport(@Ctx() ctx: Context) {
    if (!this.reportService.hasLedgerData()) {
      await ctx.reply(
        '⚠️ Chưa có dữ liệu sổ cái. Dùng /upload_so_cai để upload file trước.',
      );
      return;
    }

    const month = this.reportService.getLedgerMonthLabel();
    await ctx.reply(`⏳ Đang tạo báo cáo dòng tiền tháng ${month}...`);

    try {
      const buffer = await this.reportService.generateCashflowExcel();
      const filename = `2026 TWD's Cashflows Report.xlsx`;

      await ctx.replyWithDocument(
        { source: buffer, filename },
        { caption: `📊 Báo cáo dòng tiền tháng ${month}` },
      );
    } catch (error) {
      this.logger.error(`Error generating report: ${error.message}`);
      await ctx.reply('❌ Lỗi khi tạo báo cáo. Vui lòng thử lại.');
    }
  }

  @Command('query')
  async onQuery(@Ctx() ctx: Context) {
    if (!this.reportService.hasLedgerData()) {
      await ctx.reply(
        '⚠️ Chưa có dữ liệu sổ cái. Dùng /upload_so_cai để upload file trước.',
      );
      return;
    }

    const text = (ctx.message as Message.TextMessage).text ?? '';
    const question = text.replace(/^\/query\s*/i, '').trim();

    if (!question) {
      await ctx.reply(
        '💬 Nhập câu hỏi sau lệnh.\nVí dụ: /query Chi phí nhân sự tháng này là bao nhiêu?',
      );
      return;
    }

    await ctx.reply('🤔 Đang phân tích...');

    try {
      const answer = await this.reportService.answerQuery(question);
      await ctx.reply(`💡 ${answer}`);
    } catch (error) {
      this.logger.error(`Error answering query: ${error.message}`);
      await ctx.reply('❌ Không thể xử lý câu hỏi. Vui lòng thử lại.');
    }
  }
}
