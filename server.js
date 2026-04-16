'use strict';

/**
 * E-Commerce Checkout Backend — Production Entry Point
 * 
 * Usage:
 *   npm start                    # Run server only
 *   npm run worker              # Run async job worker only
 *   
 * For production, deploy both as separate processes or containers.
 */

require('dotenv').config();
require('./src/server/app.js');

// Worker process
// To run worker separately:
//   node src/worker/index.js


const {
  SHOPIFY_SHOP_DOMAIN,
  SHOPIFY_STOREFRONT_TOKEN,
  SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_API_SECRET,
  SHOPIFY_API_KEY,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
  META_WHATSAPP_TOKEN,
  META_PHONE_NUMBER_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  APP_URL,
  PORT = '3000',
} = process.env;

// ─── SECURITY & RATE LIMITING ─────────────────────────────────────────────────
const rateLimits = new Map(); // In production, use Redis
const processedPayments = new Map();
const processedOrders = new Map();
const productCache = new Map(); // Simple in-memory cache

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '0.0.0.0';
}

function checkRateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  const windowKey = `${key}:${Math.floor(now / windowMs)}`;
  const current = rateLimits.get(windowKey) || { count: 0, reset: now + windowMs };
  if (now > current.reset) {
    current.count = 1;
    current.reset = now + windowMs;
  } else if (current.count >= maxRequests) {
    return { allowed: false, resetIn: current.reset - now };
  } else {
    current.count++;
  }
  rateLimits.set(windowKey, current);
  return { allowed: true };
}

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of rateLimits.entries()) {
    if (now > data.reset) rateLimits.delete(key);
  }
}, 60000);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1024 * 1024) { // 1MB limit
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseJSON(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function respond(res, statusCode, body, headers = {}) {
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

function respondHTML(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://checkout.razorpay.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://graph.facebook.com https://api.razorpay.com https://*.supabase.co https://*.myshopify.com;",
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-XSS-Protection': '1; mode=block',
  });
  res.end(html);
}

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data), raw: data });
        } catch {
          resolve({ statusCode: res.statusCode, body: null, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function sanitizeText(str, maxLen = 255) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'`]/g, '').trim().slice(0, maxLen);
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePhone(phone) {
  return /^[6-9]\d{9}$/.test(phone.replace(/\s+/g, ''));
}

function generateRequestId() {
  return crypto.randomBytes(16).toString('hex');
}

function log(level, message, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

function validatePhone(phone) {
  return /^[6-9]\d{9}$/.test(phone.replace(/\s+/g, ''));
}

function sanitizeText(str, maxLen = 255) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'`]/g, '').trim().slice(0, maxLen);
}

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '0.0.0.0';
}

// ─── SUPABASE CLIENT ──────────────────────────────────────────────────────────

const SUPABASE_HOST = SUPABASE_URL.replace('https://', '');

async function supabaseQuery(method, path, body, params) {
  let fullPath = `/rest/v1/${path}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    fullPath += `?${qs}`;
  }
  const options = {
    hostname: SUPABASE_HOST,
    path: fullPath,
    method,
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=representation',
    },
  };
  const result = await httpRequest(options, body);
  return result;
}

async function supabaseInsert(table, data) {
  return supabaseQuery('POST', table, data);
}

async function supabaseSelect(table, params) {
  return supabaseQuery('GET', table, null, params);
}

async function supabaseUpdate(table, data, params) {
  let path = table;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    path += `?${qs}`;
  }
  const options = {
    hostname: SUPABASE_HOST,
    path: `/rest/v1/${path}`,
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
  };
  return httpRequest(options, data);
}

// ─── SHOPIFY STOREFRONT API ───────────────────────────────────────────────────

async function fetchCartFromShopify(cartToken) {
  const query = `
    query getCart($id: ID!) {
      cart(id: $id) {
        id
        totalQuantity
        cost {
          totalAmount { amount currencyCode }
          subtotalAmount { amount currencyCode }
        }
        lines(first: 50) {
          edges {
            node {
              id
              quantity
              cost {
                totalAmount { amount currencyCode }
                amountPerQuantity { amount currencyCode }
              }
              merchandise {
                ... on ProductVariant {
                  id
                  title
                  sku
                  availableForSale
                  quantityAvailable
                  image { url altText }
                  product {
                    id
                    title
                    handle
                    images(first: 1) { edges { node { url altText } } }
                  }
                  selectedOptions { name value }
                  price { amount currencyCode }
                  compareAtPrice { amount currencyCode }
                }
              }
            }
          }
        }
      }
    }
  `;

  // Cart token can be a gid or a token; normalise it
  let cartId = cartToken;
  if (!cartToken.startsWith('gid://')) {
    cartId = `gid://shopify/Cart/${cartToken}`;
  }

  const options = {
    hostname: SHOPIFY_SHOP_DOMAIN,
    path: '/api/2024-04/graphql.json',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN,
    },
  };

  const result = await httpRequest(options, { query, variables: { id: cartId } });
  if (result.body && result.body.data && result.body.data.cart) {
    return result.body.data.cart;
  }
  return null;
}

// Fetch product price from Shopify to prevent frontend manipulation
async function fetchProductPrice(variantId) {
  const cacheKey = `price:${variantId}`;
  if (productCache.has(cacheKey)) {
    return productCache.get(cacheKey);
  }

  const query = `
    query getVariant($id: ID!) {
      productVariant(id: $id) {
        price { amount currencyCode }
        compareAtPrice { amount currencyCode }
        availableForSale
        quantityAvailable
      }
    }
  `;

  const options = {
    hostname: SHOPIFY_SHOP_DOMAIN,
    path: '/api/2024-04/graphql.json',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN,
    },
  };

  const result = await httpRequest(options, { query, variables: { id: variantId } });
  if (result.body && result.body.data && result.body.data.productVariant) {
    const price = result.body.data.productVariant;
    productCache.set(cacheKey, price); // Cache for 5 minutes
    setTimeout(() => productCache.delete(cacheKey), 5 * 60 * 1000);
    return price;
  }
  return null;
}

