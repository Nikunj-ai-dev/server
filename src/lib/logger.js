'use strict';

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  constructor(level = 'info') {
    this.level = LOG_LEVELS[level] || LOG_LEVELS.info;
  }

  _log(level, message, data = {}) {
    if (LOG_LEVELS[level] < this.level) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...data,
    };

    if (level === 'error') {
      console.error(JSON.stringify(entry));
    } else if (level === 'warn') {
      console.warn(JSON.stringify(entry));
    } else {
      console.log(JSON.stringify(entry));
    }
  }

  debug(message, data) {
    this._log('debug', message, data);
  }

  info(message, data) {
    this._log('info', message, data);
  }

  warn(message, data) {
    this._log('warn', message, data);
  }

  error(message, data) {
    this._log('error', message, data);
  }

  // Mask sensitive data from logs
  static maskSensitive(obj) {
    if (!obj || typeof obj !== 'object') return obj;

    const masked = { ...obj };
    const sensitiveKeys = [
      'token',
      'secret',
      'key',
      'password',
      'card',
      'ssn',
      'payment',
      'signature',
    ];

    for (const key of Object.keys(masked)) {
      if (
        sensitiveKeys.some((s) => key.toLowerCase().includes(s)) &&
        typeof masked[key] === 'string'
      ) {
        masked[key] = '***REDACTED***';
      }
    }

    return masked;
  }
}

module.exports = Logger;
