'use strict';

const { httpRequest, retryAsync } = require('./utils');
const Logger = require('./logger');

class SupabaseClient {
  constructor(config, logger) {
    this.url = config.supabase.url;
    this.serviceKey = config.supabase.service_key;
    this.host = this.url.replace('https://', '');
    this.logger = logger;
  }

  async _request(method, table, body, params) {
    const queryParams = new URLSearchParams(params || {});
    const queryStr = queryParams.toString();
    const path = `/rest/v1/${table}${queryStr ? `?${queryStr}` : ''}`;

    const options = {
      hostname: this.host,
      path,
      method,
      headers: {
        'apikey': this.serviceKey,
        'Authorization': `Bearer ${this.serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
    };

    return retryAsync(
      async () => {
        const response = await httpRequest(options, body);
        if (response.statusCode >= 400) {
          const errorMsg = response.raw || `${method} ${table} failed with ${response.statusCode}`;
          throw new Error(errorMsg);
        }
        return response.body;
      },
      { maxAttempts: 3, delayMs: 500 },
    );
  }

  async insert(table, data) {
    try {
      const result = await this._request('POST', table, data);
      return { data: result, error: null };
    } catch (err) {
      this.logger.error('Supabase insert failed', {
        table,
        error: err.message,
      });
      return { data: null, error: err };
    }
  }

  async select(table, params) {
    try {
      const result = await this._request('GET', table, null, params);
      return { data: result, error: null };
    } catch (err) {
      this.logger.error('Supabase select failed', {
        table,
        error: err.message,
      });
      return { data: null, error: err };
    }
  }

  async update(table, data, params) {
    try {
      const queryParams = new URLSearchParams(params || {});
      const queryStr = queryParams.toString();
      const path = `/rest/v1/${table}${queryStr ? `?${queryStr}` : ''}`;

      const options = {
        hostname: this.host,
        path,
        method: 'PATCH',
        headers: {
          'apikey': this.serviceKey,
          'Authorization': `Bearer ${this.serviceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
      };

      const result = await httpRequest(options, data);
      if (result.statusCode >= 400) {
        throw new Error(result.raw || `PATCH ${table} failed`);
      }
      return { data: result.body, error: null };
    } catch (err) {
      this.logger.error('Supabase update failed', {
        table,
        error: err.message,
      });
      return { data: null, error: err };
    }
  }

  async delete(table, params) {
    try {
      const queryParams = new URLSearchParams(params || {});
      const queryStr = queryParams.toString();
      const path = `/rest/v1/${table}${queryStr ? `?${queryStr}` : ''}`;

      const options = {
        hostname: this.host,
        path,
        method: 'DELETE',
        headers: {
          'apikey': this.serviceKey,
          'Authorization': `Bearer ${this.serviceKey}`,
        },
      };

      const result = await httpRequest(options, null);
      if (result.statusCode >= 400) {
        throw new Error(result.raw || `DELETE ${table} failed`);
      }
      return { data: result.body, error: null };
    } catch (err) {
      this.logger.error('Supabase delete failed', {
        table,
        error: err.message,
      });
      return { data: null, error: err };
    }
  }
}

module.exports = SupabaseClient;
