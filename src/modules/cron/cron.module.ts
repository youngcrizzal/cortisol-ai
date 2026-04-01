// src/modules/cron/cron.module.ts

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '../http/http.module';
import { JiraModule } from '../jira/jira.module';
import { TelegramModule } from '../telegram/telegram.module';
import { CronService } from './cron.service';

@Module({
  imports: [HttpModule, ScheduleModule.forRoot(), JiraModule, TelegramModule],
  providers: [CronService],
  exports: [CronService],
})
export class CronModule {}