// ─── SHOPIFY ADMIN API ────────────────────────────────────────────────────────

async function shopifyAdminRequest(endpoint, method, body) {
  const options = {
    hostname: SHOPIFY_SHOP_DOMAIN,
    path: `/admin/api/2024-04/${endpoint}`,
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
    },
  };
  return httpRequest(options, body);
}

async function searchShopifyCustomer(phone) {
  const result = await shopifyAdminRequest(`customers/search.json?query=phone:+91${phone}`, 'GET');
  return result.body?.customers || [];
}

async function createShopifyCustomer(data) {
  // First search to avoid duplicates
  const existing = await searchShopifyCustomer(data.phone);
  if (existing.length > 0) {
    return { customer: existing[0] };
  }

  const payload = {
    customer: {
      first_name: data.first_name || 'Guest',
      last_name: data.last_name || 'Customer',
      email: data.email || `guest_${Date.now()}@checkout.placeholder`,
      phone: `+91${data.phone}`,
      verified_email: false,
      accepts_marketing: false,
      tags: 'checkout-guest',
    },
  };
  const res = await shopifyAdminRequest('customers.json', 'POST', payload);
  return res.body;
}

async function createShopifyDraftOrder(payload) {
  const res = await shopifyAdminRequest('draft_orders.json', 'POST', payload);
  return res.body;
}

async function completeDraftOrder(draftOrderId, paymentPending) {
  const endpoint = `draft_orders/${draftOrderId}/complete.json?payment_pending=${paymentPending}`;
  const res = await shopifyAdminRequest(endpoint, 'PUT', {});
  return res.body;
}

async function validateCouponViaShopify(couponCode, lineItems, customerId) {
  // Use Shopify Draft Orders to validate discount
  const payload = {
    draft_order: {
      line_items: lineItems,
      applied_discount: {
        value_type: 'percentage',
        value: '0',
        title: couponCode,
        description: 'Coupon validation',
      },
      use_customer_default_address: false,
    },
  };
  const res = await shopifyAdminRequest('draft_orders.json', 'POST', payload);
  return res.body;
}

// ─── OTP SYSTEM ───────────────────────────────────────────────────────────────

function generateOTP() {
  // Cryptographically secure 6-digit OTP
  const bytes = crypto.randomBytes(4);
  const num = bytes.readUInt32BE(0);
  return String(100000 + (num % 900000));
}

function hashOTP(otp, salt) {
  return crypto.createHmac('sha256', salt).update(otp).digest('hex');
}

// ─── OTP SYSTEM ───────────────────────────────────────────────────────────────

function generateOTP() {
  // Cryptographically secure 6-digit OTP
  const bytes = crypto.randomBytes(4);
  const num = bytes.readUInt32BE(0);
  return String(100000 + (num % 900000));
}

function hashOTP(otp, salt) {
  return crypto.createHmac('sha256', salt).update(otp).digest('hex');
}

async function checkRateLimit(phone, ip) {
  // Rate limit: 5 attempts per 15 minutes per phone
  const phoneLimit = checkRateLimit(`otp:phone:${phone}`, 5, 15 * 60 * 1000);
  if (!phoneLimit.allowed) return { allowed: false, reason: 'Too many OTP requests for this phone. Try again later.' };

  // Rate limit: 10 attempts per hour per IP
  const ipLimit = checkRateLimit(`otp:ip:${ip}`, 10, 60 * 60 * 1000);
  if (!ipLimit.allowed) return { allowed: false, reason: 'Too many requests from your IP. Try again later.' };

  return { allowed: true };
}

async function storeOTP(phone, otp, ip, userAgent) {
  const salt = crypto.randomBytes(16).toString('hex');
  const otpHash = hashOTP(otp, salt) + ':' + salt;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

  // Invalidate old OTPs
  await supabaseUpdate('temp_otp',
    { consumed: true },
    { identifier: `eq.${phone}`, identifier_type: 'eq.phone', consumed: 'eq.false', purpose: 'eq.checkout' }
  );

  const res = await supabaseInsert('temp_otp', {
    identifier: phone,
    identifier_type: 'phone',
    otp_hash: otpHash,
    purpose: 'checkout',
    expires_at: expiresAt,
    ip_address: ip,
    user_agent: userAgent || '',
  });

  return res.body && res.body[0] ? res.body[0].id : null;
}

async function verifyOTP(phone, otp, ip) {
  const now = new Date().toISOString();
  const res = await supabaseSelect('temp_otp', {
    select: 'id,otp_hash,attempts,max_attempts,expires_at,consumed',
    identifier: `eq.${phone}`,
    identifier_type: 'eq.phone',
    purpose: 'eq.checkout',
    consumed: 'eq.false',
    expires_at: `gt.${now}`,
    order: 'created_at.desc',
    limit: '1',
  });

  if (!res.body || !Array.isArray(res.body) || res.body.length === 0) {
    return { valid: false, reason: 'OTP expired or not found.' };
  }

  const record = res.body[0];

  if (record.attempts >= record.max_attempts) {
    return { valid: false, reason: 'Max OTP attempts exceeded.' };
  }

  // Increment attempts
  await supabaseUpdate('temp_otp', {
    attempts: record.attempts + 1,
    updated_at: new Date().toISOString(),
  }, { id: `eq.${record.id}` });

  const [storedHash, salt] = record.otp_hash.split(':');
  const inputHash = hashOTP(otp, salt);

  if (!crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(storedHash))) {
    return { valid: false, reason: 'Invalid OTP.' };
  }

  // Mark consumed
  await supabaseUpdate('temp_otp', { consumed: true }, { id: `eq.${record.id}` });

  return { valid: true };
}

