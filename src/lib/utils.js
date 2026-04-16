'use strict';

const crypto = require('crypto');
const https = require('https');

// ─── INPUT VALIDATION ─────────────────────────────────────────────────────
function sanitizeText(str, maxLen = 255) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'`]/g, '').trim().slice(0, maxLen);
}

function validateEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]{2,}\.[^\s@]+$/.test(email.toLowerCase());
}

function validatePhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  const cleaned = phone.replace(/\D/g, '').slice(-10);
  return /^[6-9]\d{9}$/.test(cleaned);
}

function cleanPhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  return phone.replace(/\D/g, '').slice(-10);
}

function validateAddress(address) {
  if (!address || typeof address !== 'object') return false;
  const required = ['full_name', 'address_line1', 'city', 'state'];
  return required.every((field) => address[field] && typeof address[field] === 'string');
}

// ─── CRYPTO ───────────────────────────────────────────────────────────────
function generateRequestId() {
  return crypto.randomBytes(16).toString('hex');
}

function generateOTP() {
  const bytes = crypto.randomBytes(4);
  const num = bytes.readUInt32BE(0);
  return String(100000 + (num % 900000));
}

function hashOTP(otp, salt) {
  return crypto.createHmac('sha256', salt).update(otp).digest('hex');
}

function generateIdempotencyKey(data) {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('sha256').update(str).digest('hex');
}

// ─── NETWORK ──────────────────────────────────────────────────────────────
function getClientIP(req) {
  if (!req || !req.headers) return '0.0.0.0';

  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  return req.socket?.remoteAddress || '0.0.0.0';
}

function parseJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function readBody(req, maxSize = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';

    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > maxSize) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });

    req.on('end', () => {
      resolve(data);
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// ─── HTTP REQUESTS ────────────────────────────────────────────────────────
function httpRequest(options, body, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
        if (responseData.length > 10 * 1024 * 1024) {
          req.destroy();
          reject(new Error('Response body too large'));
        }
      });

      res.on('end', () => {
        try {
          const parsed = parseJSON(responseData);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: parsed,
            raw: responseData,
          });
        } catch {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: null,
            raw: responseData,
          });
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error('HTTP request timeout'));
    });

    if (body) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.write(payload);
    }

    req.end();
  });
}

// ─── RETRY LOGIC ──────────────────────────────────────────────────────────
async function retryAsync(
  fn,
  options = {},
) {
  const {
    maxAttempts = 3,
    delayMs = 1000,
    backoffMultiplier = 2,
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt < maxAttempts) {
        const delay = delayMs * Math.pow(backoffMultiplier, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

// ─── TIME ─────────────────────────────────────────────────────────────────
function getTimestamps() {
  const now = new Date();
  return {
    iso: now.toISOString(),
    unix: Math.floor(now.getTime() / 1000),
    ms: now.getTime(),
  };
}

// ─── RESPONSE HELPERS ──────────────────────────────────────────────────────
function respondJSON(res, statusCode, body, headers = {}) {
  const json = JSON.stringify(body);

  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    ...headers,
  });

  res.end(json);
}

function respondHTML(res, html, headers = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://checkout.razorpay.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://graph.facebook.com https://api.razorpay.com https://*.supabase.co https://*.myshopify.com;",
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-XSS-Protection': '1; mode=block',
    ...headers,
  });

  res.end(html);
}

function respondError(res, statusCode, message, requestId) {
  return respondJSON(res, statusCode, {
    error: message,
    requestId,
  });
}

module.exports = {
  sanitizeText,
  validateEmail,
  validatePhone,
  cleanPhone,
  validateAddress,
  generateRequestId,
  generateOTP,
  hashOTP,
  generateIdempotencyKey,
  getClientIP,
  parseJSON,
  readBody,
  httpRequest,
  retryAsync,
  getTimestamps,
  respondJSON,
  respondHTML,
  respondError,
};
