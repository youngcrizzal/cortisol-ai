// src/modules/http/http.module.ts

import { Module } from '@nestjs/common';
import { HttpModule as NestHttpModule } from '@nestjs/axios';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HttpService } from './http.service';

@Module({
  imports: [
    ConfigModule,
    NestHttpModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        baseURL:
          config.get<string>('ERP_BASE_URL') ||
          'https://staging-erp.twendeesoft.com/api',
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }),
    }),
  ],
  providers: [HttpService],
  exports: [HttpService],
})
export class HttpModule {}
