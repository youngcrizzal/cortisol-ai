// src/modules/jira/jira.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '../http/http.service';
import {
  ErpJiraAuthorAggregate,
  ErpJiraWorklogListResponse,
  ErpTimeApplication,
  ErpEmployeeProfile,
  ErpHoliday,
  ErpUserLink,
} from 'src/types/erp';

/**
 * Leave types that mean the employee is NOT working → reduce standard hours.
 * Remote types (REMOTE_UNLIMITED, REMOTE_WOMAN, etc.) are excluded because
 * the employee is still working, just from home.
 */
const LEAVE_TYPES_NOT_WORKING = new Set([
  'ANNUAL_LEAVE',
  'UNPAID',
  'SICK',
  'MATERNITY',
  'FUNERAL',
  'MARRIAGE',
  'WIFE_BIRTH',
  'SICK_CHILD',
  'RECOVERY_SICKNESS',
  'RECOVERY_MATERNITY',
  'RECOVERY_INJURY',
  'STUDY_CONFERENCE',
  'ACCIDENT',
]);

export interface SelfLearningViolation {
  name: string;
  selfLearningHours: number;
  overHours: number;
}

export interface SelfLearningEntry {
  name: string;
  standardHours: number;
  loggedHours: number;
  selfLearningHours: number;
}

@Injectable()
export class JiraService {
  private readonly logger = new Logger(JiraService.name);

  constructor(private readonly httpService: HttpService) {}

  // ─── ERP API calls ────────────────────────────────────────────────────────

