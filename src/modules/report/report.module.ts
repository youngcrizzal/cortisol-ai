// src/modules/report/report.module.ts

import { Module } from '@nestjs/common';
import { ReportService } from './report.service';
import { ReportUpdate } from './report.update';

@Module({
  providers: [ReportService, ReportUpdate],
  exports: [ReportService],
})
export class ReportModule {}
