// src/modules/cron/cron.module.ts

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CronService } from './cron.service';
import { JiraModule } from '../jira/jira.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [ScheduleModule.forRoot(), JiraModule, TelegramModule],
  providers: [CronService],
  exports: [CronService],
})
export class CronModule {}
