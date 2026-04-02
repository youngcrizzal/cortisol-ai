// src/modules/http/http.service.ts

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService as NestHttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosRequestConfig } from 'axios';
import axios from 'axios';

@Injectable()
export class HttpService implements OnModuleInit {
  private readonly logger = new Logger(HttpService.name);
  private accessToken: string | null = null;
  private loginPromise: Promise<string> | null = null;

  constructor(
    private readonly nestHttpService: NestHttpService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const baseURL = this.nestHttpService.axiosRef.defaults.baseURL;
    this.logger.log(`ERP base URL: ${baseURL}`);

    // Inject token on every request
    this.nestHttpService.axiosRef.interceptors.request.use((cfg) => {
      if (this.accessToken && !cfg.headers['Authorization']) {
        cfg.headers['Authorization'] = `Bearer ${this.accessToken}`;
      }
      return cfg;
    });

    // Auto-relogin on 401
    this.nestHttpService.axiosRef.interceptors.response.use(
      (res) => res,
      async (error) => {
        const cfg = error.config;
        if (error.response?.status === 401 && !cfg._retried) {
          cfg._retried = true;
          try {
            this.accessToken = await this.login();
            cfg.headers['Authorization'] = `Bearer ${this.accessToken}`;
            return this.nestHttpService.axiosRef.request(cfg);
          } catch (loginErr) {
            this.logger.error(`Re-login failed: ${loginErr.message}`);
          }
        }
        throw error;
      },
    );
  }

  async login(): Promise<string> {
    if (this.loginPromise) return this.loginPromise;

    this.loginPromise = (async () => {
      const baseURL = this.config.get<string>('ERP_BASE_URL');
      const username = this.config.get<string>('ERP_USERNAME');
      const password = this.config.get<string>('ERP_PASSWORD');
      this.logger.log('Logging in to ERP...');
      const resp = await axios.post(`${baseURL}/auth/login`, {
        username,
        password,
      });
      const token: string = resp.data.accessToken;
      this.logger.log('ERP login successful');
      return token;
    })().finally(() => {
      this.loginPromise = null;
    });

    return this.loginPromise;
  }

  async ensureToken(): Promise<void> {
    if (!this.accessToken) {
      this.accessToken = await this.login();
    }
  }

  async get<T = any>(url: string, config?: AxiosRequestConfig): Promise<T> {
    await this.ensureToken();
    try {
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
    await this.ensureToken();
    try {
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
    await this.ensureToken();
    try {
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
    await this.ensureToken();
    try {
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
