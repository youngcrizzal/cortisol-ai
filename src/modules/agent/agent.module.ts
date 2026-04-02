// src/modules/agent/agent.module.ts

import { Module } from '@nestjs/common';
import { HttpModule } from '../http/http.module';
import { JiraModule } from '../jira/jira.module';
import { ReportModule } from '../report/report.module';
import { AgentService } from './agent.service';

@Module({
  imports: [HttpModule, JiraModule, ReportModule],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
