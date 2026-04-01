// src/modules/jira/jira.module.ts

import { Module } from '@nestjs/common';
import { JiraService } from './jira.service';
import { HttpModule } from '../http/http.module';

@Module({
  imports: [HttpModule],
  providers: [JiraService],
  exports: [JiraService],
})
export class JiraModule {}
