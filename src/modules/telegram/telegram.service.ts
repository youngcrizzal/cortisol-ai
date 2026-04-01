// src/modules/telegram/telegram.service.ts

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { buildVoucherMessage } from 'src/lib/voucher';
import { PrismaService } from 'src/prisma/prisma.service';
import { HttpService } from '../http/http.service';

interface PendingRejection {
  voucherId: string;
  erpAccessToken: string;
  rejectorName: string;
  step: 'reason' | 'comments';
  reason?: string;
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly pendingRejections = new Map<string, PendingRejection>();

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
  ) {}

  async registerUser(telegramUser: any) {
    try {
      await this.prisma.telegramUser.upsert({
        where: { telegramId: String(telegramUser.id) },
        update: {
          username: telegramUser.username,
          firstName: telegramUser.first_name,
          lastName: telegramUser.last_name,
        },
        create: {
          telegramId: String(telegramUser.id),
          username: telegramUser.username,
          firstName: telegramUser.first_name,
          lastName: telegramUser.last_name,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to register user: ${error.message}`);
    }
  }

  async getListPaymentVoucher() {
    const response = await this.httpService.get<ListPaymentVoucherResponse>(
      '/accounting/vouchers',
      {
        params: {
          voucherType: 'PAYMENT',
          page: 1,
          limit: 1,
          sortBy: 'postingDate',
          sortOrder: 'desc',
          filterWaitingApproval: false,
        },
      },
    );

    return response.data;
  }

  async getVoucher(voucherId: string): Promise<PaymentVoucher> {
    return this.httpService.get<PaymentVoucher>(
      `/accounting/vouchers/${voucherId}/detail`,
    );
  }

  async approveVoucher(voucherId: string, approverToken: string) {
    return this.httpService.post(
      `/accounting/vouchers/${voucherId}/approve`,
      { comments: '' },
      { headers: { authorization: `Bearer ${approverToken}` } },
    );
  }

  async rejectVoucher(
    voucherId: string,
    approverToken: string,
    comments: string,
    reason: string,
  ) {
    return this.httpService.post(
      `/accounting/vouchers/${voucherId}/reject`,
      { comments, reason },
      { headers: { authorization: `Bearer ${approverToken}` } },
    );
  }

  async transcribeVoice(voiceFileId: string): Promise<string> {
    // Download audio file from Telegram
    const fileLink = await this.bot.telegram.getFileLink(voiceFileId);
    const audioResponse = await axios.get(fileLink.href, {
      responseType: 'arraybuffer',
    });
    const audioBuffer = Buffer.from(audioResponse.data);

    // Send to Groq Whisper for transcription
    const formData = new FormData();
    formData.append(
      'file',
      new Blob([audioBuffer], { type: 'audio/ogg' }),
      'voice.ogg',
    );
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', 'vi');

    const response = await axios.post(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      formData,
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
      },
    );

    return response.data.text as string;
  }

  setPendingRejection(telegramId: string, data: PendingRejection) {
    this.pendingRejections.set(telegramId, data);
  }

  getPendingRejection(telegramId: string): PendingRejection | undefined {
    return this.pendingRejections.get(telegramId);
  }

  clearPendingRejection(telegramId: string) {
    this.pendingRejections.delete(telegramId);
  }

  async getUserLinkByTelegramId(telegramId: string) {
    return this.prisma.userLink.findFirst({
      where: { externalUserId: telegramId, externalSystem: 'TELEGRAM' },
    });
  }

  async saveErpToken(telegramId: string, token: string) {
    await this.prisma.userLink.updateMany({
      where: { externalUserId: telegramId, externalSystem: 'TELEGRAM' },
      data: { erpAccessToken: token },
    });
  }

  isTokenExpired(token: string): boolean {
    try {
      const payload = JSON.parse(
        Buffer.from(token.split('.')[1], 'base64').toString(),
      );
      return payload.exp * 1000 < Date.now();
    } catch {
      return true;
    }
  }

  async sendMessageToUser(telegramId: string, message: string) {
    try {
      await this.bot.telegram.sendMessage(telegramId, message, {
        parse_mode: 'Markdown',
      });
      this.logger.log(`Message sent to user ${telegramId}`);
    } catch (error) {
      this.logger.error(
        `Failed to send message to ${telegramId}: ${error.message}`,
      );
      throw error;
    }
  }

  async sendVoucherApprovalRequest(
    telegramId: string,
    message: string,
    voucherId: string,
  ) {
    try {
      console.log('data: ', {
        telegramId,
        message,
        voucherId,
      });
      await this.bot.telegram.sendMessage(telegramId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '✅ Phê duyệt',
                callback_data: `approve:${voucherId}`,
              },
              { text: '❌ Từ chối', callback_data: `reject:${voucherId}` },
            ],
          ],
        },
      });
      this.logger.log(
        `Approval request sent to ${telegramId} for voucher ${voucherId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send approval request to ${telegramId}: ${error.message}`,
      );
      throw error;
    }
  }

  async notifyNextPendingApprover(voucherId: string) {
    try {
      const voucher = await this.getVoucher(voucherId);

      const nextPending = voucher.approvals
        ?.filter((a) => a.status === 'PENDING')
        ?.sort((a, b) => a.index - b.index)?.[0];

      if (!nextPending) {
        // All approvals done — notify the creator
        await this.notifyVoucherFullyApproved(voucher);
        return;
      }

      const userLink = await this.prisma.userLink.findFirst({
        where: {
          userEmail: nextPending.approver.email,
          active: true,
          externalSystem: 'TELEGRAM',
        },
      });

      if (!userLink) {
        this.logger.warn(
          `No Telegram link for next approver: ${nextPending.approver.email}`,
        );
        return;
      }

      const message = buildVoucherMessage(voucher);
      await this.sendVoucherApprovalRequest(
        userLink.externalUserId,
        message,
        voucherId,
      );
      this.logger.log(
        `Notified next approver ${nextPending.approver.fullName} for voucher ${voucherId}`,
      );
    } catch (error) {
      console.log('>> Error', error);
      this.logger.error(`Failed to notify next approver: ${error.message}`);
    }
  }

  private async notifyVoucherFullyApproved(voucher: PaymentVoucher) {
    try {
      const voucherRecord = await this.prisma.paymentVoucher.findUnique({
        where: { id: voucher.id },
        include: { creator: true },
      });

      if (!voucherRecord?.creator) return;

      const creatorUserLink = await this.prisma.userLink.findFirst({
        where: {
          userEmail: voucherRecord.creator.email,
          active: true,
          externalSystem: 'TELEGRAM',
        },
      });

      if (!creatorUserLink) {
        this.logger.warn(
          `No Telegram link for creator: ${voucherRecord.creator.email}`,
        );
        return;
      }

      const message =
        `✅ Phiếu *${voucher.code}* đã được phê duyệt hoàn tất!\n\n` +
        `💰 Số tiền: *${Number(voucher.totalAmount).toLocaleString('vi-VN')} ${voucher.currency}*\n` +
        `📝 Nội dung: ${voucher.content}`;

      await this.sendMessageToUser(creatorUserLink.externalUserId, message);
      this.logger.log(
        `Notified creator ${voucherRecord.creator.email} of full approval for voucher ${voucher.code}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify creator of full approval: ${error.message}`,
      );
    }
  }

  async notifyVoucherCreatorRejected(
    voucherId: string,
    rejectorName: string,
    reason: string,
    comments: string,
  ) {
    try {
      const voucher = await this.prisma.paymentVoucher.findUnique({
        where: { id: voucherId },
        include: { creator: true },
      });

      if (!voucher?.creator) return;

      const creatorUserLink = await this.prisma.userLink.findFirst({
        where: {
          userEmail: voucher.creator.email,
          active: true,
          externalSystem: 'TELEGRAM',
        },
      });

      if (!creatorUserLink) {
        this.logger.warn(
          `No Telegram link for creator: ${voucher.creator.email}`,
        );
        return;
      }

      let message =
        `❌ Phiếu *${voucher.code}* đã bị từ chối bởi *${rejectorName}*\n\n` +
        `📌 *Lý do:* ${reason}`;

      if (comments) {
        message += `\n💬 *Bình luận:* ${comments}`;
      }

      await this.sendMessageToUser(creatorUserLink.externalUserId, message);
    } catch (error) {
      this.logger.error(
        `Failed to notify creator of rejection: ${error.message}`,
      );
    }
  }

  async fetchExternalData() {
    const randomId = Math.floor(Math.random() * 100) + 1;
    return this.httpService.get(`/posts/${randomId}`);
  }
}
