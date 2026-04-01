const VOUCHER_TYPE_MAP: Record<string, string> = {
  PAYMENT: 'Phiếu Chi',
  RECEIPT: 'Phiếu Thu',
};

const VOUCHER_STATUS_MAP: Record<string, string> = {
  DRAFT: 'Bản thảo',
  PENDING: 'Chờ duyệt',
  WAITING_APPROVAL: 'Chờ duyệt',
  APPROVED: 'Đã duyệt',
  REJECTED: 'Đã từ chối',
  CANCELLED: 'Đã hủy',
};

const APPROVAL_STATUS_ICON: Record<string, string> = {
  PENDING: '⏳',
  APPROVED: '✅',
  REJECTED: '❌',
};

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function formatAmount(amount: string, currency: string): string {
  const num = Number(amount);
  if (isNaN(num)) return `${amount} ${currency}`;
  return num.toLocaleString('vi-VN') + ' ' + currency;
}

export function buildVoucherMessage(voucher: any): string {
  const voucherType =
    VOUCHER_TYPE_MAP[voucher.voucherType] ?? voucher.voucherType;
  const status =
    VOUCHER_STATUS_MAP[voucher.status] ?? voucher.status ?? '-';

  const issueDate = formatDate(voucher.issueDate);
  const postingDate = formatDate(voucher.postingDate);
  const amount = formatAmount(voucher.totalAmount, voucher.currency);

  const creatorName =
    [voucher.creator?.firstName, voucher.creator?.lastName]
      .filter(Boolean)
      .join(' ') ||
    voucher.creator?.email ||
    '-';

  const sortedApprovals: any[] = (voucher.approvals ?? []).sort(
    (a: any, b: any) => a.index - b.index,
  );

  const currentApprover = sortedApprovals.find(
    (a) => a.status === 'PENDING',
  );

  // Build message
  let msg = '';

  msg += `🧾 *${voucherType} — ${voucher.code}*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  msg += `📅 *Ngày lập:* ${issueDate}\n`;
  msg += `📅 *Ngày hạch toán:* ${postingDate}\n\n`;

  const payerReceiverLabel =
    voucher.voucherType === 'RECEIPT' ? 'Người gửi' : 'Người nhận';

  msg += `👤 *Người tạo:* ${creatorName}\n`;
  msg += `👥 *${payerReceiverLabel}:* ${voucher.payerReceiver || '-'}\n\n`;

  msg += `📝 *Nội dung:* ${voucher.content || '-'}\n\n`;

  msg += `🏦 *Ngân hàng:* ${voucher.account?.bank || '-'}\n`;
  if (voucher.account?.name) {
    msg += `🏷️ *Tên TK ngân hàng:* ${voucher.account.name}\n`;
  }
  if (voucher.account?.code) {
    msg += `🔢 *Mã TK:* ${voucher.account.code}\n`;
  }
  msg += `💳 *Số tài khoản:* ${voucher.bankAccount || '-'}\n`;
  msg += `💰 *Số tiền:* ${amount}\n`;

  if (voucher.taxIncluded) {
    msg += `🧾 *Thuế:* Đã bao gồm thuế\n`;
  }

  if (voucher.note) {
    msg += `📌 *Ghi chú:* ${voucher.note}\n`;
  }

  msg += `\n📊 *Trạng thái:* ${status}\n`;

  // Detail lines
  const details: any[] = voucher.details ?? [];
  if (details.length > 0) {
    msg += `\n━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📋 *Chi tiết chi phí:*\n`;
    details.forEach((d, i) => {
      const lineAmount = formatAmount(d.totalAmount, voucher.currency);
      msg += `  ${i + 1}. ${d.description || '-'}\n`;
      msg += `      💵 ${lineAmount}`;
      if (d.expenseCategory) msg += `  |  📁 ${d.expenseCategory}`;
      if (d.employee?.fullName) msg += `  |  👤 ${d.employee.fullName}`;
      if (d.project?.name) msg += `  |  🗂 ${d.project.name}`;
      msg += `\n`;
    });
  }

  // Approval chain
  if (sortedApprovals.length > 0) {
    msg += `\n━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `✅ *Quy trình phê duyệt:*\n`;
    sortedApprovals.forEach((a) => {
      const icon = APPROVAL_STATUS_ICON[a.status] ?? '⬜';
      const isCurrent = a.status === 'PENDING' && a.id === currentApprover?.id;
      const suffix = isCurrent ? ' ← *Đang chờ*' : '';
      msg += `  ${a.index}. ${icon} ${a.approver?.fullName ?? '-'}${suffix}\n`;
    });
  }

  if (currentApprover) {
    msg += `\n⚠️ *Yêu cầu phê duyệt từ:* ${currentApprover.approver?.fullName ?? '-'}`;
  }

  return msg;
}

const VOUCHER_STATUS_VI: Record<string, string> = {
  DRAFT: 'Bản thảo',
  PROCESSING: 'Đang xử lý',
  APPROVED: 'Đã duyệt',
  REJECTED: 'Từ chối',
  CANCELLED: 'Đã hủy',
};

export function buildVoucherListMessage(
  vouchers: PaymentVoucher[],
  total: number,
  page: number,
  totalPages: number,
): string {
  if (vouchers.length === 0) {
    return '📭 Không tìm thấy phiếu nào phù hợp.';
  }

  let msg = `🔍 *Kết quả tìm kiếm:* ${total} phiếu`;
  if (totalPages > 1) {
    msg += ` _(trang ${page}/${totalPages})_`;
  }
  msg += `\n\n`;

  vouchers.forEach((v, i) => {
    const type = VOUCHER_TYPE_MAP[v.voucherType] ?? v.voucherType;
    const status = VOUCHER_STATUS_VI[v.status] ?? v.status;
    const amount = formatAmount(v.totalAmount, v.currency);
    const date = formatDate(v.issueDate);

    msg += `*${(page - 1) * vouchers.length + i + 1}. ${v.code}* — ${type}\n`;
    msg += `   💰 ${amount}  |  📊 ${status}\n`;
    msg += `   📅 ${date}  |  👥 ${v.payerReceiver || '-'}\n`;
    if (v.content) msg += `   📝 ${v.content}\n`;
    msg += `\n`;
  });

  return msg.trimEnd();
}
