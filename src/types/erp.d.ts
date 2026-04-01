// ERP API response types (Twendee ERP)
// Amounts are Decimal strings — never parse to float

export type VoucherType = 'PAYMENT' | 'RECEIPT';
export type VoucherStatus = 'DRAFT' | 'PROCESSING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SKIPPED';

export interface ErpUser {
  id: string;
  username: string;
  email: string;
}

export interface ErpMoneyAccount {
  id: string;
  code: string;
  name: string;
  bank?: string;
  isActive: boolean;
}

export interface ErpVoucherApproval {
  id: string;
  voucherId: string;
  approverId: string;
  status: ApprovalStatus;
  index: number; // 0-based step order
  comments?: string;
  approver: ErpUser;
  createdAt: string;
  updatedAt: string;
}

export interface ErpVoucherDetail {
  id: string;
  voucherId: string;
  description: string;
  quantity: number;
  amount: string; // Decimal string
  taxRate?: string;
  taxAmount?: string;
  totalAmount: string; // Decimal string
  expenseCategory?: string;
  employeeId?: string;
  projectId?: string;
  supplierId?: string;
  customerId?: string;
  employee?: { id: string; fullName: string };
  project?: { id: string; name: string };
}

export interface ErpVoucherRelation {
  id: string;
  voucherId: string;
  relatedType: 'CONTRACT' | 'PROJECT' | 'PROCESS' | 'VENDOR';
  relatedId: string;
}

export interface ErpVoucher {
  id: string;
  code: string;
  voucherType: VoucherType;
  issueDate: string;
  postingDate: string;
  content: string;
  totalAmount: string; // Decimal string — keep as string
  currency: string;
  exchangeRate?: string;
  taxIncluded: boolean;
  status: VoucherStatus;
  payerReceiver?: string;
  bankAccount?: string;
  bankCode?: string;
  note?: string;
  attachments: string[];
  account?: ErpMoneyAccount;
  details: ErpVoucherDetail[];
  approvals: ErpVoucherApproval[];
  relatedObjects: ErpVoucherRelation[];
  creator?: ErpUser;
  createdAt: string;
  updatedAt: string;
}

export interface ListPaymentVoucherResponse {
  data: ErpVoucher[];
  total: number;
  page: number;
  limit: number;
}

export interface ErpAuthResponse {
  accessToken: string;
  refreshToken: string;
  user: ErpUser & { role: string };
}

// ─── Jira worklogs ────────────────────────────────────────────────────────

/** Per-author aggregate returned by GET /report/jira-worklogs/worklogs */
export interface ErpJiraAuthorAggregate {
  accountId: string; // Jira user ID (= JiraAuthor.id)
  displayName: string;
  email?: string;
  seconds: number; // total logged seconds in period
  hours: number;
}

export interface ErpJiraWorklogListResponse {
  worklogs: ErpJiraAuthorAggregate[];
  total: number;
}

// ─── Leave / time applications ────────────────────────────────────────────

export interface ErpLeaveDate {
  id: string;
  startTime: string; // ISO timestamp
  endTime: string; // ISO timestamp
  days: number; // fractional days (e.g. 0.5 = half-day)
}

export interface ErpTimeApplication {
  id: string;
  employeeId: string;
  type: 'LEAVE' | 'OVERTIME' | 'CHECKIN' | 'OFFBOARDING' | 'BUSINESS_TRIP';
  leaveType: string; // e.g. 'ANNUAL_LEAVE', 'UNPAID', 'SICK'
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'IN_PROGRESS';
  leaveDate: ErpLeaveDate[];
  employee?: { id: string; fullName: string };
}

// ─── Employee profiles ────────────────────────────────────────────────────

export interface ErpEmployeeProfile {
  id: string;     // employee_profiles.id (used as employeeId in time_applications)
  userId: string; // users.id (used as UserLink.userId)
  fullName: string;
  employeeCode: string;
  hireDate: string; // ISO timestamp = joinDate in DB
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
}

// ─── Holidays ─────────────────────────────────────────────────────────────

export interface ErpHolidayDate {
  id: string;
  holidayDate: string; // ISO timestamp
  isPaid: boolean;
}

export interface ErpHoliday {
  id: string;
  reason: string;
  holidayType: 'NATIONAL' | 'COMPANY' | 'CUSTOM';
  holidayDates: ErpHolidayDate[];
}

// ─── User links ───────────────────────────────────────────────────────────

export interface ErpUserLink {
  id: string;
  userId: string;           // ERP users.id
  externalSystem: 'JIRA' | 'GOOGLE_CALENDAR' | 'PORTAL_OUTSOURCING' | 'TELEGRAM';
  externalUserId: string;   // Jira accountId (for JIRA system)
  externalUsername: string; // Jira displayName
  active: boolean;
  user: ErpUser & { firstName?: string; lastName?: string };
}
