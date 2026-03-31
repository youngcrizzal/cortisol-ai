// src/modules/cron/cron.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { JiraService } from '../jira/jira.service';
import { TelegramService } from '../telegram/telegram.service';

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private readonly jiraService: JiraService,
    private readonly telegramService: TelegramService,
    private readonly config: ConfigService,
  ) {}

  // ─── Feature 3: Weekly self-learning alert ────────────────────────────────
  // Runs every Monday at 08:00 — checks self-learning hours up to last Friday

  @Cron('0 8 * * 1', { name: 'weekly-self-learning-alert' })
  async sendWeeklySelfLearningAlert() {
    this.logger.log('Running weekly self-learning violation check...');

    const quynhId = this.config.get<string>('QUYNH_TELEGRAM_ID');
    if (!quynhId) {
      this.logger.warn('QUYNH_TELEGRAM_ID not set — skipping alert');
      return;
    }

    let violations;
    try {
      violations = await this.jiraService.findViolations();
    } catch (error) {
      this.logger.error(`Failed to fetch violations: ${error.message}`);
      return;
    }

    if (violations.length === 0) {
      this.logger.log('No self-learning violations this week.');
      return;
    }

    const now = new Date();
    const lastMonday = new Date(now);
    lastMonday.setDate(now.getDate() - 7);
    const lastFriday = new Date(now);
    lastFriday.setDate(now.getDate() - 3);

    const fmt = (d: Date) =>
      d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });

    const lines = violations
      .map(
        (v, i) =>
          `${i + 1}. 👤 ${v.name}: *${v.selfLearningHours}h* tự học (vượt ${v.overHours}h)`,
      )
      .join('\n');

    const message =
      `⚠️ *Cảnh báo tự học vượt mức*\n` +
      `Tuần ${fmt(lastMonday)} – ${fmt(lastFriday)}\n\n` +
      `${lines}\n\n` +
      `Tổng: *${violations.length}* nhân sự vi phạm (> 30h tự học/tháng)`;

    try {
      await this.telegramService.sendMessageToUser(quynhId, message);
      this.logger.log(`Self-learning alert sent to ${quynhId}`);
    } catch (error) {
      this.logger.error(`Failed to send alert: ${error.message}`);
    }
  }

  // ─── Placeholder: voucher polling (Feature 1) ─────────────────────────────
  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'poll-vouchers' })
  async pollNewVouchers() {
    // TODO Feature 1: poll ERP for PROCESSING vouchers and send Telegram approval messages
  }
}
