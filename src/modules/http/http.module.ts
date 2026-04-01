// src/modules/http/http.module.ts

import { Module } from '@nestjs/common';
import { HttpModule as NestHttpModule } from '@nestjs/axios';
import { HttpService } from './http.service';

@Module({
  imports: [
    NestHttpModule.register({
      baseURL:
        process.env.EXTERNAL_API_URL ||
        'https://staging-erp.twendeesoft.com/api',
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        authorization:
          'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbWgydTNvem8wMDFmbnQxeThpYXo0M3d4IiwidXNlcklkIjoiY21oMnUzb3pvMDAxZm50MXk4aWF6NDN3eCIsInVzZXJuYW1lIjoidGFpZGQiLCJlbWFpbCI6InRhaWRkQHR3ZW5kZWVzb2Z0LmNvbSIsInJvbGUiOiJBRE1JTiIsInNwZWNpYWxQZXJtaXNzaW9ucyI6W10sImlhdCI6MTc3NTA0MDU2NiwiZXhwIjoxNzc1MTI2OTY2fQ.lnKk__cp20HNcGzJl9jCgtQFjojSXUOAKtPJ6D3yw6Q',
      },
    }),
  ],
  providers: [HttpService],
  exports: [HttpService],
})
export class HttpModule {}
