// src/modules/cron/cron.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from 'generated/prisma/client';
import { buildVoucherMessage } from 'src/lib/voucher';
import { PrismaService } from 'src/prisma/prisma.service';
import { HttpService } from '../http/http.service';
import { JiraService } from '../jira/jira.service';
import { TelegramService } from '../telegram/telegram.service';

interface UserLinkMetadata {
  firstName?: string;
  lastName?: string;
  activatedAt?: string;
  requestedAt?: string;
  deactivatedAt?: string;
  lastRequestedAt?: string;
  [key: string]: unknown;
}

interface ErpUser {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
}

interface ErpUserLink {
  id: string;
  userId: string;
  externalSystem: string;
  externalUserId: string;
  externalUsername: string;
  metadata: UserLinkMetadata;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  user: ErpUser;
}

interface UserLinksResponse {
  data: ErpUserLink[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly jiraService: JiraService,
    private readonly telegramService: TelegramService,
  ) {}

  // ─── Feature 1: Sync Telegram UserLinks from ERP ─────────────────────────

  @Cron(CronExpression.EVERY_5_SECONDS)
  async syncUserLinks() {
    this.logger.log('Syncing user links from ERP...');
    try {
      const response = await this.httpService.get<UserLinksResponse>(
        '/user-links',
        {
          params: {
            externalSystem: 'TELEGRAM',
            active: true,
            page: 1,
            limit: 900,
          },
        },
      );

      const userLinks = response.data;

      await Promise.all(
        userLinks.map((link) =>
          this.prisma.userLink.upsert({
            where: { id: link.id },
            update: {
              userId: link.userId,
              externalSystem: link.externalSystem,
              externalUserId: link.externalUserId,
              externalUsername: link.externalUsername,
              metadata: link.metadata as Prisma.InputJsonValue,
              active: link.active,
              userEmail: link.user?.email,
              userUsername: link.user?.username,
              userFirstName: link.user?.firstName,
              userLastName: link.user?.lastName,
              updatedAt: new Date(link.updatedAt),
            },
            create: {
              id: link.id,
              userId: link.userId,
              externalSystem: link.externalSystem,
              externalUserId: link.externalUserId,
              externalUsername: link.externalUsername,
              metadata: link.metadata as Prisma.InputJsonValue,
              active: link.active,
              userEmail: link.user?.email,
              userUsername: link.user?.username,
              userFirstName: link.user?.firstName,
              userLastName: link.user?.lastName,
              createdAt: new Date(link.createdAt),
              updatedAt: new Date(link.updatedAt),
            },
          }),
        ),
      );

      this.logger.log(`Synced ${userLinks.length} user links successfully`);
    } catch (error) {
      this.logger.error(`Failed to sync user links: ${error.message}`);
    }
  }

  // ─── Feature 1: Poll payment vouchers from ERP ────────────────────────────

  @Cron(CronExpression.EVERY_5_SECONDS)
  async getListLatestPaymentVoucher() {
    try {
      const response = await this.httpService.get<ListPaymentVoucherResponse>(
        '/accounting/vouchers',
        {
          params: {
            page: 1,
            limit: 20,
            sortBy: 'updatedAt',
            sortOrder: 'desc',
          },
        },
      );

      for (const voucher of response.data) {
        await this.upsertVoucher(voucher);
      }
    } catch (error) {
      this.logger.error(`Failed to sync payment vouchers: ${error.message}`);
    }
  }

