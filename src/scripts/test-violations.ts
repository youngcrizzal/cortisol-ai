import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { JiraService } from '../modules/jira/jira.service';

async function run() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'debug'],
  });
  const jira = app.get(JiraService);

  console.log('\n=== March 2026 violations ===');
  const start = new Date(2026, 2, 1);
  const end = new Date(2026, 2, 31, 23, 59, 59);
  const v1 = await jira.findViolations(start, end);
  console.log(`Found: ${v1.length}`);
  v1.forEach((v, i) => console.log(`  ${i+1}. ${v.name}: ${v.selfLearningHours}h (over ${v.overHours}h)`));

  console.log('\n=== April 2026 (current, up to yesterday) ===');
  const v2 = await jira.findViolations();
  console.log(`Found: ${v2.length}`);
  v2.forEach((v, i) => console.log(`  ${i+1}. ${v.name}: ${v.selfLearningHours}h (over ${v.overHours}h)`));

  await app.close();
}
run().catch(console.error);