async function storeOTP(phone, otp, ip, userAgent) {
  const salt = crypto.randomBytes(16).toString('hex');
  const otpHash = hashOTP(otp, salt) + ':' + salt;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

  // Invalidate old OTPs
  await supabaseUpdate('temp_otp',
    { consumed: true },
    { identifier: `eq.${phone}`, identifier_type: 'eq.phone', consumed: 'eq.false', purpose: 'eq.checkout' }
  );

  const res = await supabaseInsert('temp_otp', {
    identifier: phone,
    identifier_type: 'phone',
    otp_hash: otpHash,
    purpose: 'checkout',
    expires_at: expiresAt,
    ip_address: ip,
    user_agent: userAgent || '',
  });

  return res.body && res.body[0] ? res.body[0].id : null;
}

async function verifyOTP(phone, otp, ip) {
  const now = new Date().toISOString();
  const res = await supabaseSelect('temp_otp', {
    select: 'id,otp_hash,attempts,max_attempts,expires_at,consumed',
    identifier: `eq.${phone}`,
    identifier_type: 'eq.phone',
    purpose: 'eq.checkout',
    consumed: 'eq.false',
    expires_at: `gt.${now}`,
    order: 'created_at.desc',
    limit: '1',
  });

  if (!res.body || !Array.isArray(res.body) || res.body.length === 0) {
    return { valid: false, reason: 'OTP expired or not found.' };
  }

  const record = res.body[0];

  if (record.attempts >= record.max_attempts) {
    return { valid: false, reason: 'Max OTP attempts exceeded.' };
  }

  // Increment attempts
  await supabaseUpdate('temp_otp', {
    attempts: record.attempts + 1,
    updated_at: new Date().toISOString(),
  }, { id: `eq.${record.id}` });

  const [storedHash, salt] = record.otp_hash.split(':');
  const inputHash = hashOTP(otp, salt);

  if (!crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(storedHash))) {
    return { valid: false, reason: 'Invalid OTP.' };
  }

  // Mark consumed
  await supabaseUpdate('temp_otp', { consumed: true }, { id: `eq.${record.id}` });

  return { valid: true };
}

// ─── WHATSAPP OTP SENDER ──────────────────────────────────────────────────────

async function sendWhatsAppOTP(phone, otp) {
  const recipient = `91${phone}`;
  const payload = {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'template',
    template: {
      name: 'checkout_otp',
      language: { code: 'en_US' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: otp },
            { type: 'text', text: '10 minutes' },
          ],
        },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: otp }],
        },
      ],
    },
  };

  const options = {
    hostname: 'graph.facebook.com',
    path: `/v19.0/${META_PHONE_NUMBER_ID}/messages`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${META_WHATSAPP_TOKEN}`,
    },
  };

  const result = await httpRequest(options, payload);
  if (result.statusCode !== 200) {
    throw new Error(`WhatsApp API error: ${result.raw}`);
  }
  return result.body;
}

// ─── RAZORPAY ─────────────────────────────────────────────────────────────────

async function createRazorpayOrder(amountInPaise, currency, receipt, notes) {
  const payload = {
    amount: amountInPaise,
    currency,
    receipt,
    notes,
  };
  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
  const options = {
    hostname: 'api.razorpay.com',
    path: '/v1/orders',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${auth}`,
    },
  };
  const result = await httpRequest(options, payload);
  return result.body;
}