  private async upsertVoucher(voucher: PaymentVoucher) {
    const existing = await this.prisma.paymentVoucher.findUnique({
      where: { id: voucher.id },
      select: { updatedAt: true, status: true },
    });

    const isNew = !existing;
    const isUpdated =
      !!existing &&
      existing.updatedAt.toISOString() !==
        new Date(voucher.updatedAt).toISOString();
    const justEnteredProcessing =
      isUpdated &&
      existing?.status !== 'PROCESSING' &&
      voucher.status === 'PROCESSING';

    if (!isNew && !isUpdated) return;

    // 1. Upsert Creator
    const savedCreator = await this.prisma.creator.upsert({
      where: { email: voucher.creator.email },
      update: {
        firstName: voucher.creator.firstName,
        lastName: voucher.creator.lastName,
      },
      create: {
        id: voucher.creator.id,
        email: voucher.creator.email,
        firstName: voucher.creator.firstName,
        lastName: voucher.creator.lastName,
      },
    });

    // 2. Upsert BankAccount
    await this.prisma.bankAccount.upsert({
      where: { id: voucher.account.id },
      update: {
        code: voucher.account.code,
        name: voucher.account.name,
        description: voucher.account.description,
        bank: voucher.account.bank,
        isActive: voucher.account.isActive,
      },
      create: {
        id: voucher.account.id,
        code: voucher.account.code,
        name: voucher.account.name,
        description: voucher.account.description,
        bank: voucher.account.bank,
        isActive: voucher.account.isActive,
      },
    });

    // 3. Upsert Employees, Projects, Suppliers referenced in details
    for (const detail of voucher.details ?? []) {
      if (detail.employee) {
        await this.prisma.employee.upsert({
          where: { id: detail.employee.id },
          update: {
            employeeCode: detail.employee.employeeCode,
            fullName: detail.employee.fullName,
            gender: detail.employee.gender,
            department: detail.employee.department,
            position: detail.employee.position,
            jobTitle: detail.employee.jobTitle,
            level:
              detail.employee.level != null
                ? (detail.employee.level as Prisma.InputJsonValue)
                : Prisma.DbNull,
          },
          create: {
            id: detail.employee.id,
            employeeCode: detail.employee.employeeCode,
            fullName: detail.employee.fullName,
            gender: detail.employee.gender,
            department: detail.employee.department,
            position: detail.employee.position,
            jobTitle: detail.employee.jobTitle,
            level:
              detail.employee.level != null
                ? (detail.employee.level as Prisma.InputJsonValue)
                : Prisma.DbNull,
          },
        });
      }

      if (detail.project) {
        await this.prisma.project.upsert({
          where: { id: detail.project.id },
          update: { code: detail.project.code, name: detail.project.name },
          create: {
            id: detail.project.id,
            code: detail.project.code,
            name: detail.project.name,
          },
        });
      }

      if (detail.supplier) {
        await this.prisma.supplier.upsert({
          where: { id: detail.supplier.id },
          update: {
            code: detail.supplier.code,
            name: detail.supplier.name,
            contractDate: new Date(detail.supplier.contractDate),
            contractEndDate: new Date(detail.supplier.contractEndDate),
          },
          create: {
            id: detail.supplier.id,
            code: detail.supplier.code,
            name: detail.supplier.name,
            contractDate: new Date(detail.supplier.contractDate),
            contractEndDate: new Date(detail.supplier.contractEndDate),
          },
        });
      }
    }

    // 4. Upsert PaymentVoucher
    const voucherData = {
      code: voucher.code,
      voucherType: voucher.voucherType,
      issueDate: new Date(voucher.issueDate),
      postingDate: new Date(voucher.postingDate),
      content: voucher.content,
      accountId: voucher.account.id,
      partnerCode:
        voucher.partnerCode != null
          ? (voucher.partnerCode as Prisma.InputJsonValue)
          : Prisma.DbNull,
      payerReceiver: voucher.payerReceiver,
      bankAccount: voucher.bankAccount,
      bankCode: voucher.bankCode,
      note: voucher.note,
      attachments: (voucher.attachments ?? []) as Prisma.InputJsonValue[],
      currency: voucher.currency,
      exchangeRate: voucher.exchangeRate,
      taxIncluded: voucher.taxIncluded,
      totalAmount: voucher.totalAmount,
      status: voucher.status,
      creatorId: savedCreator.id,
      updatedAt: new Date(voucher.updatedAt),
    };

    await this.prisma.paymentVoucher.upsert({
      where: { id: voucher.id },
      update: voucherData,
      create: {
        id: voucher.id,
        ...voucherData,
        createdAt: new Date(voucher.createdAt),
      },
    });

    // 5. Upsert Approvers and Approvals
    for (const approval of voucher.approvals ?? []) {
      await this.prisma.approver.upsert({
        where: { id: approval.approver.id },
        update: {
          fullName: approval.approver.fullName,
          email: approval.approver.email,
        },
        create: {
          id: approval.approver.id,
          fullName: approval.approver.fullName,
          email: approval.approver.email,
        },
      });

      await this.prisma.approval.upsert({
        where: { id: approval.id },
        update: {
          approverId: approval.approver.id,
          status: approval.status,
          comments: approval.comments,
          index: approval.index,
        },
        create: {
          id: approval.id,
          voucherId: voucher.id,
          approverId: approval.approver.id,
          status: approval.status,
          comments: approval.comments,
          index: approval.index,
          createdAt: new Date(approval.createdAt),
        },
      });
    }

    // 6. Upsert Details
    for (const detail of voucher.details ?? []) {
      await this.prisma.detail.upsert({
        where: { id: detail.id },
        update: {
          description: detail.description,
          quantity: detail.quantity,
          amount: detail.amount,
          taxRate: detail.taxRate,
          taxAmount: detail.taxAmount,
          totalAmount: detail.totalAmount,
          expenseCategory: detail.expenseCategory,
          expenseObject: detail.expenseObject,
          employeeId: detail.employeeId,
          projectId: detail.projectId,
          supplierId: detail.supplierId,
          customerId:
            detail.customerId != null
              ? (detail.customerId as Prisma.InputJsonValue)
              : Prisma.DbNull,
        },
        create: {
          id: detail.id,
          voucherId: voucher.id,
          description: detail.description,
          quantity: detail.quantity,
          amount: detail.amount,
          taxRate: detail.taxRate,
          taxAmount: detail.taxAmount,
          totalAmount: detail.totalAmount,
          expenseCategory: detail.expenseCategory,
          expenseObject: detail.expenseObject,
          employeeId: detail.employeeId,
          projectId: detail.projectId,
          supplierId: detail.supplierId,
          customerId:
            detail.customerId != null
              ? (detail.customerId as Prisma.InputJsonValue)
              : Prisma.DbNull,
        },
      });
    }

    // 7. Upsert RelatedObjects
    for (const related of voucher.relatedObjects ?? []) {
      await this.prisma.relatedObject.upsert({
        where: { id: related.id },
        update: {
          relatedType: related.relatedType,
          relatedId: related.relatedId,
        },
        create: {
          id: related.id,
          voucherId: voucher.id,
          relatedType: related.relatedType,
          relatedId: related.relatedId,
        },
      });
    }

    this.logger.log(`Voucher ${voucher.code} ${isNew ? 'created' : 'updated'}`);

    // 8. Notify first PENDING approver on creation OR when voucher enters PROCESSING.
    if (isNew || justEnteredProcessing) {
      await this.notifyFirstPendingApprover(voucher);
    }
  }

