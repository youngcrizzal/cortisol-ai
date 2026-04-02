// src/scripts/test-agent.ts
// Tests AgentService end-to-end: conversation history, tool calling, multi-turn

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AgentService } from '../modules/agent/agent.service';

const USER_ID = 'test-user-001';

async function run() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const agent = app.get(AgentService);

  const cases: { label: string; msg: string; needsErp?: boolean }[] = [
    { label: 'Greeting / context-free', msg: 'Xin chào! Bạn có thể làm gì?' },
    { label: 'Violation check (no ERP needed)', msg: 'Tuần này có ai vi phạm tự học không?' },
    { label: 'Ledger query (no ERP needed)', msg: 'Tổng chi tháng 1 năm 2026 là bao nhiêu?' },
    { label: 'Voucher search (needs ERP token)', msg: 'Cho tôi xem phiếu chi gần đây', needsErp: true },
    { label: 'Follow-up (history test)', msg: 'Cái nào có số tiền lớn nhất?' },
    { label: 'Multi-step: violations then ledger', msg: 'So sánh với tổng lương tháng 1 xem' },
  ];

  console.log('\n=== TEST: AgentService ===\n');

  for (const c of cases) {
    console.log(`─── ${c.label} ───`);
    console.log(`User: ${c.msg}`);
    try {
      const { reply, filePath } = await agent.chat(USER_ID, c.msg, c.needsErp ? undefined : undefined);
      // Truncate long replies for readability
      const short = reply.length > 300 ? reply.slice(0, 300) + '…' : reply;
      console.log(`Agent: ${short}${filePath ? ` [FILE: ${filePath}]` : ''}`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
    console.log();
  }

  // Test conversation memory: new user should have clean history
  console.log('─── History isolation (different user) ───');
  const { reply: reply2 } = await agent.chat('test-user-002', 'Xin chào, tôi là ai?');
  console.log(`Agent (user-002): ${reply2.slice(0, 150)}`);

  // Verify user-001 still has history
  const { reply: reply3 } = await agent.chat(USER_ID, 'Nhắc lại câu hỏi đầu tiên tôi hỏi là gì?');
  console.log(`\nAgent (user-001, memory check): ${reply3.slice(0, 200)}`);

  console.log('\n=== DONE ===');
  await app.close();
}

run().catch(console.error);
