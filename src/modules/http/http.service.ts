// src/modules/http/http.service.ts

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService as NestHttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosRequestConfig } from 'axios';

@Injectable()
export class HttpService implements OnModuleInit {
  private readonly logger = new Logger(HttpService.name);

  constructor(
    private readonly nestHttpService: NestHttpService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const baseURL = this.nestHttpService.axiosRef.defaults.baseURL;
    this.logger.log(`ERP base URL: ${baseURL}`);

    // Inject auth token at request time (not at module init time)
    this.nestHttpService.axiosRef.interceptors.request.use((cfg) => {
      const token = this.config.get<string>('ERP_ACCESS_TOKEN');
      if (token && !cfg.headers['Authorization']) {
        cfg.headers['Authorization'] = `Bearer ${token}`;
      }
      this.logger.debug(`→ ${cfg.method?.toUpperCase()} ${cfg.baseURL ?? ''}${cfg.url} (auth: ${!!cfg.headers['Authorization']})`);
      return cfg;
    });
  }

  async get<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
    try {
      this.logger.debug(`GET ${url}`);
      const response = await firstValueFrom(
        this.nestHttpService.get<T>(url, config),
      );
      return response.data;
    } catch (error) {
      this.logger.error(`GET ${url} failed: ${error.message}`);
      throw error;
    }
  }

  async post<T = any>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    try {
      this.logger.debug(`POST ${url}`);
      const response = await firstValueFrom(
        this.nestHttpService.post<T>(url, data, config),
      );
      return response.data;
    } catch (error) {
      this.logger.error(`POST ${url} failed: ${error.message}`);
      throw error;
    }
  }

  async put<T = any>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    try {
      this.logger.debug(`PUT ${url}`);
      const response = await firstValueFrom(
        this.nestHttpService.put<T>(url, data, config),
      );
      return response.data;
    } catch (error) {
      this.logger.error(`PUT ${url} failed: ${error.message}`);
      throw error;
    }
  }

  async delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
    try {
      this.logger.debug(`DELETE ${url}`);
      const response = await firstValueFrom(
        this.nestHttpService.delete<T>(url, config),
      );
      return response.data;
    } catch (error) {
      this.logger.error(`DELETE ${url} failed: ${error.message}`);
      throw error;
    }
  }
}
