interface PaginationResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

interface PaymentVoucher {
  id: string;
  code: string;
  voucherType: string;
  issueDate: string;
  postingDate: string;
  content: string;
  accountId: string;
  account: BankAccount;
  partnerCode: any;
  payerReceiver: string;
  bankAccount: string;
  bankCode: string;
  note?: string;
  attachments: any[];
  currency: string;
  exchangeRate: string;
  taxIncluded: boolean;
  totalAmount: string;
  status: string;
  details: Detail[];
  approvals: Approval[];
  relatedObjects: RelatedObject[];
  createdAt: string;
  updatedAt: string;
  creator: Creator;
}

interface BankAccount {
  id: string;
  code: string;
  name: string;
  description: string;
  bank: string;
  isActive: boolean;
}

interface Detail {
  id: string;
  voucherId: string;
  description: string;
  quantity: number;
  amount: string;
  taxRate: string;
  taxAmount: string;
  totalAmount: string;
  expenseCategory?: string;
  expenseObject?: string;
  employeeId?: string;
  projectId?: string;
  customerId: any;
  supplierId?: string;
  employee?: Employee;
  project?: Project;
  supplier?: Supplier;
}

interface Employee {
  id: string;
  employeeCode: string;
  fullName: string;
  gender: string;
  department: string;
  position: string;
  jobTitle: string;
  level: any;
}

interface Project {
  id: string;
  code: string;
  name: string;
}

interface Supplier {
  id: string;
  code: string;
  name: string;
  contractDate: string;
  contractEndDate: string;
}

interface Approval {
  id: string;
  voucherId: string;
  approverId: string;
  status: string;
  comments?: string;
  index: number;
  createdAt: string;
  updatedAt: string;
  approver: Approver;
}

interface Approver {
  id: string;
  fullName: string;
  email: string;
}

interface RelatedObject {
  id: string;
  voucherId: string;
  relatedType: string;
  relatedId: string;
}

interface Creator {
  id: string;
  firstName?: string;
  lastName?: string;
  email: string;
}

type ListPaymentVoucherResponse = PaginationResponse<PaymentVoucher>;

type AvailableTool = 'searchVouchers' | 'chat';

interface ToolCall {
  tool: AvailableTool;
  arguments: Record<string, any>;
}

interface VoucherSearchParams {
  voucherType?: string;
  status?: string;
  content?: string;
  payerReceiver?: string;
  issueDateFrom?: string;
  issueDateTo?: string;
  postingDateFrom?: string;
  postingDateTo?: string;
  minAmount?: number;
  maxAmount?: number;
  currency?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: string;
}