  async getWorklogsByPeriod(
    startDate: string,
    endDate: string,
  ): Promise<ErpJiraAuthorAggregate[]> {
    try {
      const resp = await this.httpService.get<ErpJiraWorklogListResponse>(
        '/report/jira-worklogs/worklogs',
        { params: { dateFrom: startDate, dateTo: endDate } },
      );
      return resp.worklogs ?? [];
    } catch (error) {
      this.logger.error(`Failed to fetch Jira worklogs: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch all active JIRA user-links and build maps:
   *   accountToUserId: jiraAccountId → ERP userId
   *   userIdToName:    ERP userId → Jira displayName (for reporting)
   */
  async getJiraUserLinks(): Promise<{
    accountToUserId: Map<string, string>;
    userIdToName: Map<string, string>;
  }> {
    try {
      const links = await this.httpService.get<ErpUserLink[]>(
        '/user-links/system/JIRA',
      );

      const accountToUserId = new Map<string, string>();
      const userIdToName = new Map<string, string>();

      for (const link of links) {
        if (!link.active) continue;
        accountToUserId.set(link.externalUserId, link.userId);
        const name =
          link.externalUsername ||
          `${link.user?.firstName ?? ''} ${link.user?.lastName ?? ''}`.trim();
        userIdToName.set(link.userId, name);
      }

      return { accountToUserId, userIdToName };
    } catch (error) {
      this.logger.error(`Failed to fetch Jira user-links: ${error.message}`);
      return { accountToUserId: new Map(), userIdToName: new Map() };
    }
  }

  async getApprovedLeaves(
    startDate: string,
    endDate: string,
  ): Promise<ErpTimeApplication[]> {
    try {
      const resp = await this.httpService.get<{
        data: ErpTimeApplication[];
        total: number;
      }>('/application/time-applications', {
        params: { type: 'LEAVE', status: 'APPROVED', limit: 200 },
      });
      const all = resp.data ?? [];
      const periodStart = new Date(startDate);
      const periodEnd = new Date(endDate);
      periodEnd.setHours(23, 59, 59, 999);
      return all.filter((app) =>
        app.leaveDate?.some((ld) => {
          const ldStart = new Date(ld.startTime);
          const ldEnd = new Date(ld.endTime);
          return ldStart <= periodEnd && ldEnd >= periodStart;
        }),
      );
    } catch (error) {
      this.logger.error(`Failed to fetch approved leaves: ${error.message}`);
      return [];
    }
  }

  async getEmployeeProfiles(): Promise<ErpEmployeeProfile[]> {
    try {
      const resp = await this.httpService.get<{
        data: ErpEmployeeProfile[];
        total: number;
      }>('/hr/employees', {
        params: { limit: 200, status: 'ACTIVE' },
      });
      return resp.data ?? [];
    } catch (error) {
      this.logger.error(`Failed to fetch employee profiles: ${error.message}`);
      return [];
    }
  }

  async getHolidaysInPeriod(
    startDate: string,
    endDate: string,
  ): Promise<Date[]> {
    try {
      const resp = await this.httpService.get<{
        data: ErpHoliday[];
        meta?: object;
      }>('/holiday-config/holidays', {
        params: { fromDate: startDate, toDate: endDate, limit: 50 },
      });
      const dates: Date[] = [];
      for (const holiday of resp.data ?? []) {
        for (const hd of holiday.holidayDates ?? []) {
          const d = new Date(hd.holidayDate);
          // Only weekday holidays reduce working hours
          if (d.getDay() !== 0 && d.getDay() !== 6) {
            dates.push(d);
          }
        }
      }
      return dates;
    } catch (error) {
      this.logger.error(`Failed to fetch holidays: ${error.message}`);
      return [];
    }
  }

  // ─── Calculation helpers ──────────────────────────────────────────────────

  countWorkingDays(start: Date, end: Date): number {
    let count = 0;
    const current = new Date(start);
    current.setHours(0, 0, 0, 0);
    const endDay = new Date(end);
    endDay.setHours(0, 0, 0, 0);
    while (current <= endDay) {
      const day = current.getDay();
      if (day !== 0 && day !== 6) count++;
      current.setDate(current.getDate() + 1);
    }
    return count;
  }

  private calcLeaveHoursInPeriod(
    leaves: ErpTimeApplication[],
    employeeProfileId: string, // employee_profiles.id = time_applications.employeeId
    periodStart: Date,
    periodEnd: Date,
  ): number {
    let hours = 0;
    for (const app of leaves) {
      if (app.employeeId !== employeeProfileId) continue;
      if (!LEAVE_TYPES_NOT_WORKING.has(app.leaveType)) continue;
      for (const ld of app.leaveDate ?? []) {
        const ldStart = new Date(ld.startTime);
        const ldEnd = new Date(ld.endTime);
        if (ldStart <= periodEnd && ldEnd >= periodStart) {
          hours += ld.days * 8;
        }
      }
    }
    return hours;
  }

  private toDateStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // ─── Main violation check ────────────────────────────────────────────────
  // Called by cron every Monday (no args) or by test with explicit period.

  private resolvePeriod(overrideStart?: Date, overrideEnd?: Date): { monthStart: Date; periodEnd: Date } {
    const now = new Date();
    const periodEnd = overrideEnd ?? (() => {
      const d = new Date(now);
      d.setDate(now.getDate() - 1);
      d.setHours(23, 59, 59, 999);
      return d;
    })();
    const monthStart = overrideStart ?? new Date(periodEnd.getFullYear(), periodEnd.getMonth(), 1);
    return { monthStart, periodEnd };
  }

  private async computeSelfLearning(overrideStart?: Date, overrideEnd?: Date): Promise<SelfLearningEntry[]> {
    const { monthStart, periodEnd } = this.resolvePeriod(overrideStart, overrideEnd);
    const startStr = this.toDateStr(monthStart);
    const endStr = this.toDateStr(periodEnd);

    this.logger.log(`Checking violations: ${startStr} → ${endStr}`);

    const [authorWorklogs, employees, approvedLeaves, holidays, userLinks] = await Promise.all([
      this.getWorklogsByPeriod(startStr, endStr),
      this.getEmployeeProfiles(),
      this.getApprovedLeaves(startStr, endStr),
      this.getHolidaysInPeriod(startStr, endStr),
      this.getJiraUserLinks(),
    ]);

    const { accountToUserId } = userLinks;
    const employeeByUserId = new Map<string, ErpEmployeeProfile>();
    for (const emp of employees) {
      if (emp.userId) employeeByUserId.set(emp.userId, emp);
    }
    const holidayHours = holidays.length * 8;

    const secondsByAccountId = new Map<string, number>();
    const displayNameByAccountId = new Map<string, string>();
    for (const entry of authorWorklogs) {
      secondsByAccountId.set(entry.accountId, (secondsByAccountId.get(entry.accountId) ?? 0) + entry.seconds);
      if (!displayNameByAccountId.has(entry.accountId)) displayNameByAccountId.set(entry.accountId, entry.displayName);
    }

    const result: SelfLearningEntry[] = [];
    for (const [accountId, totalSeconds] of secondsByAccountId) {
      const userId = accountToUserId.get(accountId);
      if (!userId) {
        this.logger.debug(`No UserLink for Jira accountId ${accountId} (${displayNameByAccountId.get(accountId)}) — skipping`);
        continue;
      }

      const employee = employeeByUserId.get(userId);
      const displayName = employee?.fullName ?? displayNameByAccountId.get(accountId) ?? accountId;

      let periodStart = new Date(monthStart);
      if (employee?.hireDate) {
        const joinDate = new Date(employee.hireDate);
        joinDate.setHours(0, 0, 0, 0);
        if (joinDate > periodEnd) continue;
        if (joinDate > monthStart) periodStart = joinDate;
      }

      const workingDays = this.countWorkingDays(periodStart, periodEnd);
      let standardHours = workingDays * 8 - holidayHours;
      if (employee) {
        standardHours -= this.calcLeaveHoursInPeriod(approvedLeaves, employee.id, periodStart, periodEnd);
      }
      standardHours = Math.max(0, standardHours);

      const loggedHours = totalSeconds / 3600;
      const selfLearning = standardHours - loggedHours;
      this.logger.debug(`${displayName}: standard=${standardHours}h, logged=${loggedHours.toFixed(1)}h, self-learning=${selfLearning.toFixed(1)}h`);

      result.push({
        name: displayName,
        standardHours,
        loggedHours: Math.round(loggedHours * 10) / 10,
        selfLearningHours: Math.round(selfLearning * 10) / 10,
      });
    }

    return result.sort((a, b) => b.selfLearningHours - a.selfLearningHours);
  }

  async findViolations(overrideStart?: Date, overrideEnd?: Date): Promise<SelfLearningViolation[]> {
    const all = await this.computeSelfLearning(overrideStart, overrideEnd);
    return all
      .filter((e) => e.selfLearningHours > 30)
      .map((e) => ({
        name: e.name,
        selfLearningHours: e.selfLearningHours,
        overHours: Math.round((e.selfLearningHours - 30) * 10) / 10,
      }));
  }

  async getAllSelfLearningHours(overrideStart?: Date, overrideEnd?: Date): Promise<SelfLearningEntry[]> {
    return this.computeSelfLearning(overrideStart, overrideEnd);
  }
}
