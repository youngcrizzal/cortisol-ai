// src/modules/agent/agent.service.ts

import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { HttpService } from '../http/http.service';
import { JiraService } from '../jira/jira.service';
import { ReportService } from '../report/report.service';

const MAX_HISTORY = 20; // messages kept per user (~10 turns)

export interface AgentReply {
  reply: string;
  filePath?: string;
  fileName?: string;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly groq: OpenAI;
  private readonly histories = new Map<string, ChatCompletionMessageParam[]>();
  private pendingFile: { path: string; name: string } | null = null;

  constructor(
    private readonly httpService: HttpService,
    private readonly jiraService: JiraService,
    private readonly reportService: ReportService,
  ) {
    this.groq = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Process a user message and return the agent's reply.
   * Maintains per-user conversation history automatically.
   * @param erpToken  Optional — required when tools need to call ERP on behalf of the user.
   */
  async chat(
    telegramId: string,
    userMessage: string,
    erpToken?: string,
  ): Promise<AgentReply> {
    this.pendingFile = null;
    const history = this.getHistory(telegramId);
    history.push({ role: 'user', content: userMessage });

    const reply = await this.runAgentLoop(history, erpToken);

    history.push({ role: 'assistant', content: reply });
    this.trimHistory(telegramId);

    const pf = this.pendingFile as { path: string; name: string } | null;
    return pf
      ? { reply, filePath: pf.path, fileName: pf.name }
      : { reply };
  }

  clearHistory(telegramId: string) {
    this.histories.delete(telegramId);
  }

  // ─── Agentic loop ─────────────────────────────────────────────────────────

  private async runAgentLoop(
    history: ChatCompletionMessageParam[],
    erpToken?: string,
  ): Promise<string> {
    let response;
    try {
      response = await this.groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: this.buildSystemPrompt() }, ...history],
        tools: TOOLS,
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens: 1024,
      });
    } catch (err) {
      this.logger.error(`Groq initial call failed: ${err.message}`);
      return 'Xin lỗi, tôi không thể xử lý yêu cầu này. Bạn thử hỏi lại theo cách khác nhé.';
    }

    // Loop until no more tool calls (max 5 iterations to prevent infinite loops)
    let iterations = 0;
    while (response.choices[0].finish_reason === 'tool_calls' && iterations < 5) {
      iterations++;
      const rawMsg = response.choices[0].message;
      const historyLenBefore = history.length;

      // Execute all tool calls and collect results (normalize args before touching history)
      const toolMessages: ChatCompletionMessageParam[] = [];
      const normalizedToolCalls: typeof rawMsg.tool_calls = [];

      for (const toolCall of rawMsg.tool_calls ?? []) {
        if (toolCall.type !== 'function') {
          normalizedToolCalls.push(toolCall);
          continue;
        }

        // Parse and coerce number fields so the history we store is always valid
        let args: Record<string, any>;
        try {
          const parsed = JSON.parse(toolCall.function.arguments);
          args = parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
          args = {};
        }
        for (const key of NUMBER_FIELDS) {
          if (key in args && typeof args[key] === 'string') {
            const n = Number(args[key]);
            if (!isNaN(n)) args[key] = n;
          }
        }
        const normalizedArgs = JSON.stringify(args);

        normalizedToolCalls.push({
          ...toolCall,
          function: { ...toolCall.function, arguments: normalizedArgs },
        });

        // Skip tool calls with names not in TOOLS (model hallucination)
        const knownTool = TOOLS.find(
          (t) => t.type === 'function' && t.function.name === toolCall.function.name,
        );
        if (!knownTool) {
          this.logger.warn(`Unknown tool call skipped: ${toolCall.function.name}`);
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Tool không tồn tại: ${toolCall.function.name}`,
          });
          continue;
        }

        const result = await this.executeTool(toolCall.function.name, args, erpToken);
        toolMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      // Push normalized assistant message to history (valid arg types guaranteed)
      const assistantMsg = { ...rawMsg, tool_calls: normalizedToolCalls };
      history.push(assistantMsg);

      history.push(...toolMessages);

      try {
        response = await this.groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'system', content: this.buildSystemPrompt() }, ...history],
          tools: TOOLS,
          tool_choice: 'auto',
          temperature: 0.3,
          max_tokens: 1024,
        });
      } catch (err) {
        // Rollback dirty history state and return graceful message
        this.logger.error(`Groq API error in agentic loop: ${err.message}`);
        history.splice(historyLenBefore);
        return 'Xin lỗi, đã có lỗi khi xử lý yêu cầu. Vui lòng thử lại.';
      }
    }

    return response.choices[0].message.content ?? 'Xin lỗi, tôi không thể xử lý yêu cầu này.';
  }

  // ─── Tool execution ───────────────────────────────────────────────────────

  private async executeTool(
    name: string,
    args: Record<string, any>,
    erpToken?: string,
  ): Promise<string> {
    this.logger.log(`Tool call: ${name}(${JSON.stringify(args)})`);
    try {
      switch (name) {
        case 'search_vouchers':
          return await this.toolSearchVouchers(args, erpToken);
        case 'get_voucher_detail':
          return await this.toolGetVoucherDetail(args, erpToken);
        case 'find_violations':
          return await this.toolFindViolations();
        case 'query_ledger':
          return await this.toolQueryLedger(args.question);
        case 'generate_cashflow_report':
          return await this.toolGenerateCashflowReport();
        default:
          return `Không tìm thấy tool: ${name}`;
      }
    } catch (err) {
      this.logger.error(`Tool ${name} failed: ${err.message}`);
      return `Lỗi khi thực hiện ${name}: ${err.message}`;
    }
  }

  private async toolSearchVouchers(
    params: VoucherSearchParams,
    erpToken?: string,
  ): Promise<string> {
    // Use per-user token if available, otherwise fall back to system token (read-only is fine)
    const config = erpToken
      ? { params, headers: { authorization: `Bearer ${erpToken}` } }
      : { params };

    const response = await this.httpService.get<ListPaymentVoucherResponse>(
      '/accounting/vouchers',
      config,
    );

    const { data, total } = response;
    if (!data.length) return 'Không tìm thấy phiếu nào phù hợp.';

    const lines = data.map((v) => {
      const amount = Number(v.totalAmount).toLocaleString('vi-VN');
      const date = new Date(v.issueDate).toLocaleDateString('vi-VN');
      return `• *${v.code}* — ${v.content} — ${amount} ${v.currency} — ${v.status} (${date})`;
    });

    const header = `Tìm thấy *${total}* phiếu${data.length < total ? `, hiển thị ${data.length}` : ''}:`;
    return [header, ...lines].join('\n');
  }

  private async toolGetVoucherDetail(
    args: { id?: string; code?: string },
    erpToken?: string,
  ): Promise<string> {
    if (!args.id && !args.code) return 'Cần cung cấp id hoặc code của phiếu.';

    const authHeader = erpToken ? { authorization: `Bearer ${erpToken}` } : undefined;

    let voucher: PaymentVoucher;
    if (args.id) {
      voucher = await this.httpService.get<PaymentVoucher>(
        `/accounting/vouchers/${args.id}/detail`,
        authHeader ? { headers: authHeader } : undefined,
      );
    } else {
      const list = await this.httpService.get<ListPaymentVoucherResponse>(
        '/accounting/vouchers',
        { params: { code: args.code, limit: 1 }, ...(authHeader ? { headers: authHeader } : {}) },
      );
      if (!list.data.length) return `Không tìm thấy phiếu với mã ${args.code}.`;
      voucher = list.data[0];
    }

    const amount = Number(voucher.totalAmount).toLocaleString('vi-VN');
    const approvalStatus = (voucher.approvals ?? [])
      .sort((a, b) => a.index - b.index)
      .map((a) => `  [${a.index}] ${a.approver?.fullName ?? a.approverId}: ${a.status}`)
      .join('\n');

    return [
      `*${voucher.code}* — ${voucher.status}`,
      `💰 ${amount} ${voucher.currency}`,
      `📝 ${voucher.content}`,
      `📅 ${new Date(voucher.issueDate).toLocaleDateString('vi-VN')}`,
      approvalStatus ? `\nDuyệt:\n${approvalStatus}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async toolFindViolations(): Promise<string> {
    const violations = await this.jiraService.findViolations();
    if (!violations.length) return 'Tuần này không có nhân viên nào vi phạm quy định tự học.';

    const lines = violations.map(
      (v, i) => `${i + 1}. ${v.name}: ${v.selfLearningHours}h tự học (vượt ${v.overHours}h)`,
    );
    return [`⚠️ ${violations.length} vi phạm:`, ...lines].join('\n');
  }

  private async toolQueryLedger(question: string): Promise<string> {
    return this.reportService.answerQuery(question);
  }

  private async toolGenerateCashflowReport(): Promise<string> {
    if (!this.reportService.hasLedgerData()) {
      return '⚠️ Chưa có dữ liệu sổ cái. Vui lòng upload file Excel sổ cái trước.';
    }
    const os = await import('os');
    const path = await import('path');
    const label = this.reportService.getLedgerMonthLabel();
    const fileName = `cashflow_${label.replace('/', '_')}.xlsx`;
    const filePath = path.join(os.tmpdir(), fileName);

    const buffer = await this.reportService.generateCashflowExcel();
    const fs = await import('fs');
    fs.writeFileSync(filePath, buffer);

    this.pendingFile = { path: filePath, name: fileName };
    return `Đã tạo báo cáo cashflow tháng ${label}. File sẽ được gửi kèm.`;
  }

  // ─── History management ───────────────────────────────────────────────────

  private getHistory(telegramId: string): ChatCompletionMessageParam[] {
    if (!this.histories.has(telegramId)) {
      this.histories.set(telegramId, []);
    }
    return this.histories.get(telegramId)!;
  }

  private trimHistory(telegramId: string) {
    const history = this.histories.get(telegramId);
    if (history && history.length > MAX_HISTORY) {
      // Drop oldest messages but always keep in pairs (user+assistant)
      this.histories.set(telegramId, history.slice(-MAX_HISTORY));
    }
  }

  // ─── System prompt ────────────────────────────────────────────────────────

  private buildSystemPrompt(): string {
    const now = new Date();
    const dateStr = now.toLocaleDateString('vi-VN', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    return `Bạn là trợ lý kế toán thông minh của công ty Twendee, tích hợp với hệ thống ERP.
Hôm nay là ${dateStr}.

Bạn có thể:
- Tìm kiếm và xem chi tiết phiếu thu/chi trong ERP
- Kiểm tra danh sách nhân viên vi phạm quy định tự học
- Trả lời câu hỏi về dữ liệu sổ cái kế toán
- Tạo và gửi file Excel báo cáo cashflow

Quy tắc:
- Luôn trả lời bằng tiếng Việt, ngắn gọn và thân thiện
- Dùng tools khi cần lấy dữ liệu thực tế, không đoán
- Tìm kiếm và xem phiếu không cần token, cứ gọi thẳng tool
- Định dạng số tiền theo kiểu Việt Nam (dấu chấm phân cách hàng nghìn)
- Phiếu chi = PAYMENT, phiếu thu = RECEIPT
- Trạng thái: DRAFT=nháp, PROCESSING=chờ duyệt, APPROVED=đã duyệt, REJECTED=từ chối`;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Fields that should be numbers but Groq sometimes returns as strings
const NUMBER_FIELDS = ['page', 'limit', 'minAmount', 'maxAmount'];

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_vouchers',
      description:
        'Tìm kiếm, lọc, đếm phiếu kế toán trong ERP. Dùng khi hỏi về phiếu chi/thu, trạng thái, số tiền, người nhận, khoảng thời gian.',
      parameters: {
        type: 'object',
        properties: {
          voucherType: {
            type: 'string',
            enum: ['PAYMENT', 'RECEIPT'],
            description: 'PAYMENT=phiếu chi, RECEIPT=phiếu thu',
          },
          status: {
            type: 'string',
            enum: ['DRAFT', 'PROCESSING', 'APPROVED', 'REJECTED', 'CANCELLED'],
          },
          content: { type: 'string', description: 'Nội dung/mục đích phiếu' },
          payerReceiver: { type: 'string', description: 'Tên người nhận/gửi' },
          issueDateFrom: { type: 'string', description: 'ISO date string' },
          issueDateTo: { type: 'string', description: 'ISO date string' },
          minAmount: { type: 'number', description: 'Số tiền tối thiểu (VND)' },
          maxAmount: { type: 'number', description: 'Số tiền tối đa (VND)' },
          sortBy: {
            type: 'string',
            enum: ['createdAt', 'issueDate', 'postingDate', 'totalAmount'],
          },
          sortOrder: { type: 'string', enum: ['asc', 'desc'] },
          page: { type: 'number' },
          limit: { type: 'number', description: 'Mặc định 10, tối đa 100' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_voucher_detail',
      description: 'Lấy thông tin chi tiết một phiếu cụ thể, bao gồm trạng thái duyệt.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ID của phiếu' },
          code: { type: 'string', description: 'Mã phiếu, ví dụ PC-2026-001' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_violations',
      description:
        'Kiểm tra danh sách nhân viên vi phạm quy định tự học (> 30h/tháng) trong tuần hiện tại.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_ledger',
      description:
        'Trả lời câu hỏi về dữ liệu sổ cái kế toán đã upload: dòng tiền, tổng thu/chi, tài khoản cụ thể.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'Câu hỏi về dữ liệu kế toán',
          },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_cashflow_report',
      description:
        'Tạo và gửi file Excel báo cáo cashflow từ dữ liệu sổ cái đã upload. Dùng khi người dùng yêu cầu xuất báo cáo, file Excel, hoặc báo cáo cashflow.',
      parameters: { type: 'object', properties: {} },
    },
  },
];
