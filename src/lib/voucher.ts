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

  msg += `👤 *Người tạo:* ${creatorName}\n`;
  msg += `👥 *Người nhận:* ${voucher.payerReceiver || '-'}\n\n`;

  msg += `📝 *Nội dung:* ${voucher.content || '-'}\n\n`;

  msg += `🏦 *Ngân hàng:* ${voucher.account?.bank || '-'}\n`;
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