  private async notifyFirstPendingApprover(voucher: PaymentVoucher) {
    const firstPending = voucher.approvals
      ?.filter((a) => a.status === 'PENDING')
      ?.sort((a, b) => a.index - b.index)?.[0];

    if (!firstPending) return;

    const userLink = await this.prisma.userLink.findFirst({
      where: {
        userEmail: firstPending.approver.email,
        active: true,
        externalSystem: 'TELEGRAM',
      },
    });

    if (!userLink) {
      this.logger.warn(
        `No Telegram link found for approver: ${firstPending.approver.email}`,
      );
      return;
    }

    const message = buildVoucherMessage(voucher);
    await this.telegramService.sendVoucherApprovalRequest(
      userLink.externalUserId,
      message,
      voucher.id,
    );
    this.logger.log(
      `Notified ${firstPending.approver.fullName} (${userLink.externalUserId}) for voucher ${voucher.code}`,
    );
  }

  // ─── Feature 3: Weekly self-learning alert ────────────────────────────────
  // Runs every Monday at 08:00 — checks self-learning hours up to last Friday

  @Cron('0 8 * * 1', { name: 'weekly-self-learning-alert' })
  async sendWeeklySelfLearningAlert() {
    this.logger.log('Running weekly self-learning violation check...');

    // Resolve recipients dynamically: all ACCOUNTING-role employees with Telegram linked
    let recipientIds: string[];
    try {
      recipientIds = await this.telegramService.findTelegramIdsByRole('ACCOUNTING');
    } catch (error) {
      this.logger.error(`Failed to resolve ACCOUNTING recipients: ${error.message}`);
      return;
    }

    if (!recipientIds.length) {
      this.logger.warn('No ACCOUNTING users have Telegram linked — skipping alert');
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

    for (const telegramId of recipientIds) {
      try {
        await this.telegramService.sendMessageToUser(telegramId, message);
        this.logger.log(`Self-learning alert sent to ${telegramId}`);
      } catch (error) {
        this.logger.error(`Failed to send alert to ${telegramId}: ${error.message}`);
      }
    }
  }
}
