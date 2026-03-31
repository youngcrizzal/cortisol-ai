// src/modules/jira/jira.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '../http/http.service';
import {
  ErpJiraAuthorAggregate,
  ErpJiraWorklogListResponse,
  ErpTimeApplication,
  ErpEmployeeProfile,
  ErpHoliday,
} from 'src/types/erp';

/**
 * Leave types that mean the employee is NOT working → reduce standard hours.
 * Remote types (REMOTE_UNLIMITED, REMOTE_WOMAN, REMOTE_WIFE_BIRTH) are excluded
 * because the employee is still working, just from home.
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
      // Keep applications that have at least one leave date overlapping the period
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
        total: number;
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
    employeeId: string,
    periodStart: Date,
    periodEnd: Date,
  ): number {
    let hours = 0;
    for (const app of leaves) {
      if (app.employeeId !== employeeId) continue;
      if (!LEAVE_TYPES_NOT_WORKING.has(app.leaveType)) continue;
      for (const ld of app.leaveDate ?? []) {
        const ldStart = new Date(ld.startTime);
        const ldEnd = new Date(ld.endTime);
        if (ldStart <= periodEnd && ldEnd >= periodStart) {
          // days is the pre-calculated fractional working days for this leave entry
          hours += ld.days * 8;
        }
      }
    }
    return hours;
  }

  // ─── Main violation check (called every Monday) ───────────────────────────

  private toDateStr(d: Date): string {
    // Format YYYY-MM-DD in local time (avoid UTC shift from toISOString())
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  async findViolations(): Promise<SelfLearningViolation[]> {
    const now = new Date();

    // Cron runs on Monday — check period from start of month up to last Friday
    const periodEnd = new Date(now);
    periodEnd.setDate(now.getDate() - 3);
    periodEnd.setHours(23, 59, 59, 999);

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const startStr = this.toDateStr(monthStart);
    const endStr = this.toDateStr(periodEnd);

    this.logger.log(
      `Checking self-learning violations: ${startStr} → ${endStr}`,
    );

    const [authorWorklogs, employees, approvedLeaves, holidays] =
      await Promise.all([
        this.getWorklogsByPeriod(startStr, endStr),
        this.getEmployeeProfiles(),
        this.getApprovedLeaves(startStr, endStr),
        this.getHolidaysInPeriod(startStr, endStr),
      ]);

    // Map HR name → employee profile for joining with Jira author displayName
    const employeeByName = new Map<string, ErpEmployeeProfile>();
    for (const emp of employees) {
      if (emp.fullName) employeeByName.set(emp.fullName, emp);
    }

    const holidayHours = holidays.length * 8;

    // Jira API returns per-project-per-author → aggregate seconds by displayName
    const secondsByAuthor = new Map<string, number>();
    for (const entry of authorWorklogs) {
      const key = entry.displayName;
      secondsByAuthor.set(key, (secondsByAuthor.get(key) ?? 0) + entry.seconds);
    }

    const violations: SelfLearningViolation[] = [];

    for (const [displayName, totalSeconds] of secondsByAuthor) {
      const author = { displayName, seconds: totalSeconds };
      const employee = employeeByName.get(displayName);

      // Determine effective period start — respect mid-month join date
      let periodStart = new Date(monthStart);
      if (employee?.hireDate) {
        const joinDate = new Date(employee.hireDate);
        joinDate.setHours(0, 0, 0, 0);
        if (joinDate > periodEnd) continue; // joined after the period — skip
        if (joinDate > monthStart) periodStart = joinDate;
      }

      const workingDays = this.countWorkingDays(periodStart, periodEnd);
      let standardHours = workingDays * 8 - holidayHours;

      if (employee) {
        const leaveHours = this.calcLeaveHoursInPeriod(
          approvedLeaves,
          employee.id,
          periodStart,
          periodEnd,
        );
        standardHours -= leaveHours;
      }

      standardHours = Math.max(0, standardHours);

      const loggedHours = author.seconds / 3600;
      const selfLearning = standardHours - loggedHours;

      this.logger.debug(
        `${displayName}: standard=${standardHours}h, logged=${loggedHours.toFixed(1)}h, self-learning=${selfLearning.toFixed(1)}h`,
      );

      if (selfLearning > 30) {
        violations.push({
          name: displayName,
          selfLearningHours: Math.round(selfLearning * 10) / 10,
          overHours: Math.round((selfLearning - 30) * 10) / 10,
        });
      }
    }

    return violations.sort((a, b) => b.selfLearningHours - a.selfLearningHours);
  }
}
