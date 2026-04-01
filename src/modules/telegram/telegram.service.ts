// src/modules/telegram/telegram.service.ts

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { buildVoucherMessage, buildVoucherListMessage } from 'src/lib/voucher';
import { PrismaService } from 'src/prisma/prisma.service';
import { HttpService } from '../http/http.service';

interface PendingRejection {
  voucherId: string;
  erpAccessToken: string;
  rejectorName: string;
  step: 'reason' | 'comments';
  reason?: string;
}

interface PendingVoucherSearch {
  erpAccessToken: string;
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly pendingRejections = new Map<string, PendingRejection>();
  private readonly pendingVoucherSearches = new Map<
    string,
    PendingVoucherSearch
  >();
  private readonly lastSearchParams = new Map<string, VoucherSearchParams>();
  private readonly groupTokens = new Map<string, string>(); // groupId -> erpAccessToken

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

  saveGroupErpToken(groupId: string, token: string) {
    this.groupTokens.set(groupId, token);
  }

  getGroupErpToken(groupId: string): string | undefined {
    return this.groupTokens.get(groupId);
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
      // console.log('data: ', {
      //   telegramId,
      //   message,
      //   voucherId,
      // });
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

      const message =
        `✅ Phiếu *${voucher.code}* đã được phê duyệt hoàn tất!\n\n` +
        `💰 Số tiền: *${Number(voucher.totalAmount).toLocaleString('vi-VN')} ${voucher.currency}*\n` +
        `📝 Nội dung: ${voucher.content}`;

      // Notify creator
      const creatorUserLink = await this.prisma.userLink.findFirst({
        where: {
          userEmail: voucherRecord.creator.email,
          active: true,
          externalSystem: 'TELEGRAM',
        },
      });

      if (creatorUserLink) {
        await this.sendMessageToUser(creatorUserLink.externalUserId, message);
        this.logger.log(
          `Notified creator ${voucherRecord.creator.email} of full approval for voucher ${voucher.code}`,
        );
      } else {
        this.logger.warn(
          `No Telegram link for creator: ${voucherRecord.creator.email}`,
        );
      }

      // Notify first approver (if different from creator)
      const sortedApprovals = (voucher.approvals ?? []).sort(
        (a, b) => a.index - b.index,
      );
      const firstApproval = sortedApprovals[0];

      if (
        firstApproval?.approver?.email &&
        firstApproval.approver.email !== voucherRecord.creator.email
      ) {
        const firstApproverUserLink = await this.prisma.userLink.findFirst({
          where: {
            userEmail: firstApproval.approver.email,
            active: true,
            externalSystem: 'TELEGRAM',
          },
        });

        if (firstApproverUserLink) {
          await this.sendMessageToUser(
            firstApproverUserLink.externalUserId,
            message,
          );
          this.logger.log(
            `Notified first approver ${firstApproval.approver.email} of full approval for voucher ${voucher.code}`,
          );
        } else {
          this.logger.warn(
            `No Telegram link for first approver: ${firstApproval.approver.email}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(`Failed to notify of full approval: ${error.message}`);
    }
  }

  async notifyVoucherCreatorRejected(
    voucherId: string,
    rejectorName: string,
    reason: string,
    comments: string,
  ) {
    try {
      // Fetch full ERP voucher once (has approvals + rejector fullName)
      const voucher = await this.getVoucher(voucherId);

      // Prefer fullName from ERP approval data over Telegram display name
      const rejectedApproval = (voucher.approvals ?? []).find(
        (a) => a.status === 'REJECTED',
      );
      const rejectorFullName =
        rejectedApproval?.approver?.fullName ?? rejectorName;

      const detail = this.buildRejectionVoucherDetail(voucher);

      let message =
        `❌ Phiếu *${voucher.code}* đã bị từ chối\n\n` +
        `👤 *Người từ chối:* ${rejectorFullName}\n` +
        `📌 *Lý do:* ${reason}`;

      if (comments) {
        message += `\n💬 *Bình luận:* ${comments}`;
      }

      message += detail;

      // Notify creator
      const voucherRecord = await this.prisma.paymentVoucher.findUnique({
        where: { id: voucherId },
        include: { creator: true },
      });

      if (voucherRecord?.creator) {
        const creatorUserLink = await this.prisma.userLink.findFirst({
          where: {
            userEmail: voucherRecord.creator.email,
            active: true,
            externalSystem: 'TELEGRAM',
          },
        });

        if (creatorUserLink) {
          await this.sendMessageToUser(creatorUserLink.externalUserId, message);
        } else {
          this.logger.warn(
            `No Telegram link for creator: ${voucherRecord.creator.email}`,
          );
        }
      }

      // Notify the previous approver (who approved before the rejector)
      await this.notifyPreviousApproverOfRejection(
        voucher,
        rejectorFullName,
        reason,
        comments,
      );
    } catch (error) {
      this.logger.error(`Failed to notify of rejection: ${error.message}`);
    }
  }

  private async notifyPreviousApproverOfRejection(
    voucher: PaymentVoucher,
    rejectorFullName: string,
    reason: string,
    comments: string,
  ) {
    try {
      const sortedApprovals = (voucher.approvals ?? []).sort(
        (a, b) => a.index - b.index,
      );

      const rejectedApproval = sortedApprovals.find(
        (a) => a.status === 'REJECTED',
      );

      // No previous approver if rejector is at the first position
      if (!rejectedApproval || rejectedApproval.index < 1) return;

      // Find the previous approver (highest index before rejector that is APPROVED)
      const previousApproval = sortedApprovals
        .filter(
          (a) => a.index < rejectedApproval.index && a.status === 'APPROVED',
        )
        .sort((a, b) => b.index - a.index)[0];

      if (!previousApproval?.approver?.email) return;

      const previousUserLink = await this.prisma.userLink.findFirst({
        where: {
          userEmail: previousApproval.approver.email,
          active: true,
          externalSystem: 'TELEGRAM',
        },
      });

      if (!previousUserLink) {
        this.logger.warn(
          `No Telegram link for previous approver: ${previousApproval.approver.email}`,
        );
        return;
      }

      const detail = this.buildRejectionVoucherDetail(voucher);

      let message =
        `⚠️ Phiếu *${voucher.code}* mà bạn đã phê duyệt đã bị *${rejectorFullName}* từ chối\n\n` +
        `📌 *Lý do:* ${reason}`;

      if (comments) {
        message += `\n💬 *Bình luận:* ${comments}`;
      }

      message += detail;

      await this.sendMessageToUser(previousUserLink.externalUserId, message);
      this.logger.log(
        `Notified previous approver ${previousApproval.approver.email} of rejection for voucher ${voucher.code}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify previous approver of rejection: ${error.message}`,
      );
    }
  }

  private buildRejectionVoucherDetail(voucher: PaymentVoucher): string {
    const formatDate = (d: string) =>
      new Date(d).toLocaleDateString('vi-VN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });
    const amount = `${Number(voucher.totalAmount).toLocaleString('vi-VN')} ${voucher.currency}`;

    let detail = `\n━━━━━━━━━━━━━━━━━━━━━\n`;
    detail += `🧾 *Thông tin phiếu:*\n`;
    detail += `📅 *Ngày lập:* ${formatDate(voucher.issueDate)}\n`;
    if (voucher.payerReceiver) {
      const payerReceiverLabel =
        voucher.voucherType === 'RECEIPT' ? 'Người gửi' : 'Người nhận';
      detail += `👥 *${payerReceiverLabel}:* ${voucher.payerReceiver}\n`;
    }
    detail += `📝 *Nội dung:* ${voucher.content || '-'}\n`;
    if (voucher.account?.bank) {
      detail += `🏦 *Ngân hàng:* ${voucher.account.bank}\n`;
    }
    if (voucher.account?.name) {
      detail += `🏷️ *Tên TK ngân hàng:* ${voucher.account.name}\n`;
    }
    if (voucher.account?.code) {
      detail += `🔢 *Mã TK:* ${voucher.account.code}\n`;
    }
    if (voucher.bankAccount) {
      detail += `💳 *Số TK:* ${voucher.bankAccount}\n`;
    }
    detail += `💰 *Số tiền:* ${amount}\n`;
    detail += `📊 *Trạng thái:* Đã từ chối`;

    return detail;
  }

  setPendingVoucherSearch(telegramId: string, data: PendingVoucherSearch) {
    this.pendingVoucherSearches.set(telegramId, data);
  }

  getPendingVoucherSearch(
    telegramId: string,
  ): PendingVoucherSearch | undefined {
    return this.pendingVoucherSearches.get(telegramId);
  }

  clearPendingVoucherSearch(telegramId: string) {
    this.pendingVoucherSearches.delete(telegramId);
  }

  getLastSearchParams(telegramId: string): VoucherSearchParams | undefined {
    return this.lastSearchParams.get(telegramId);
  }

  setLastSearchParams(telegramId: string, params: VoucherSearchParams) {
    this.lastSearchParams.set(telegramId, params);
  }

  async parseVoucherQuery(
    query: string,
    previousParams?: VoucherSearchParams,
  ): Promise<VoucherSearchParams> {
    const now = new Date();

    // Precompute all date ranges so LLM never needs to calculate dates
    const isoStart = (d: Date) =>
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
    const isoEnd = (d: Date) =>
      new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        23,
        59,
        59,
        999,
      ).toISOString();

    const todayS = isoStart(now);
    const todayE = isoEnd(now);

    const dow = now.getDay() === 0 ? 6 : now.getDay() - 1; // Mon=0
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - dow);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    const monthS = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthE = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      0,
      23,
      59,
      59,
      999,
    ).toISOString();

    const lastMonthS = new Date(
      now.getFullYear(),
      now.getMonth() - 1,
      1,
    ).toISOString();
    const lastMonthE = new Date(
      now.getFullYear(),
      now.getMonth(),
      0,
      23,
      59,
      59,
      999,
    ).toISOString();

    const q = Math.floor(now.getMonth() / 3);
    const quarterS = new Date(now.getFullYear(), q * 3, 1).toISOString();
    const quarterE = new Date(
      now.getFullYear(),
      q * 3 + 3,
      0,
      23,
      59,
      59,
      999,
    ).toISOString();

    const yearS = new Date(now.getFullYear(), 0, 1).toISOString();
    const yearE = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999).toISOString();
    const lastYearS = new Date(now.getFullYear() - 1, 0, 1).toISOString();
    const lastYearE = new Date(
      now.getFullYear() - 1,
      11,
      31,
      23,
      59,
      59,
      999,
    ).toISOString();

    const monthNames: Record<number, string> = {
      1: 'tháng 1', 2: 'tháng 2', 3: 'tháng 3', 4: 'tháng 4',
      5: 'tháng 5', 6: 'tháng 6', 7: 'tháng 7', 8: 'tháng 8',
      9: 'tháng 9', 10: 'tháng 10', 11: 'tháng 11', 12: 'tháng 12',
    };
    const monthRanges = Object.entries(monthNames)
      .map(([m, label]) => {
        const mn = parseInt(m);
        const s = new Date(now.getFullYear(), mn - 1, 1).toISOString();
        const e = new Date(now.getFullYear(), mn, 0, 23, 59, 59, 999).toISOString();
        return `- "${label}" → {"issueDateFrom":"${s}","issueDateTo":"${e}"}`;
      })
      .join('\n');

    const prevContext = previousParams
      ? `\nTham số tìm kiếm trước đó (kế thừa nếu câu hỏi mới là follow-up/làm rõ thêm):\n${JSON.stringify(previousParams, null, 2)}\n`
      : '';

    const systemPrompt = `Bạn là trợ lý trích xuất tham số tìm kiếm phiếu kế toán từ câu hỏi tiếng Việt.
${prevContext}
=== GIÁ TRỊ NGÀY THÁNG ĐÃ TÍNH SẴN ===
Hôm nay:        {"issueDateFrom":"${todayS}","issueDateTo":"${todayE}"}
Tuần này:       {"issueDateFrom":"${isoStart(weekStart)}","issueDateTo":"${isoEnd(weekEnd)}"}
Tháng này:      {"issueDateFrom":"${monthS}","issueDateTo":"${monthE}"}
Tháng trước:    {"issueDateFrom":"${lastMonthS}","issueDateTo":"${lastMonthE}"}
Quý này:        {"issueDateFrom":"${quarterS}","issueDateTo":"${quarterE}"}
Năm nay:        {"issueDateFrom":"${yearS}","issueDateTo":"${yearE}"}
Năm ngoái:      {"issueDateFrom":"${lastYearS}","issueDateTo":"${lastYearE}"}
Từng tháng năm ${now.getFullYear()}:
${monthRanges}

=== QUY TẮC ===
1. Chỉ dùng các giá trị ngày tháng ĐÃ TÍNH SẴN ở trên, KHÔNG tự tính.
2. limit mặc định = 10. Nếu câu hỏi có "tất cả", "đầy đủ", "hết", "liệt kê", "bao nhiêu" → limit = 100.
3. Nếu câu hỏi là follow-up (ví dụ "hôm nay thôi", "chỉ lấy đã duyệt"), kế thừa tham số trước và chỉ ghi đè trường được đề cập.
4. Số tiền: "10 triệu"→10000000, "500k"→500000, "1.5 tỷ"→1500000000.
5. Loại phiếu: "phiếu chi/chi tiền/trả lương/thanh toán/mua hàng/chi phí/thưởng"→PAYMENT | "phiếu thu/thu tiền/hoàn ứng/thu hồi/nhận tiền"→RECEIPT | không đề cập→bỏ qua.
6. Trạng thái: "nháp/bản thảo"→DRAFT | "chờ duyệt/đang chờ/chưa duyệt/pending"→PROCESSING | "đã duyệt/được duyệt/hoàn tất"→APPROVED | "từ chối/bị từ chối/bác"→REJECTED | "hủy/đã hủy"→CANCELLED | không đề cập→bỏ qua.

=== CÁC TRƯỜNG OUTPUT ===
voucherType, status, content, payerReceiver,
issueDateFrom, issueDateTo, minAmount, maxAmount,
currency (mặc định "VND"), page (mặc định 1), limit,
sortBy ("createdAt"|"issueDate"|"postingDate"|"totalAmount"), sortOrder ("desc"|"asc")

=== VÍ DỤ ===
Q: "phiếu chi hôm nay"
A: {"voucherType":"PAYMENT","issueDateFrom":"${todayS}","issueDateTo":"${todayE}","limit":10}

Q: "liệt kê đầy đủ danh sách phiếu chi hôm nay"
A: {"voucherType":"PAYMENT","issueDateFrom":"${todayS}","issueDateTo":"${todayE}","limit":100}

Q: "bao nhiêu phiếu chi tháng này"
A: {"voucherType":"PAYMENT","issueDateFrom":"${monthS}","issueDateTo":"${monthE}","limit":100}

Q: "phiếu thu đã duyệt tuần này trên 5 triệu"
A: {"voucherType":"RECEIPT","status":"APPROVED","issueDateFrom":"${isoStart(weekStart)}","issueDateTo":"${isoEnd(weekEnd)}","minAmount":5000000,"limit":10}

Q: "tất cả phiếu chờ duyệt"
A: {"status":"PROCESSING","limit":100}

Q: "phiếu lương tháng 3"
A: {"voucherType":"PAYMENT","content":"lương","issueDateFrom":"${new Date(now.getFullYear(), 2, 1).toISOString()}","issueDateTo":"${new Date(now.getFullYear(), 3, 0, 23, 59, 59, 999).toISOString()}","limit":10}

Q: "của Nguyễn Văn A"
A: {"payerReceiver":"Nguyễn Văn A","limit":10}

Q: "từ chối năm ngoái sắp xếp theo số tiền giảm dần"
A: {"status":"REJECTED","issueDateFrom":"${lastYearS}","issueDateTo":"${lastYearE}","sortBy":"totalAmount","sortOrder":"desc","limit":10}

Chỉ trả về JSON hợp lệ, không giải thích thêm.`;

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
      },
    );

    return JSON.parse(
      response.data.choices[0].message.content,
    ) as VoucherSearchParams;
  }

  async dispatchIntent(
    userMessage: string,
    context: { previousParams?: VoucherSearchParams; userName?: string },
  ): Promise<ToolCall> {
    const now = new Date();

    const isoS = (d: Date) =>
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
    const isoE = (d: Date) =>
      new Date(
        d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999,
      ).toISOString();

    const dow = now.getDay() === 0 ? 6 : now.getDay() - 1;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - dow);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    const mS = (y: number, m: number) =>
      new Date(y, m, 1).toISOString();
    const mE = (y: number, m: number) =>
      new Date(y, m + 1, 0, 23, 59, 59, 999).toISOString();

    const y = now.getFullYear();
    const m = now.getMonth();
    const q = Math.floor(m / 3);

    const monthRanges = Array.from({ length: 12 }, (_, i) => ({
      label: `tháng ${i + 1}`,
      from: mS(y, i),
      to: mE(y, i),
    }));

    const prevContext = context.previousParams
      ? `\nContext tìm kiếm trước: ${JSON.stringify(context.previousParams)}`
      : '';

    const systemPrompt = `Bạn là dispatcher của bot quản lý phiếu kế toán ERP.
Tên người dùng: ${context.userName || 'bạn'}${prevContext}

=== NGÀY THÁNG ĐÃ TÍNH SẴN (chỉ dùng các giá trị này) ===
hôm nay:     from="${isoS(now)}" to="${isoE(now)}"
tuần này:    from="${isoS(weekStart)}" to="${isoE(weekEnd)}"
tháng này:   from="${mS(y, m)}" to="${mE(y, m)}"
tháng trước: from="${mS(y, m - 1)}" to="${mE(y, m - 1)}"
quý này:     from="${mS(y, q * 3)}" to="${mE(y, q * 3 + 2)}"
năm nay:     from="${mS(y, 0)}" to="${mE(y, 11)}"
năm ngoái:   from="${mS(y - 1, 0)}" to="${mE(y - 1, 11)}"
${monthRanges.map((r) => `${r.label}: from="${r.from}" to="${r.to}"`).join('\n')}

=== TOOLS ===
1. searchVouchers — khi người dùng muốn tìm kiếm, liệt kê, đếm, lọc phiếu kế toán
   arguments (chỉ ghi trường có đề cập):
   - voucherType: "PAYMENT"(phiếu chi/chi tiền/trả lương/mua hàng/chi phí/thưởng) | "RECEIPT"(phiếu thu/thu tiền/hoàn ứng/thu hồi)
   - status: "DRAFT"(nháp) | "PROCESSING"(chờ duyệt/pending) | "APPROVED"(đã duyệt) | "REJECTED"(từ chối) | "CANCELLED"(hủy)
   - content: string (nội dung/mục đích phiếu)
   - payerReceiver: string (tên người nhận hoặc người gửi)
   - issueDateFrom, issueDateTo: ISO string (dùng giá trị đã tính sẵn)
   - minAmount, maxAmount: number VND ("10 triệu"→10000000, "500k"→500000, "1.5 tỷ"→1500000000)
   - sortBy: "createdAt"|"issueDate"|"postingDate"|"totalAmount"
   - sortOrder: "asc"|"desc"
   - page: number (mặc định 1)
   - limit: number (mặc định 10; nếu có "tất cả/đầy đủ/liệt kê hết/bao nhiêu" → 100)

2. chat — cho câu hỏi chung, trợ giúp, hội thoại, hoặc không liên quan đến tìm kiếm phiếu
   arguments:
   - reply: string (câu trả lời tiếng Việt, thân thiện, không dùng Markdown ký tự đặc biệt, kết thúc bằng 2–3 gợi ý lệnh/câu hỏi tiếp theo)

=== QUY TẮC ===
- Nếu có context tìm kiếm trước và câu hỏi là follow-up → kế thừa arguments trước, chỉ override trường mới
- Ưu tiên searchVouchers nếu câu hỏi liên quan đến dữ liệu phiếu dù không nói rõ "tìm"
- Chỉ trả về JSON hợp lệ, không giải thích

=== VÍ DỤ ===
User: "liệt kê đầy đủ phiếu chi hôm nay"
{"tool":"searchVouchers","arguments":{"voucherType":"PAYMENT","issueDateFrom":"${isoS(now)}","issueDateTo":"${isoE(now)}","limit":100}}

User: "bao nhiêu phiếu chờ duyệt"
{"tool":"searchVouchers","arguments":{"status":"PROCESSING","limit":100}}

User: "phiếu thu đã duyệt tuần này trên 5 triệu"
{"tool":"searchVouchers","arguments":{"voucherType":"RECEIPT","status":"APPROVED","issueDateFrom":"${isoS(weekStart)}","issueDateTo":"${isoE(weekEnd)}","minAmount":5000000}}

User: "tất cả phiếu bị từ chối năm nay sắp xếp số tiền giảm dần"
{"tool":"searchVouchers","arguments":{"status":"REJECTED","issueDateFrom":"${mS(y, 0)}","issueDateTo":"${mE(y, 11)}","sortBy":"totalAmount","sortOrder":"desc","limit":100}}

User: "phiếu chi là gì?"
{"tool":"chat","arguments":{"reply":"Phiếu chi (PAYMENT) là chứng từ ghi nhận khoản tiền công ty chi ra như trả lương, mua hàng, thanh toán nhà cung cấp... 💡 Bạn muốn:\n• Tìm phiếu chi gần đây?\n• Xem phiếu chi chờ duyệt?\n• /examplesearch để xem thêm ví dụ"}}

User: "làm sao kết nối ERP?"
{"tool":"chat","arguments":{"reply":"Để kết nối ERP, bạn dùng lệnh /connect_erp <token> 🔗\nLấy token: Đăng nhập ERP → F12 → Application → localStorage → access_token\n💡 Sau khi kết nối bạn có thể:\n• Phê duyệt phiếu qua Telegram\n• Tìm kiếm phiếu bằng ngôn ngữ tự nhiên"}}`;

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
      },
    );

    return JSON.parse(response.data.choices[0].message.content) as ToolCall;
  }

  async searchVouchers(
    params: VoucherSearchParams,
    erpToken: string,
  ): Promise<ListPaymentVoucherResponse> {
    return this.httpService.get<ListPaymentVoucherResponse>(
      '/accounting/vouchers',
      {
        params: { ...params, filterWaitingApproval: false },
        headers: { authorization: `Bearer ${erpToken}` },
      },
    );
  }

  buildVoucherSearchResultMessage(result: ListPaymentVoucherResponse): string {
    return buildVoucherListMessage(
      result.data,
      result.total,
      result.page,
      result.totalPages,
    );
  }

  async chatWithAgent(
    userMessage: string,
    userName?: string,
  ): Promise<string> {
    const systemPrompt = `Bạn là trợ lý ảo thân thiện của hệ thống quản lý phiếu kế toán ERP qua Telegram.

Tên người dùng: ${userName || 'bạn'}

=== NGHIỆP VỤ KẾ TOÁN ===
Hệ thống quản lý 2 loại phiếu:

PHIẾU CHI (PAYMENT): ghi nhận tiền công ty CHI RA
- Dùng cho: trả lương, mua hàng, thanh toán nhà cung cấp, chi phí vận hành, thưởng, ứng tiền
- Người nhận tiền gọi là "người nhận" (payerReceiver)
- Ví dụ: phiếu chi lương tháng 3, phiếu chi mua thiết bị, phiếu chi thưởng Tết

PHIẾU THU (RECEIPT): ghi nhận tiền công ty THU VÀO
- Dùng cho: thu tiền khách hàng, hoàn ứng, thu hồi công nợ, nhận thanh toán hợp đồng
- Người nộp tiền gọi là "người gửi" (payerReceiver)
- Ví dụ: phiếu thu tiền khách hàng ABC, phiếu thu hoàn ứng của nhân viên

Trạng thái phiếu:
- Bản thảo (DRAFT): vừa tạo, chưa gửi đi duyệt
- Chờ duyệt (PROCESSING): đang trong quy trình phê duyệt
- Đã duyệt (APPROVED): được toàn bộ người duyệt phê duyệt, có hiệu lực
- Từ chối (REJECTED): bị từ chối bởi một người duyệt trong chuỗi
- Đã hủy (CANCELLED): phiếu bị hủy bỏ

Quy trình duyệt:
- Phiếu có thể có nhiều cấp duyệt theo thứ tự (index 0, 1, 2...)
- Mỗi người duyệt được thông báo qua Telegram khi đến lượt
- Người duyệt có thể Phê duyệt hoặc Từ chối trực tiếp qua nút bấm
- Khi từ chối: người duyệt trước đó được thông báo
- Khi hoàn tất: người tạo phiếu và người duyệt đầu tiên được thông báo

=== TÍNH NĂNG BOT ===
1. /connect_erp <token> — Kết nối tài khoản ERP (cần làm 1 lần)
2. /search_voucher — Tìm kiếm phiếu bằng ngôn ngữ tự nhiên (tiếng Việt)
3. /examplesearch — Xem ví dụ câu tìm kiếm
4. /payment_voucher — Xem phiếu mới nhất
5. Nhận thông báo & duyệt phiếu qua nút bấm (tự động)

=== NGUYÊN TẮC TRẢ LỜI ===
- Trả lời bằng tiếng Việt, thân thiện, ngắn gọn (tối đa 5–6 dòng)
- Luôn gợi ý 2–3 câu hỏi hoặc lệnh tiếp theo phù hợp với ngữ cảnh
- Dùng emoji để dễ đọc
- KHÔNG dùng Markdown (không dùng *, **, _, __, \`, etc.) — chỉ dùng plain text và emoji
- Nếu câu hỏi không liên quan đến hệ thống, lịch sự từ chối và hướng về các tính năng hiện có`;

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.7,
        max_tokens: 512,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
      },
    );

    return response.data.choices[0].message.content as string;
  }

  async fetchExternalData() {
    const randomId = Math.floor(Math.random() * 100) + 1;
    return this.httpService.get(`/posts/${randomId}`);
  }
}
