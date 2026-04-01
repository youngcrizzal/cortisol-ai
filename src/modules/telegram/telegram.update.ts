// src/modules/telegram/telegram.update.ts

import { Logger } from '@nestjs/common';
import {
  Action,
  Command,
  Ctx,
  Hears,
  Help,
  On,
  Start,
  Update,
} from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { buildVoucherMessage } from 'src/lib/voucher';
import { TelegramService } from './telegram.service';

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
      `👋 Welcome, ${user?.first_name || 'there'}!\n\n` +
        `I'm your NestJS bot. Here's what I can do:\n\n` +
        `📌 /start - Start the bot\n` +
        `❓ /help - Show help\n` +
        `📊 /status - Get system status\n` +
        `🌐 /payment_voucher - Fetch data from Payment voucher\n` +
        `📝 /history - View your message history`,
    );
  }

  @Help()
  async onHelp(@Ctx() ctx: Context) {
    await ctx.reply(
      `🤖 *Available Commands:*\n\n` +
        `/start - Initialize the bot\n` +
        `/help - Show this help message\n` +
        `/payment_voucher - Fetch data from Payment voucher\n` +
        { parse_mode: 'Markdown' },
    );
  }

  @Start()
  start(@Ctx() ctx: Context) {
    ctx.reply('Welcome to Cortisol AI bot 🚀');
  }

  @Command('connect_erp')
  async onConnectErp(@Ctx() ctx: Context): Promise<void> {
    const text = (ctx.message as any)?.text ?? '';
    const token = text.replace('/connect_erp', '').trim();

    // Delete the message immediately to avoid exposing the token in chat
    try {
      await ctx.deleteMessage();
    } catch {}

    if (!token) {
      await ctx.reply(
        '⚠️ Vui lòng cung cấp token ERP của bạn:\n\n`/connect_erp <token>`\n\nLấy token: Đăng nhập ERP → F12 → Application → localStorage → `access_token`',
        { parse_mode: 'Markdown' },
      );
      return;
    }

    if (this.telegramService.isTokenExpired(token)) {
      await ctx.reply(
        '❌ Token đã hết hạn. Vui lòng đăng nhập lại vào ERP và lấy token mới.',
      );
      return;
    }

    const telegramId = String(ctx.from?.id);
    await this.telegramService.saveErpToken(telegramId, token);
    await ctx.reply(
      '✅ Đã lưu token ERP thành công! Bạn có thể phê duyệt phiếu qua Telegram.',
    );
  }

  @Command('payment_voucher')
  async onFetch(@Ctx() ctx: Context) {
    await ctx.reply('⏳ Cứ từ từ Hà Nội không vội bạn ơi...');
    const listVoucherMsg = await this.telegramService.getListPaymentVoucher();
    const firstVoucherMsg = buildVoucherMessage(listVoucherMsg[0]);
    await ctx.reply(`${firstVoucherMsg}`, { parse_mode: 'Markdown' });
  }

  @Action(/^approve:/)
  async onApprove(@Ctx() ctx: Context): Promise<void> {
    const voucherId = (ctx.callbackQuery as any).data.replace('approve:', '');
    const telegramId = String(ctx.from?.id);

    const userLink =
      await this.telegramService.getUserLinkByTelegramId(telegramId);

    if (
      !userLink?.erpAccessToken ||
      this.telegramService.isTokenExpired(userLink.erpAccessToken)
    ) {
      await ctx.answerCbQuery('⚠️ Token ERP hết hạn');
      await ctx.reply(
        '⚠️ Token ERP của bạn đã hết hạn.\nVui lòng đăng nhập lại ERP và gửi:\n\n`/connect_erp <token>`',
        { parse_mode: 'Markdown' },
      );
      return;
    }

    try {
      await this.telegramService.approveVoucher(
        voucherId,
        userLink.erpAccessToken,
      );

      try {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      } catch {}

      await ctx.answerCbQuery('✅ Phê duyệt thành công');
      await ctx.reply('✅ *Phê duyệt thành công*', { parse_mode: 'Markdown' });

      await this.telegramService.notifyNextPendingApprover(voucherId);
    } catch (error) {
      this.logger.error(
        `Approve failed for voucher ${voucherId}: ${error.message}`,
      );
      console.log('>>error: ', error);
      await ctx.answerCbQuery('❌ Có lỗi xảy ra, vui lòng thử lại');
    }
  }

  @Action(/^reject:/)
  async onReject(@Ctx() ctx: Context): Promise<void> {
    const voucherId = (ctx.callbackQuery as any).data.replace('reject:', '');
    const telegramId = String(ctx.from?.id);
    const rejectorName = ctx.from?.first_name ?? 'Approver';

    const userLink =
      await this.telegramService.getUserLinkByTelegramId(telegramId);

    if (
      !userLink?.erpAccessToken ||
      this.telegramService.isTokenExpired(userLink.erpAccessToken)
    ) {
      await ctx.answerCbQuery('⚠️ Token ERP hết hạn');
      await ctx.reply(
        '⚠️ Token ERP của bạn đã hết hạn.\nVui lòng đăng nhập lại ERP và gửi:\n\n`/connect_erp <token>`',
        { parse_mode: 'Markdown' },
      );
      return;
    }

    // Remove buttons and store pending rejection state
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch {}

    await ctx.answerCbQuery();

    this.telegramService.setPendingRejection(telegramId, {
      voucherId,
      erpAccessToken: userLink.erpAccessToken,
      rejectorName,
      step: 'reason',
    });

    await ctx.reply('📝 *Bước 1/2* — Nhập *lý do từ chối* (reason):', {
      parse_mode: 'Markdown',
      reply_markup: { force_reply: true, selective: true },
    });
  }

  @On('text')
  async onMessage(@Ctx() ctx: Context): Promise<void> {
    const telegramId = String(ctx.from?.id);
    const text = ((ctx.message as any)?.text ?? '').trim();
    await this.handleRejectionInput(telegramId, text, ctx);
  }

  @On('voice')
  async onVoice(@Ctx() ctx: Context): Promise<void> {
    const telegramId = String(ctx.from?.id);
    const fileId = (ctx.message as any)?.voice?.file_id;

    const pending = this.telegramService.getPendingRejection(telegramId);
    if (!pending) return;

    const processingMsg = await ctx.reply(
      '🎤 Đang chuyển giọng nói thành văn bản...',
    );

    try {
      const text = await this.telegramService.transcribeVoice(fileId);

      try {
        await ctx.telegram.deleteMessage(
          ctx.chat!.id,
          processingMsg.message_id,
        );
      } catch {}

      await ctx.reply(`🎤 *Nhận được:* _${text}_`, {
        parse_mode: 'Markdown',
      });
      await this.handleRejectionInput(telegramId, text, ctx);
    } catch (error) {
      this.logger.error(`Voice transcription failed: ${error.message}`);
      await ctx.reply(
        '❌ Không thể chuyển giọng nói thành văn bản, vui lòng nhập text.',
      );
    }
  }

  private async handleRejectionInput(
    telegramId: string,
    text: string,
    ctx: Context,
  ): Promise<void> {
    const pending = this.telegramService.getPendingRejection(telegramId);
    if (!pending) return;

    if (pending.step === 'reason') {
      this.telegramService.setPendingRejection(telegramId, {
        ...pending,
        step: 'comments',
        reason: text,
      });
      await ctx.reply('💬 *Bước 2/2* — Nhập *bình luận bổ sung* (comments):', {
        parse_mode: 'Markdown',
        reply_markup: { force_reply: true, selective: true },
      });
      return;
    }

    // step === 'comments' — submit rejection
    this.telegramService.clearPendingRejection(telegramId);
    try {
      await this.telegramService.rejectVoucher(
        pending.voucherId,
        pending.erpAccessToken,
        text,
        pending.reason ?? '',
      );
      await ctx.reply('❌ *Đã từ chối phiếu thành công*', {
        parse_mode: 'Markdown',
      });
      await this.telegramService.notifyVoucherCreatorRejected(
        pending.voucherId,
        pending.rejectorName,
        pending.reason ?? '',
        text,
      );
    } catch (error) {
      this.logger.error(
        `Reject failed for voucher ${pending.voucherId}: ${error.message}`,
      );
      console.log('>>error: ', error?.response?.data);
      await ctx.reply('❌ Có lỗi xảy ra khi từ chối phiếu, vui lòng thử lại.');
    }
  }

  @Hears(/hello/i)
  async onHello(@Ctx() ctx: Context) {
    await ctx.reply(
      `Hello! 👋 Nice to meet you! Type /help for available commands.`,
    );
  }
}
