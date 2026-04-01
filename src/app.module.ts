import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { CronModule } from './modules/cron/cron.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { ReportModule } from './modules/report/report.module';
import { JiraModule } from './modules/jira/jira.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    TelegramModule,
    CronModule,
    ReportModule,
    JiraModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
