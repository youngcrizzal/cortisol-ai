// src/modules/telegram/telegram.update.ts

import { Logger } from '@nestjs/common';
import { Update, Start, Help, On, Hears, Ctx, Command, Next } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { TelegramService } from './telegram.service';
import { buildVoucherMessage } from 'src/lib/voucher';

@Update()
export class TelegramUpdate {
  private readonly logger = new Logger(TelegramUpdate.name);

  constructor(private readonly telegramService: TelegramService) {}

  @Start()
  async onStart(@Ctx() ctx: Context) {
    const user = ctx.from;
    this.logger.log(`New user started bot: ${user?.username || user?.id}`);

    await this.telegramService.registerUser(user);

    await ctx.reply(
      `👋 Xin chào, ${user?.first_name || 'bạn'}!\n\n` +
        `Tôi là trợ lý kế toán tự động. Các lệnh hiện có:\n\n` +
        `📋 *Phiếu thu chi:*\n` +
        `/payment\\_voucher — Xem phiếu chi mới nhất\n\n` +
        `📊 *Báo cáo tài chính:*\n` +
        `/upload\\_tai\\_khoan — Upload danh sách tài khoản\n` +
        `/upload\\_so\\_cai — Upload sổ cái tháng\n` +
        `/bao\\_cao — Xuất báo cáo dòng tiền\n` +
        `/query <câu hỏi> — Hỏi AI về dữ liệu kế toán\n\n` +
        `/help — Xem lại danh sách lệnh`,
      { parse_mode: 'Markdown' },
    );
  }

  @Help()
  async onHelp(@Ctx() ctx: Context) {
    await ctx.reply(
      `🤖 *Danh sách lệnh:*\n\n` +
        `📋 *Phiếu thu chi:*\n` +
        `/payment\\_voucher — Xem phiếu chi mới nhất\n\n` +
        `📊 *Báo cáo tài chính:*\n` +
        `/upload\\_tai\\_khoan — Upload danh sách tài khoản (Excel)\n` +
        `/upload\\_so\\_cai — Upload sổ cái tháng (Excel)\n` +
        `/bao\\_cao — Xuất file tổng hợp dòng tiền\n` +
        `/query <câu hỏi> — Truy vấn AI bằng ngôn ngữ tự nhiên\n\n` +
        `💡 Ví dụ: /query Chi phí nhân sự tháng này là bao nhiêu?`,
      { parse_mode: 'Markdown' },
    );
  }

  @Command('payment_voucher')
  async onFetch(@Ctx() ctx: Context) {
    await ctx.reply('⏳ Đang tải dữ liệu phiếu chi...');
    try {
      const listVoucherMsg = await this.telegramService.getListPaymentVoucher();
      if (!listVoucherMsg?.length) {
        await ctx.reply('📭 Không có phiếu chi nào.');
        return;
      }
      const firstVoucherMsg = buildVoucherMessage(listVoucherMsg[0]);
      await ctx.reply(`${firstVoucherMsg}`, { parse_mode: 'Markdown' });
    } catch (error) {
      this.logger.error(`Error fetching voucher: ${error.message}`);
      await ctx.reply('❌ Không thể tải phiếu chi. Vui lòng thử lại.');
    }
  }

  @Hears(/hello/i)
  async onHello(@Ctx() ctx: Context) {
    await ctx.reply(
      `Xin chào! 👋 Gõ /help để xem danh sách lệnh.`,
    );
  }

  @On('text')
  async onMessage(@Ctx() ctx: Context, @Next() next: () => Promise<void>) {
    const text = (ctx.message as any)?.text ?? '';
    if (text.startsWith('/')) {
      await next(); // pass to @Command handlers in other @Update classes
      return;
    }
    await ctx.reply('Gõ /help để xem danh sách lệnh.');
  }
}