function verifyRazorpaySignature(orderId, paymentId, signature) {
  const body = `${orderId}|${paymentId}`;
  const expected = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function verifyRazorpayWebhookSignature(rawBody, signature) {
  const expected = crypto
    .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ─── SHOPIFY OAUTH ────────────────────────────────────────────────────────────

function buildShopifyAuthURL(shop, state) {
  const scopes = [
    'read_orders', 'write_orders',
    'read_customers', 'write_customers',
    'read_products', 'read_inventory', 'write_inventory',
    'read_fulfillments', 'write_fulfillments',
    'read_discounts',
    'read_draft_orders', 'write_draft_orders',
  ].join(',');
  const redirectUri = `${APP_URL}/auth/callback`;
  return `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
}

function verifyShopifyHMAC(params) {
  const { hmac, ...rest } = params;
  const message = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('&');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(message).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
  } catch {
    return false;
  }
}

async function exchangeShopifyCode(shop, code) {
  const options = {
    hostname: shop,
    path: '/admin/oauth/access_token',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  };
  const result = await httpRequest(options, {
    client_id: SHOPIFY_API_KEY,
    client_secret: SHOPIFY_API_SECRET,
    code,
  });
  return result.body;
}

async function storeShopToken(shop, accessToken) {
  // Upsert into a shop_tokens table (simple key-value approach using audit_logs-inspired pattern)
  // We store in a dedicated table; if not present, we use filesystem (for simplicity in single-instance)
  // Production: store in Supabase dedicated shopify_shops table
  const res = await supabaseInsert('shopify_shops', { shop, access_token: accessToken, installed_at: new Date().toISOString() });
  return res;
}

// ─── CHECKOUT HTML ────────────────────────────────────────────────────────────

function buildCheckoutHTML() {
  // served from filesystem in production; embedded here for completeness
  const fs = require('fs');
  const htmlPath = require('path').join(__dirname, 'checkout.html');
  if (fs.existsSync(htmlPath)) {
    return fs.readFileSync(htmlPath, 'utf8');
  }
  return '<h1>Checkout page not found</h1>';
}

// ─── IDEMPOTENCY STORE (in-memory + Supabase) ─────────────────────────────────

const processedPayments = new Map(); // In-memory dedup for hot path

async function checkIdempotency(razorpayOrderId) {
  if (processedPayments.has(razorpayOrderId)) return true;
  const res = await supabaseSelect('payments', {
    select: 'id',
    provider_order_id: `eq.${razorpayOrderId}`,
    payment_status: 'eq.paid',
  });
  return res.body && Array.isArray(res.body) && res.body.length > 0;
}

// ─── ORDER CREATION ───────────────────────────────────────────────────────────

async function createFullOrder({ cartData, address, phone, email, couponCode, discountAmount, paymentMethod, razorpayData, checkoutSessionId }) {
  const isCOD = paymentMethod === 'cod';
  const subtotal = parseFloat(cartData.cost.subtotalAmount.amount);
  const grandTotal = subtotal - (discountAmount || 0);

  // 1. Upsert customer in Supabase
  const customerEmail = email || `guest_${phone}@checkout.noemail`;
  let customerId = null;

  const existingCustomer = await supabaseSelect('customers', {
    select: 'id',
    phone: `eq.${phone}`,
  });

  if (existingCustomer.body && existingCustomer.body.length > 0) {
    customerId = existingCustomer.body[0].id;
    await supabaseUpdate('customers', {
      phone_verified: true,
      updated_at: new Date().toISOString(),
    }, { id: `eq.${customerId}` });
  } else {
    const nameParts = address.full_name.split(' ');
    const newCustomer = await supabaseInsert('customers', {
      first_name: nameParts[0] || 'Guest',
      last_name: nameParts.slice(1).join(' ') || 'Customer',
      email: customerEmail,
      phone,
      phone_verified: true,
      cod_eligible: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (newCustomer.body && newCustomer.body[0]) {
      customerId = newCustomer.body[0].id;
    }
  }

  // 2. Create customer address in Supabase
  if (customerId) {
    await supabaseInsert('customer_addresses', {
      customer_id: customerId,
      full_name: sanitizeText(address.full_name),
      address_line1: sanitizeText(address.address_line1),
      city: sanitizeText(address.city),
      state: sanitizeText(address.state),
      postal_code: sanitizeText(address.postal_code || '000000'),
      country: 'India',
      phone_number: phone,
      is_default: true,
    });
  }

  // 3. Create order in Supabase
  const addressSnapshot = {
    full_name: sanitizeText(address.full_name),
    address_line1: sanitizeText(address.address_line1),
    city: sanitizeText(address.city),
    state: sanitizeText(address.state),
    country: 'India',
    phone,
  };

  const lineItems = cartData.lines.edges.map(({ node }) => ({
    product_id_snapshot: node.merchandise.product?.id,
    product_name_snapshot: node.merchandise.product?.title || 'Product',
    variant_id_snapshot: node.merchandise.id,
    variant_name_snapshot: node.merchandise.title,
    sku_snapshot: node.merchandise.sku,
    quantity: node.quantity,
    unit_price: parseFloat(node.cost.amountPerQuantity.amount),
    line_total: parseFloat(node.cost.totalAmount.amount),
    discount_amount: 0,
    fulfillment_status: 'unfulfilled',
  }));

  const orderRes = await supabaseInsert('orders', {
    customer_id: customerId,
    order_status: 'pending',
    payment_status: isCOD ? 'pending' : 'paid',
    fulfillment_status: 'unfulfilled',
    source_channel: 'website',
    is_cod: isCOD,
    currency: 'INR',
    subtotal,
    discount_total: discountAmount || 0,
    shipping_total: 0,
    grand_total: grandTotal,
    name_snapshot: sanitizeText(address.full_name),
    email_snapshot: customerEmail,
    phone_snapshot: phone,
    shipping_address_snapshot: addressSnapshot,
    billing_address_snapshot: addressSnapshot,
    is_guest: !customerId,
    guest_phone_verified: true,
    guest_phone_verified_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const supabaseOrder = orderRes.body && orderRes.body[0] ? orderRes.body[0] : null;
  const supabaseOrderId = supabaseOrder ? supabaseOrder.id : null;

  // 4. Insert order items
  if (supabaseOrderId) {
    for (const item of lineItems) {
      await supabaseInsert('order_items', { ...item, order_id: supabaseOrderId });
    }
  }

  // 5. Create payment record in Supabase
  if (!isCOD && razorpayData) {
    await supabaseInsert('payments', {
      order_id: supabaseOrderId,
      customer_id: customerId,
      payment_provider: 'razorpay',
      provider_payment_id: razorpayData.razorpay_payment_id,
      provider_order_id: razorpayData.razorpay_order_id,
      payment_method: razorpayData.method || 'razorpay',
      payment_status: 'paid',
      paid_amount: grandTotal,
      currency: 'INR',
      payment_timestamp: new Date().toISOString(),
      verification_status: 'verified',
      is_cod: false,
      gateway_response: razorpayData,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    processedPayments.set(razorpayData.razorpay_order_id, true);
  } else if (isCOD) {
    await supabaseInsert('payments', {
      order_id: supabaseOrderId,
      customer_id: customerId,
      payment_provider: 'cod',
      payment_method: 'cod',
      payment_status: 'pending',
      paid_amount: grandTotal,
      currency: 'INR',
      is_cod: true,
      cod_amount: grandTotal,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  // 6. Create Shopify customer
  let shopifyCustomerId = null;
  try {
    const shopifyCustomer = await createShopifyCustomer({
      first_name: addressSnapshot.full_name.split(' ')[0],
      last_name: addressSnapshot.full_name.split(' ').slice(1).join(' '),
      email: customerEmail,
      phone,
    });
    shopifyCustomerId = shopifyCustomer?.customer?.id;
  } catch (err) {
    console.error('Shopify customer creation error (non-fatal):', err.message);
  }

  // 7. Create Shopify draft order → complete
  let shopifyOrderNumber = null;
  try {
    const shopifyLineItems = cartData.lines.edges.map(({ node }) => ({
      variant_id: node.merchandise.id.replace('gid://shopify/ProductVariant/', ''),
      quantity: node.quantity,
    }));

    const draftPayload = {
      draft_order: {
        line_items: shopifyLineItems,
        customer: shopifyCustomerId ? { id: shopifyCustomerId } : undefined,
        shipping_address: {
          first_name: addressSnapshot.full_name.split(' ')[0],
          last_name: addressSnapshot.full_name.split(' ').slice(1).join(' ') || '.',
          address1: addressSnapshot.address_line1,
          city: addressSnapshot.city,
          province: addressSnapshot.state,
          country: 'IN',
          phone: `+91${phone}`,
        },
        email: customerEmail,
        use_customer_default_address: false,
        send_receipt: true,
        send_fulfillment_receipt: true,
        note: isCOD ? 'COD Order - Custom Checkout' : 'Paid via Razorpay - Custom Checkout',
        tags: isCOD ? 'cod,custom-checkout' : 'razorpay,custom-checkout',
        applied_discount: couponCode ? {
          value_type: 'fixed_amount',
          value: String(discountAmount || 0),
          title: couponCode,
        } : undefined,
      },
    };

    const draftResult = await createShopifyDraftOrder(draftPayload);
    if (draftResult && draftResult.draft_order) {
      const completed = await completeDraftOrder(draftResult.draft_order.id, isCOD);
      shopifyOrderNumber = completed?.order?.name || completed?.order?.order_number;

      // Update Supabase order with Shopify order number
      if (supabaseOrderId && shopifyOrderNumber) {
        await supabaseUpdate('orders', {
          custom_fields: { shopify_order_number: shopifyOrderNumber },
          updated_at: new Date().toISOString(),
        }, { id: `eq.${supabaseOrderId}` });
      }
    }
  } catch (err) {
    console.error('Shopify order creation error (non-fatal):', err.message);
  }

  // 8. Update checkout session status
  if (checkoutSessionId) {
    await supabaseUpdate('checkout_sessions', {
      status: 'completed',
      updated_at: new Date().toISOString(),
    }, { id: `eq.${checkoutSessionId}` });
  }

  // 9. Log analytics event
  await supabaseInsert('analytics_events', {
    event_name: 'order_created',
    metadata: {
      order_id: supabaseOrderId,
      shopify_order_number: shopifyOrderNumber,
      payment_method: paymentMethod,
      grand_total: grandTotal,
    },
    event_timestamp: new Date().toISOString(),
  });

  return {
    success: true,
    order_id: supabaseOrderId,
    shopify_order_number: shopifyOrderNumber,
    grand_total: grandTotal,
  };
}

// ─── ROUTE HANDLERS ───────────────────────────────────────────────────────────

async function handleAuth(req, res, parsedURL) {
  const shop = parsedURL.query.shop;
  if (!shop || !/^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/.test(shop)) {
    res.writeHead(400); res.end('Invalid shop');
    return;
  }
  const state = crypto.randomBytes(16).toString('hex');
  const authURL = buildShopifyAuthURL(shop, state);
  // Store state for CSRF validation (in-memory; use Redis/DB in production)
  oauthStates.set(state, { shop, createdAt: Date.now() });
  res.writeHead(302, { Location: authURL });
  res.end();
}

const oauthStates = new Map();

async function handleAuthCallback(req, res, parsedURL) {
  const { code, hmac, state, shop } = parsedURL.query;
  if (!code || !hmac || !state || !shop) {
    res.writeHead(400); res.end('Missing parameters');
    return;
  }
  // Validate state
  if (!oauthStates.has(state)) {
    res.writeHead(403); res.end('Invalid state');
    return;
  }
  oauthStates.delete(state);
  // Validate HMAC
  if (!verifyShopifyHMAC(parsedURL.query)) {
    res.writeHead(403); res.end('HMAC validation failed');
    return;
  }
  try {
    const tokenData = await exchangeShopifyCode(shop, code);
    if (!tokenData || !tokenData.access_token) {
      res.writeHead(500); res.end('Token exchange failed');
      return;
    }
    await storeShopToken(shop, tokenData.access_token);
    res.writeHead(302, { Location: `https://${shop}/admin` });
    res.end();
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.writeHead(500); res.end('OAuth error');
  }
}

async function handleGetCheckout(req, res, parsedURL) {
  const html = buildCheckoutHTML();
  respondHTML(res, html);
}

async function handleGetCartData(req, res, parsedURL) {
  const cartToken = parsedURL.query.cart_token;
  if (!cartToken || typeof cartToken !== 'string' || cartToken.length < 10) {
    return respond(res, 400, { error: 'Invalid cart_token' });
  }
  try {
    const cart = await fetchCartFromShopify(sanitizeText(cartToken, 100));
    if (!cart) {
      return respond(res, 404, { error: 'Cart not found or expired' });
    }
    // Create/update checkout session in Supabase
    const sessionRes = await supabaseInsert('checkout_sessions', {
      status: 'started',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const sessionId = sessionRes.body && sessionRes.body[0] ? sessionRes.body[0].id : null;

    return respond(res, 200, {
      cart,
      checkout_session_id: sessionId,
    });
  } catch (err) {
    console.error('Cart fetch error:', err);
    return respond(res, 500, { error: 'Failed to fetch cart' });
  }
}

async function handleSendOTP(req, res) {
  const ip = getClientIP(req);
  const requestId = generateRequestId();

  // Rate limit check
  const rateLimit = checkRateLimit(`otp:endpoint:${ip}`, 10, 60 * 1000); // 10 per minute per IP
  if (!rateLimit.allowed) {
    log('warn', 'Rate limit exceeded for send OTP', { requestId, ip });
    return respond(res, 429, { error: 'Too many requests. Please try again later.' });
  }

  const raw = await readBody(req);
  const body = parseJSON(raw);
  if (!body || !body.phone) return respond(res, 400, { error: 'Phone required' });

  const phone = String(body.phone).replace(/\D/g, '').slice(-10);
  if (!validatePhone(phone)) return respond(res, 400, { error: 'Invalid Indian phone number' });

  const userAgent = req.headers['user-agent'] || '';

  // Rate limit check per phone
  const phoneRateCheck = await checkRateLimit(phone, ip);
  if (!phoneRateCheck.allowed) {
    log('warn', 'OTP rate limit exceeded', { requestId, phone, ip });
    return respond(res, 429, { error: phoneRateCheck.reason });
  }

  try {
    const otp = generateOTP();
    await storeOTP(phone, otp, ip, userAgent);
    await sendWhatsAppOTP(phone, otp);

    // Log successful OTP send
    await supabaseInsert('audit_logs', {
      actor_type: 'user',
      action: 'otp_sent',
      entity_type: 'phone',
      entity_id: phone,
      ip_address: ip,
      user_agent: userAgent,
      created_at: new Date().toISOString(),
    });

    log('info', 'OTP sent successfully', { requestId, phone });
    return respond(res, 200, { success: true, message: 'OTP sent via WhatsApp' });
  } catch (err) {
    log('error', 'OTP send failed', { requestId, phone, error: err.message });
    return respond(res, 500, { error: 'Failed to send OTP' });
  }
}

async function handleVerifyOTP(req, res) {
  const raw = await readBody(req);
  const body = parseJSON(raw);
  if (!body || !body.phone || !body.otp) return respond(res, 400, { error: 'Phone and OTP required' });

  const phone = String(body.phone).replace(/\D/g, '').slice(-10);
  const otp = String(body.otp).replace(/\D/g, '').slice(0, 6);

  if (!validatePhone(phone)) return respond(res, 400, { error: 'Invalid phone number' });
  if (otp.length !== 6) return respond(res, 400, { error: 'Invalid OTP format' });

  const ip = getClientIP(req);
  const result = await verifyOTP(phone, otp, ip);

  if (!result.valid) return respond(res, 401, { error: result.reason });

  // Issue a short-lived session token for this verified phone
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const tokenExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

  await supabaseInsert('temp_otp', {
    identifier: phone,
    identifier_type: 'phone',
    otp_hash: crypto.createHash('sha256').update(sessionToken).digest('hex'),
    purpose: 'checkout_session',
    expires_at: tokenExpiry,
    ip_address: ip,
  });

  return respond(res, 200, {
    verified: true,
    session_token: sessionToken,
    expires_at: tokenExpiry,
  });
}

async function handleApplyCoupon(req, res) {
  const raw = await readBody(req);
  const body = parseJSON(raw);

  if (!body || !body.coupon_code || !body.cart_items || !body.subtotal) {
    return respond(res, 400, { error: 'coupon_code, cart_items, subtotal required' });
  }

  const couponCode = sanitizeText(body.coupon_code, 50).toUpperCase();
  const subtotal = parseFloat(body.subtotal);

  try {
    // Check coupon in Supabase coupons table first
    const now = new Date().toISOString();
    const couponRes = await supabaseSelect('coupons', {
      select: '*',
      code: `eq.${couponCode}`,
      is_active: 'eq.true',
      valid_from: `lte.${now}`,
      valid_until: `gte.${now}`,
    });

    if (!couponRes.body || couponRes.body.length === 0) {
      return respond(res, 200, { valid: false, error: 'Invalid or expired coupon' });
    }

    const coupon = couponRes.body[0];

    // Validate minimum cart value
    if (subtotal < (coupon.min_cart_value || 0)) {
      return respond(res, 200, {
        valid: false,
        error: `Minimum cart value ₹${coupon.min_cart_value} required`,
      });
    }

    // Check usage limit
    if (coupon.usage_limit_total && coupon.current_usage_count >= coupon.usage_limit_total) {
      return respond(res, 200, { valid: false, error: 'Coupon usage limit reached' });
    }

    // Calculate discount
    let discountAmount = 0;
    if (coupon.coupon_type === 'percentage') {
      discountAmount = (subtotal * coupon.discount_value) / 100;
      if (coupon.max_discount_amount) {
        discountAmount = Math.min(discountAmount, coupon.max_discount_amount);
      }
    } else if (coupon.coupon_type === 'fixed') {
      discountAmount = Math.min(coupon.discount_value, subtotal);
    } else if (coupon.coupon_type === 'free_shipping') {
      discountAmount = 0; // shipping is already free
    }

    discountAmount = parseFloat(discountAmount.toFixed(2));
    const finalTotal = parseFloat((subtotal - discountAmount).toFixed(2));

    return respond(res, 200, {
      valid: true,
      coupon_code: couponCode,
      coupon_type: coupon.coupon_type,
      discount_value: coupon.discount_value,
      discount_amount: discountAmount,
      subtotal,
      final_total: finalTotal,
      delivery: 0,
      grand_total: finalTotal,
    });
  } catch (err) {
    console.error('Coupon validation error:', err);
    return respond(res, 500, { error: 'Coupon validation failed' });
  }
}

async function handleCreateRazorpayOrder(req, res) {
  const raw = await readBody(req);
  const body = parseJSON(raw);

  if (!body || !body.amount || !body.cart_token || !body.session_token || !body.phone) {
    return respond(res, 400, { error: 'amount, cart_token, session_token, phone required' });
  }

  // Verify session token
  const phone = String(body.phone).replace(/\D/g, '').slice(-10);
  const sessionToken = sanitizeText(body.session_token, 64);
  const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
  const now = new Date().toISOString();

  const sessionRes = await supabaseSelect('temp_otp', {
    select: 'id',
    identifier: `eq.${phone}`,
    otp_hash: `eq.${tokenHash}`,
    purpose: 'eq.checkout_session',
    consumed: 'eq.false',
    expires_at: `gt.${now}`,
  });

  if (!sessionRes.body || sessionRes.body.length === 0) {
    return respond(res, 401, { error: 'Phone not verified. Please re-verify.' });
  }

  const amount = Math.round(parseFloat(body.amount) * 100); // paise
  if (amount < 100) return respond(res, 400, { error: 'Minimum amount ₹1' });

  const receipt = `rcpt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  try {
    const rzOrder = await createRazorpayOrder(amount, 'INR', receipt, {
      cart_token: body.cart_token,
      phone,
    });

    if (!rzOrder || !rzOrder.id) {
      return respond(res, 500, { error: 'Razorpay order creation failed' });
    }

    return respond(res, 200, {
      razorpay_order_id: rzOrder.id,
      amount: rzOrder.amount,
      currency: rzOrder.currency,
      key_id: RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('Razorpay order error:', err);
    return respond(res, 500, { error: 'Payment gateway error' });
  }
}

async function handleVerifyPayment(req, res) {
  const raw = await readBody(req);
  const body = parseJSON(raw);

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return respond(res, 400, { error: 'Payment verification data required' });
  }

  const isValid = verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
  if (!isValid) {
    await supabaseInsert('audit_logs', {
      actor_type: 'system',
      action: 'payment_signature_invalid',
      entity_type: 'payment',
      new_value: { razorpay_order_id, razorpay_payment_id },
      created_at: new Date().toISOString(),
    });
    return respond(res, 400, { error: 'Payment signature verification failed' });
  }

  // Idempotency check
  const alreadyProcessed = await checkIdempotency(razorpay_order_id);
  if (alreadyProcessed) {
    return respond(res, 200, { verified: true, duplicate: true });
  }

  return respond(res, 200, { verified: true, duplicate: false });
}

async function handleCreateOrder(req, res) {
  const ip = getClientIP(req);
  const requestId = generateRequestId();
  const raw = await readBody(req);
  const body = parseJSON(raw);

  if (!body) return respond(res, 400, { error: 'Invalid request body' });

  const {
    cart_token,
    address,
    phone,
    email,
    coupon_code,
    discount_amount,
    payment_method,
    razorpay_data,
    session_token,
    checkout_session_id,
    idempotency_key,
  } = body;

  // Rate limit order creation
  const rateLimit = checkRateLimit(`order:create:${ip}`, 5, 60 * 1000); // 5 orders per minute per IP
  if (!rateLimit.allowed) {
    log('warn', 'Order creation rate limit exceeded', { requestId, ip });
    return respond(res, 429, { error: 'Too many order attempts. Please try again later.' });
  }

  // Validate required fields
  if (!cart_token || !address || !phone || !payment_method) {
    return respond(res, 400, { error: 'cart_token, address, phone, payment_method required' });
  }

  const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
  if (!validatePhone(cleanPhone)) return respond(res, 400, { error: 'Invalid phone' });

  // Validate address
  if (!address.full_name || !address.address_line1 || !address.city || !address.state) {
    return respond(res, 400, { error: 'Incomplete address' });
  }

  // Validate email if provided
  if (email && !validateEmail(email)) {
    return respond(res, 400, { error: 'Invalid email address' });
  }

  // Verify session token (phone verification)
  const sessionTokenClean = sanitizeText(session_token || '', 64);
  if (!sessionTokenClean) return respond(res, 401, { error: 'Phone verification required' });

  const tokenHash = crypto.createHash('sha256').update(sessionTokenClean).digest('hex');
  const now = new Date().toISOString();
  const sessionCheck = await supabaseSelect('temp_otp', {
    select: 'id',
    identifier: `eq.${cleanPhone}`,
    otp_hash: `eq.${tokenHash}`,
    purpose: 'eq.checkout_session',
    consumed: 'eq.false',
    expires_at: `gt.${now}`,
  });

  if (!sessionCheck.body || sessionCheck.body.length === 0) {
    return respond(res, 401, { error: 'Session expired. Please re-verify phone.' });
  }

  // Razorpay payment verification for non-COD
  if (payment_method !== 'cod') {
    if (!razorpay_data) return respond(res, 400, { error: 'Payment data required' });
    const sigValid = verifyRazorpaySignature(
      razorpay_data.razorpay_order_id,
      razorpay_data.razorpay_payment_id,
      razorpay_data.razorpay_signature
    );
    if (!sigValid) {
      log('error', 'Invalid payment signature', { requestId, razorpay_order_id: razorpay_data.razorpay_order_id });
      return respond(res, 400, { error: 'Invalid payment signature' });
    }

    const alreadyProcessed = await checkIdempotency(razorpay_data.razorpay_order_id);
    if (alreadyProcessed) {
      log('info', 'Duplicate payment detected', { requestId, razorpay_order_id: razorpay_data.razorpay_order_id });
      return respond(res, 409, { error: 'Order already processed for this payment' });
    }
  }

  // Fetch cart from Shopify
  let cartData;
  try {
    cartData = await fetchCartFromShopify(sanitizeText(cart_token, 100));
    if (!cartData) return respond(res, 404, { error: 'Cart not found or expired' });
  } catch (err) {
    log('error', 'Cart fetch failed', { requestId, error: err.message });
    return respond(res, 500, { error: 'Could not retrieve cart' });
  }

  try {
    const result = await createFullOrder({
      cartData,
      address: {
        full_name: sanitizeText(address.full_name),
        address_line1: sanitizeText(address.address_line1),
        city: sanitizeText(address.city),
        state: sanitizeText(address.state),
        postal_code: sanitizeText(address.postal_code || ''),
      },
      phone: cleanPhone,
      email: email ? sanitizeText(email, 200) : null,
      couponCode: coupon_code ? sanitizeText(coupon_code, 50).toUpperCase() : null,
      discountAmount: discount_amount ? parseFloat(discount_amount) : 0,
      paymentMethod: payment_method,
      razorpayData: razorpay_data || null,
      checkoutSessionId: checkout_session_id || null,
      idempotencyKey: idempotency_key || null,
    });

    log('info', 'Order created successfully', { requestId, orderId: result.order_id });
    return respond(res, 200, result);
  } catch (err) {
    log('error', 'Order creation failed', { requestId, error: err.message });
    return respond(res, 500, { error: 'Order creation failed. Please contact support.' });
  }
}

async function handleRazorpayWebhook(req, res) {
  const raw = await readBody(req);
  const signature = req.headers['x-razorpay-signature'];
  const requestId = generateRequestId();

  if (!signature || !verifyRazorpayWebhookSignature(raw, signature)) {
    log('error', 'Invalid webhook signature', { requestId });
    return respond(res, 400, { error: 'Invalid webhook signature' });
  }

  const event = parseJSON(raw);
  if (!event) {
    log('error', 'Invalid webhook payload', { requestId });
    return respond(res, 400, { error: 'Invalid payload' });
  }

  // Idempotency check for webhooks
  const eventId = event.event + ':' + (event.payload?.payment?.entity?.id || 'unknown');
  if (processedPayments.has(eventId)) {
    log('info', 'Webhook already processed', { requestId, eventId });
    return respond(res, 200, { received: true });
  }

  try {
    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;
      log('info', 'Processing payment captured webhook', { requestId, paymentId: payment.id });

      // Update payment status in Supabase
      await supabaseUpdate('payments', {
        payment_status: 'paid',
        payment_timestamp: new Date().toISOString(),
        gateway_response: payment,
        updated_at: new Date().toISOString(),
      }, { provider_payment_id: `eq.${payment.id}` });

      // Update associated order
      const paymentRecord = await supabaseSelect('payments', {
        select: 'order_id',
        provider_payment_id: `eq.${payment.id}`,
      });

      if (paymentRecord.body && paymentRecord.body.length > 0) {
        const orderId = paymentRecord.body[0].order_id;
        await supabaseUpdate('orders', {
          payment_status: 'paid',
          order_status: 'confirmed',
          updated_at: new Date().toISOString(),
        }, { id: `eq.${orderId}` });

        log('info', 'Order status updated via webhook', { requestId, orderId });
      }

      processedPayments.set(eventId, true);
    } else if (event.event === 'payment.failed') {
      const payment = event.payload.payment.entity;
      log('warn', 'Processing payment failed webhook', { requestId, paymentId: payment.id });

      await supabaseUpdate('payments', {
        payment_status: 'failed',
        failure_reason: payment.error_description,
        gateway_response: payment,
        updated_at: new Date().toISOString(),
      }, { provider_payment_id: `eq.${payment.id}` });

      processedPayments.set(eventId, true);
    }

    // Log webhook event
    await supabaseInsert('webhook_logs', {
      provider: 'razorpay',
      event_type: event.event,
      event_id: eventId,
      payload: event,
      processed_at: new Date().toISOString(),
    });

  } catch (err) {
    log('error', 'Webhook processing error', { requestId, error: err.message });
  }

  return respond(res, 200, { received: true });
}

// ─── ROUTER ───────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.NODE_ENV === 'production' ? APP_URL : '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
};

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Attach CORS to all responses
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  const parsedURL = url.parse(req.url, true);
  const pathname = parsedURL.pathname;
  const method = req.method;
  const requestId = generateRequestId();

  // Log request
  log('info', 'Request received', {
    requestId,
    method,
    pathname,
    ip: getClientIP(req),
    userAgent: req.headers['user-agent'] || 'unknown',
  });

  try {
    if (method === 'GET' && pathname === '/checkout') return await handleGetCheckout(req, res, parsedURL);
    if (method === 'GET' && pathname === '/cart-data') return await handleGetCartData(req, res, parsedURL);
    if (method === 'POST' && pathname === '/send-otp') return await handleSendOTP(req, res);
    if (method === 'POST' && pathname === '/verify-otp') return await handleVerifyOTP(req, res);
    if (method === 'POST' && pathname === '/apply-coupon') return await handleApplyCoupon(req, res);
    if (method === 'POST' && pathname === '/create-razorpay-order') return await handleCreateRazorpayOrder(req, res);
    if (method === 'POST' && pathname === '/verify-payment') return await handleVerifyPayment(req, res);
    if (method === 'POST' && pathname === '/create-order') return await handleCreateOrder(req, res);
    if (method === 'POST' && pathname === '/razorpay-webhook') return await handleRazorpayWebhook(req, res);
    if (method === 'GET' && pathname === '/auth') return await handleAuth(req, res, parsedURL);
    if (method === 'GET' && pathname === '/auth/callback') return await handleAuthCallback(req, res, parsedURL);
    if (method === 'GET' && pathname === '/health') return respond(res, 200, { status: 'ok', ts: Date.now() });

    respond(res, 404, { error: 'Not found' });
  } catch (err) {
    log('error', 'Unhandled route error', { requestId, error: err.message });
    respond(res, 500, { error: 'Internal server error' });
  }
});

server.listen(parseInt(PORT, 10), '0.0.0.0', () => {
  console.log(`✅ Checkout server running on port ${PORT}`);
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
