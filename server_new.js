'use strict';

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { supabase, generateRequestId, hashValue, sanitizeText, log, recordAuditLog, incrementRateLimit, getProductCache, setProductCache, fetchIdempotencyKey, reserveIdempotencyKey, completeIdempotencyKey, enqueueJob } = require('./jobQueue');

const REQUIRED_ENV = [
  'SHOPIFY_SHOP_DOMAIN',
  'SHOPIFY_STOREFRONT_TOKEN',
  'SHOPIFY_ADMIN_TOKEN',
  'SHOPIFY_API_SECRET',
  'SHOPIFY_API_KEY',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'META_WHATSAPP_TOKEN',
  'META_PHONE_NUMBER_ID',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'APP_URL',
  'PORT',
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`FATAL: Missing env variable: ${key}`);
    process.exit(1);
  }
}

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
  APP_URL,
  PORT = '3000',
} = process.env;

function parseJSON(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
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

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '0.0.0.0';
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePhone(phone) {
  return /^[6-9]\d{9}$/.test(phone.replace(/\D/g, ''));
}

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
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
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function buildShopifyState(shop) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const timestamp = Date.now();
  const payload = `${shop}:${timestamp}:${nonce}`;
  const signature = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${signature}`).toString('base64url');
}

function verifyShopifyState(state) {
  try {
    const decoded = Buffer.from(state, 'base64url').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 4) return null;
    const [shop, timestamp, nonce, signature] = parts;
    const ageMs = Date.now() - Number(timestamp);
    if (Number.isNaN(ageMs) || ageMs > 10 * 60 * 1000) return null;
    const expected = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(`${shop}:${timestamp}:${nonce}`).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
    return shop;
  } catch {
    return null;
  }
}

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
  return result.body?.data?.cart || null;
}

async function fetchProductPrice(variantId) {
  const cacheKey = `variant_price:${variantId}`;
  const cached = await getProductCache(cacheKey);
  if (cached) return cached;

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
  const price = result.body?.data?.productVariant || null;
  if (price) {
    await setProductCache(cacheKey, price, 5 * 60);
  }
  return price;
}

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
  const existing = await searchShopifyCustomer(data.phone);
  if (existing.length > 0) {
    return existing[0];
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
  return res.body?.customer || null;
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

function hashOTP(otp, salt) {
  return crypto.createHmac('sha256', salt).update(otp).digest('hex');
}

async function createCustomerOtpChallenge(phone, ip, userAgent) {
  const otp = String(100000 + crypto.randomInt(900000));
  const salt = crypto.randomBytes(16).toString('hex');
  const otpHash = `${hashOTP(otp, salt)}:${salt}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();

  const { data, error } = await supabase.from('customer_otp_challenges').insert([{
    customer_id: null,
    purpose: 'guest_checkout',
    channel: 'whatsapp',
    target: phone,
    target_normalized: phone,
    otp_hash: otpHash,
    requested_ip: ip,
    requested_user_agent: userAgent,
    metadata: {},
    attempts: 0,
    max_attempts: 5,
    expires_at: expiresAt,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }]).select('id').single();

  if (error) throw error;
  return { challengeId: data.id, otp };
}

async function verifyCustomerOtpChallenge(phone, otp) {
  const now = new Date().toISOString();
  const { data: record, error } = await supabase.from('customer_otp_challenges').select('*').eq('target_normalized', phone).eq('purpose', 'guest_checkout').eq('channel', 'whatsapp').eq('consumed_at', null).gt('expires_at', now).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!record) return { valid: false, reason: 'OTP expired or not found.' };
  if (record.attempts >= record.max_attempts) return { valid: false, reason: 'Max OTP attempts exceeded.' };

  const [storedHash, salt] = String(record.otp_hash).split(':');
  const inputHash = hashOTP(otp, salt);
  const nextAttempts = record.attempts + 1;
  await supabase.from('customer_otp_challenges').update({ attempts: nextAttempts, updated_at: new Date().toISOString() }).eq('id', record.id);

  if (!crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(storedHash))) return { valid: false, reason: 'Invalid OTP.' };

  await supabase.from('customer_otp_challenges').update({ consumed_at: new Date().toISOString(), verified_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', record.id);
  return { valid: true, challengeId: record.id };
}

async function getOrCreateGuestCustomer(phone, email, fullName) {
  const normalizedPhone = phone.replace(/\D/g, '').slice(-10);
  const guestEmail = email || `guest_${normalizedPhone}@checkout.placeholder`;
  const { data: existing, error: queryError } = await supabase.from('customers').select('id').or(`phone.eq.${normalizedPhone},email.eq.${guestEmail}`).limit(1).maybeSingle();
  if (queryError) throw queryError;
  if (existing && existing.id) return existing.id;

  const nameParts = (fullName || 'Guest Customer').split(' ');
  const { data, error } = await supabase.from('customers').insert([{
    first_name: sanitizeText(nameParts[0] || 'Guest'),
    last_name: sanitizeText(nameParts.slice(1).join(' ') || 'Customer'),
    full_name: sanitizeText(fullName || 'Guest Customer'),
    email: guestEmail,
    phone: normalizedPhone,
    phone_verified: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }]).select('id').single();
  if (error) throw error;
  return data.id;
}

async function createCustomerSession(customerId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashValue(token);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  await supabase.from('customer_sessions').insert([{ customer_id: customerId, token_hash: tokenHash, auth_method: 'whatsapp_otp', created_at: now, last_seen_at: now, expires_at: expiresAt }]);
  return { token, expires_at: expiresAt };
}

async function validateCustomerSession(phone, token) {
  const tokenHash = hashValue(token);
  const now = new Date().toISOString();
  const { data: session } = await supabase.from('customer_sessions').select('customer_id').eq('token_hash', tokenHash).gt('expires_at', now).limit(1).maybeSingle();
  if (!session || !session.customer_id) return null;
  const { data: customer } = await supabase.from('customers').select('id,phone').eq('id', session.customer_id).limit(1).maybeSingle();
  if (!customer || customer.phone !== phone) return null;
  await supabase.from('customer_sessions').update({ last_seen_at: new Date().toISOString() }).eq('token_hash', tokenHash);
  return customer.id;
}

async function reserveInventory(lines, reservationKey) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  for (const { node } of lines) {
    const variantId = node.merchandise.id;
    const quantity = Number(node.quantity || 0);
    if (quantity <= 0) throw new Error('Invalid item quantity');
    if (!node.merchandise.availableForSale) throw new Error('A cart item is no longer available.');
    const available = Number(node.merchandise.quantityAvailable || 0);
    const { data: reservations } = await supabase.from('inventory_reservations').select('quantity').eq('variant_id', variantId).eq('status', 'active').gte('expires_at', now);
    const reservedTotal = Array.isArray(reservations) ? reservations.reduce((sum, row) => sum + Number(row.quantity || 0), 0) : 0;
    if (reservedTotal + quantity > available) throw new Error('Not enough inventory available for one or more items.');
    const { error } = await supabase.from('inventory_reservations').insert([{ variant_id: variantId, quantity, reserved_for: reservationKey, status: 'active', expires_at: expiresAt, created_at: now }]);
    if (error) throw error;
  }
}

async function releaseInventory(reservationKey) {
  const now = new Date().toISOString();
  await supabase.from('inventory_reservations').update({ status: 'released', updated_at: now }).eq('reserved_for', reservationKey).eq('status', 'active');
}

async function calculateRiskScore(customerId, phone, amount, paymentMethod) {
  let score = 10;
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const { count: failedAttempts = 0 } = await supabase.from('payment_attempts').select('id', { count: 'exact' }).eq('success', false).gte('attempt_timestamp', thirtyDaysAgo).maybeSingle();
  score += Math.min(30, failedAttempts * 8);
  const { count: otpAbuseCount = 0 } = await supabase.from('customer_otp_challenges').select('id', { count: 'exact' }).eq('target_normalized', phone).eq('purpose', 'guest_checkout').gte('created_at', thirtyDaysAgo).gte('attempts', 5).maybeSingle();
  if (otpAbuseCount > 0) score += 20;
  if (amount >= 3000) score += 15;
  if (paymentMethod === 'cod') score += 15;
  if (customerId) {
    const { data: customer } = await supabase.from('customers').select('refund_count,chargeback_count').eq('id', customerId).limit(1).maybeSingle();
    if (customer) {
      score += Math.min(20, (customer.refund_count || 0) * 10);
      if ((customer.chargeback_count || 0) > 0) score += 30;
    }
    const { count: todaysCod = 0 } = await supabase.from('payments').select('id', { count: 'exact' }).eq('payment_provider', 'cod').eq('customer_id', customerId).gte('created_at', todayStart.toISOString()).maybeSingle();
    if (todaysCod >= 3) score += 40;
  }
  score = Math.min(100, Math.max(0, score));
  if (customerId) await supabase.from('customers').update({ risk_score: score, updated_at: now.toISOString() }).eq('id', customerId);
  return score;
}

async function isCodAllowed(customerId, phone, amount) {
  if (amount > 3000) return false;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  if (customerId) {
    const { count = 0 } = await supabase.from('payments').select('id', { count: 'exact' }).eq('payment_provider', 'cod').eq('customer_id', customerId).gte('created_at', todayStart.toISOString()).maybeSingle();
    if (count >= 3) return false;
  }
  const { count: phoneCount = 0 } = await supabase.from('orders').select('id', { count: 'exact' }).eq('phone_snapshot', phone).gte('created_at', todayStart.toISOString()).maybeSingle();
  if (phoneCount >= 3) return false;
  if (customerId) {
    const { data: customer } = await supabase.from('customers').select('refund_count,chargeback_count').eq('id', customerId).limit(1).maybeSingle();
    if (customer && ((customer.refund_count || 0) > 1 || (customer.chargeback_count || 0) > 0)) return false;
  }
  return true;
}

async function createRazorpayOrder(amountInPaise, currency, receipt, notes) {
  const payload = { amount: amountInPaise, currency, receipt, notes };
  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
  const options = { hostname: 'api.razorpay.com', path: '/v1/orders', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` } };
  return httpRequest(options, payload).then((result) => result.body);
}

function verifyRazorpaySignature(orderId, paymentId, signature) {
  const body = `${orderId}|${paymentId}`;
  const expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(body).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature)); } catch { return false; }
}

function verifyRazorpayWebhookSignature(rawBody, signature) {
  const expected = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature)); } catch { return false; }
}

function extractShopifyId(rawId) {
  if (!rawId || typeof rawId !== 'string') return rawId;
  const match = rawId.match(/[^/]+$/);
  return match ? match[0] : rawId;
}

async function buildCheckoutHTML() {
  const htmlPath = path.join(__dirname, 'checkout.html');
  if (fs.existsSync(htmlPath)) return fs.readFileSync(htmlPath, 'utf8');
  return '<h1>Checkout page not found</h1>';
}

async function handleAuth(req, res, parsedURL) {
  const shop = parsedURL.query.shop;
  if (!shop || !/^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/.test(shop)) {
    res.writeHead(400);
    res.end('Invalid shop');
    return;
  }
  const state = buildShopifyState(shop);
  const redirectUri = `${APP_URL}/auth/callback`;
  const scopes = ['read_orders', 'write_orders', 'read_customers', 'write_customers', 'read_products', 'read_inventory', 'write_inventory', 'read_fulfillments', 'write_fulfillments', 'read_discounts', 'read_draft_orders', 'write_draft_orders'].join(',');
  const authURL = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.writeHead(302, { Location: authURL });
  res.end();
}

async function handleAuthCallback(req, res, parsedURL) {
  const { code, hmac, state, shop } = parsedURL.query;
  if (!code || !hmac || !state || !shop) {
    res.writeHead(400);
    res.end('Missing parameters');
    return;
  }
  const verifiedShop = verifyShopifyState(state);
  if (!verifiedShop || verifiedShop !== shop) {
    res.writeHead(403);
    res.end('Invalid state');
    return;
  }
  const params = { ...parsedURL.query };
  delete params.hmac;
  const message = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('&');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(message).digest('hex');
  try { if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac))) { res.writeHead(403); res.end('HMAC validation failed'); return; } } catch { res.writeHead(403); res.end('HMAC validation failed'); return; }
  try {
    const tokenData = await httpRequest({ hostname: shop, path: '/admin/oauth/access_token', method: 'POST', headers: { 'Content-Type': 'application/json' } }, { client_id: SHOPIFY_API_KEY, client_secret: SHOPIFY_API_SECRET, code });
    if (!tokenData.body || !tokenData.body.access_token) { res.writeHead(500); res.end('Token exchange failed'); return; }
    await supabase.from('shopify_shops').upsert([{ shop, access_token: tokenData.body.access_token, installed_at: new Date().toISOString() }], { onConflict: ['shop'] });
    res.writeHead(302, { Location: `https://${shop}/admin` });
    res.end();
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.writeHead(500);
    res.end('OAuth error');
  }
}

async function handleGetCheckout(req, res, parsedURL) {
  const html = await buildCheckoutHTML();
  respondHTML(res, html);
}

async function handleGetCartData(req, res, parsedURL) {
  const cartToken = parsedURL.query.cart_token;
  if (!cartToken || typeof cartToken !== 'string' || cartToken.length < 10) return respond(res, 400, { error: 'Invalid cart_token' });
  try {
    const cart = await fetchCartFromShopify(sanitizeText(cartToken, 100));
    if (!cart) return respond(res, 404, { error: 'Cart not found or expired' });
    const now = new Date().toISOString();
    const sessionRes = await supabase.from('checkout_sessions').insert([{ status: 'started', device_info: req.headers['user-agent'] || '', browser_info: req.headers['user-agent'] || '', created_at: now, updated_at: now }]).select('id').single();
    const sessionId = sessionRes.data?.id || null;
    return respond(res, 200, { cart, checkout_session_id: sessionId });
  } catch (err) {
    log('error', 'Cart fetch failed', { error: err.message });
    return respond(res, 500, { error: 'Failed to fetch cart' });
  }
}

async function handleSendOTP(req, res) {
  const ip = getClientIP(req);
  const requestId = generateRequestId();
  const raw = await readBody(req);
  const body = parseJSON(raw);
  if (!body || !body.phone) return respond(res, 400, { error: 'Phone required' });
  const phone = String(body.phone).replace(/\D/g, '').slice(-10);
  if (!validatePhone(phone)) return respond(res, 400, { error: 'Invalid Indian phone number' });
  try {
    const phoneRate = await incrementRateLimit(`otp:phone:${phone}`, 'otp_phone', 15 * 60 * 1000, 5);
    if (!phoneRate.allowed) return respond(res, 429, { error: 'Too many OTP requests for this phone. Try again later.' });
    const ipRate = await incrementRateLimit(`otp:ip:${ip}`, 'otp_ip', 60 * 60 * 1000, 10);
    if (!ipRate.allowed) return respond(res, 429, { error: 'Too many requests from your IP. Try again later.' });
    const userAgent = req.headers['user-agent'] || '';
    const { challengeId, otp } = await createCustomerOtpChallenge(phone, ip, userAgent);
    await enqueueJob('send_otp', { challenge_id: challengeId, phone, otp }, { maxAttempts: 3 });
    await recordAuditLog({ actorType: 'user', action: 'otp_requested', entityType: 'customer_otp_challenges', entityId: challengeId, metadata: { phone, requestId, ip, userAgent } });
    log('info', 'OTP queued', { requestId, phone, challengeId });
    return respond(res, 200, { success: true, message: 'OTP is being sent via WhatsApp.' });
  } catch (err) {
    log('error', 'OTP enqueue failed', { requestId, phone, error: err.message });
    return respond(res, 500, { error: 'Failed to queue OTP delivery' });
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
  try {
    const result = await verifyCustomerOtpChallenge(phone, otp);
    if (!result.valid) return respond(res, 401, { error: result.reason });
    const customerId = await getOrCreateGuestCustomer(phone, null, 'Guest Checkout');
    const session = await createCustomerSession(customerId);
    return respond(res, 200, { verified: true, session_token: session.token, expires_at: session.expires_at });
  } catch (err) {
    log('error', 'OTP verification failed', { phone, error: err.message });
    return respond(res, 500, { error: 'OTP verification failed' });
  }
}

async function handleApplyCoupon(req, res) {
  const raw = await readBody(req);
  const body = parseJSON(raw);
  if (!body || !body.coupon_code || typeof body.subtotal !== 'number') return respond(res, 400, { error: 'coupon_code and subtotal required' });
  const couponCode = sanitizeText(body.coupon_code, 50).toUpperCase();
  const subtotal = parseFloat(body.subtotal);
  try {
    const now = new Date().toISOString();
    const { data: coupons, error } = await supabase.from('coupons').select('*').eq('code', couponCode).eq('is_active', true).lte('valid_from', now).gte('valid_until', now);
    if (error) throw error;
    if (!coupons || coupons.length === 0) return respond(res, 200, { valid: false, error: 'Invalid or expired coupon' });
    const coupon = coupons[0];
    if (subtotal < (coupon.min_cart_value || 0)) return respond(res, 200, { valid: false, error: `Minimum cart value ₹${coupon.min_cart_value} required` });
    if (coupon.usage_limit_total && coupon.current_usage_count >= coupon.usage_limit_total) return respond(res, 200, { valid: false, error: 'Coupon usage limit reached' });
    let discountAmount = 0;
    if (coupon.coupon_type === 'percentage') {
      discountAmount = (subtotal * coupon.discount_value) / 100;
      if (coupon.max_discount_amount) discountAmount = Math.min(discountAmount, coupon.max_discount_amount);
    } else if (coupon.coupon_type === 'fixed') {
      discountAmount = Math.min(coupon.discount_value, subtotal);
    }
    discountAmount = parseFloat(discountAmount.toFixed(2));
    const finalTotal = parseFloat((subtotal - discountAmount).toFixed(2));
    return respond(res, 200, { valid: true, coupon_code: couponCode, coupon_type: coupon.coupon_type, discount_value: coupon.discount_value, discount_amount: discountAmount, subtotal, final_total: finalTotal, delivery: 0, grand_total: finalTotal });
  } catch (err) {
    log('error', 'Coupon validation failed', { error: err.message });
    return respond(res, 500, { error: 'Coupon validation failed' });
  }
}

async function handleCreateRazorpayOrder(req, res) {
  const raw = await readBody(req);
  const body = parseJSON(raw);
  if (!body || !body.amount || !body.cart_token || !body.session_token || !body.phone) return respond(res, 400, { error: 'amount, cart_token, session_token, phone required' });
  const phone = String(body.phone).replace(/\D/g, '').slice(-10);
  const sessionToken = sanitizeText(body.session_token, 64);
  if (!validatePhone(phone)) return respond(res, 400, { error: 'Invalid phone number' });
  if (!sessionToken) return respond(res, 401, { error: 'Phone verification required' });
  const customerId = await validateCustomerSession(phone, sessionToken);
  if (!customerId) return respond(res, 401, { error: 'Session invalid or expired' });
  const amount = Math.round(parseFloat(body.amount) * 100);
  if (Number.isNaN(amount) || amount < 100) return respond(res, 400, { error: 'Minimum amount ₹1' });
  const receipt = `rcpt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  try {
    const rzOrder = await createRazorpayOrder(amount, 'INR', receipt, { cart_token: body.cart_token, phone });
    if (!rzOrder || !rzOrder.id) return respond(res, 500, { error: 'Razorpay order creation failed' });
    await supabase.from('payments').insert([{ customer_id: customerId, payment_provider: 'razorpay', provider_order_id: rzOrder.id, payment_method: 'razorpay', payment_status: 'pending', verification_status: 'unverified', paid_amount: parseFloat((amount / 100).toFixed(2)), currency: 'INR', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]);
    return respond(res, 200, { razorpay_order_id: rzOrder.id, amount: rzOrder.amount, currency: rzOrder.currency, key_id: RAZORPAY_KEY_ID });
  } catch (err) {
    log('error', 'Razorpay order creation failed', { error: err.message });
    return respond(res, 500, { error: 'Payment gateway error' });
  }
}

async function handleVerifyPayment(req, res) {
  const raw = await readBody(req);
  const body = parseJSON(raw);
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return respond(res, 400, { error: 'Payment verification data required' });
  const isValid = verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
  if (!isValid) { await recordAuditLog({ actorType: 'system', action: 'payment_signature_invalid', entityType: 'payments', metadata: { razorpay_order_id, razorpay_payment_id } }); return respond(res, 400, { error: 'Payment signature verification failed' }); }
  const { data: payment } = await supabase.from('payments').select('*').eq('provider_order_id', razorpay_order_id).limit(1).maybeSingle();
  if (!payment) return respond(res, 404, { error: 'Payment record not found' });
  if (payment.payment_status === 'paid' && payment.verification_status === 'verified') return respond(res, 200, { verified: true, duplicate: true });
  await supabase.from('payments').update({ provider_payment_id: razorpay_payment_id, verification_status: 'verified', updated_at: new Date().toISOString() }).eq('id', payment.id);
  await supabase.from('payment_attempts').insert([{ payment_id: payment.id, checkout_id: null, ip_address: getClientIP(req), attempt_timestamp: new Date().toISOString(), success: true, error_logs: {} }]);
  return respond(res, 200, { verified: true, duplicate: false });
}

async function handleCreateOrder(req, res) {
  const ip = getClientIP(req);
  const requestId = generateRequestId();
  const raw = await readBody(req);
  const body = parseJSON(raw);
  if (!body) return respond(res, 400, { error: 'Invalid request body' });
  const { cart_token, address, phone, email, coupon_code, discount_amount, payment_method, razorpay_data, session_token, checkout_session_id, idempotency_key } = body;
  const cleanPhone = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!cart_token || !address || !cleanPhone || !payment_method) return respond(res, 400, { error: 'cart_token, address, phone, payment_method required' });
  if (!validatePhone(cleanPhone)) return respond(res, 400, { error: 'Invalid phone' });
  if (!address.full_name || !address.address_line1 || !address.city || !address.state) return respond(res, 400, { error: 'Incomplete address' });
  if (email && !validateEmail(email)) return respond(res, 400, { error: 'Invalid email address' });
  try { const orderRate = await incrementRateLimit(`order:create:${ip}`, 'order_create', 60 * 1000, 5); if (!orderRate.allowed) return respond(res, 429, { error: 'Too many order attempts. Please try again later.' }); } catch (err) { log('error', 'Rate limit check failed', { requestId, error: err.message }); return respond(res, 500, { error: 'Server rate limit check failed' }); }
  const sessionTokenClean = sanitizeText(session_token || '', 64);
  if (!sessionTokenClean) return respond(res, 401, { error: 'Phone verification required' });
  const sessionCustomerId = await validateCustomerSession(cleanPhone, sessionTokenClean);
  if (!sessionCustomerId) return respond(res, 401, { error: 'Session invalid or expired' });
  let cartData;
  try { cartData = await fetchCartFromShopify(sanitizeText(cart_token, 100)); if (!cartData) return respond(res, 404, { error: 'Cart not found or expired' }); } catch (err) { log('error', 'Cart fetch failed', { requestId, error: err.message }); return respond(res, 500, { error: 'Could not retrieve cart' }); }
  const subtotal = parseFloat(cartData.cost.subtotalAmount.amount || '0');
  const grandTotal = subtotal - (discount_amount ? parseFloat(discount_amount) : 0);
  const orderKey = idempotency_key || razorpay_data?.razorpay_order_id || `${checkout_session_id || cart_token}:${cleanPhone}:${payment_method}`;
  const requestHash = hashValue(JSON.stringify({ cart_token, address, cleanPhone, email, coupon_code, discount_amount, payment_method, razorpay_data }));
  try {
    const existingKey = await fetchIdempotencyKey(orderKey);
    if (existingKey && existingKey.status === 'completed') return respond(res, 200, { success: true, duplicate: true, idempotency_key: orderKey });
    await reserveIdempotencyKey(orderKey, '/create-order', requestHash, 24 * 60 * 60);
    const score = await calculateRiskScore(sessionCustomerId, cleanPhone, grandTotal, payment_method);
    if (score > 70) return respond(res, 403, { error: 'Checkout blocked for review due to risk score.', risk_score: score });
    if (payment_method === 'cod') { const allowed = await isCodAllowed(sessionCustomerId, cleanPhone, grandTotal); if (!allowed) return respond(res, 403, { error: 'COD payment is not permitted for this account or amount.' }); }
    await reserveInventory(cartData.lines.edges, orderKey);
    const job = await enqueueJob('create_order', { idempotency_key: orderKey, checkout_session_id, cart_token, address: { full_name: sanitizeText(address.full_name), address_line1: sanitizeText(address.address_line1), city: sanitizeText(address.city), state: sanitizeText(address.state), postal_code: sanitizeText(address.postal_code || '') }, phone: cleanPhone, email: email ? sanitizeText(email, 200) : null, coupon_code: coupon_code ? sanitizeText(coupon_code, 50).toUpperCase() : null, discount_amount: discount_amount ? parseFloat(discount_amount) : 0, payment_method, razorpay_data: razorpay_data || null, reservation_key: orderKey, request_id: requestId, grand_total: grandTotal }, { maxAttempts: 6 });
    if (checkout_session_id) await supabase.from('checkout_sessions').update({ status: 'processing', updated_at: new Date().toISOString() }).eq('id', checkout_session_id);
    log('info', 'Order queued for processing', { requestId, jobId: job.id, idempotency_key: orderKey });
    return respond(res, 202, { success: true, queued: true, job_id: job.id, idempotency_key: orderKey, risk_score: score });
  } catch (err) {
    log('error', 'Order enqueue failed', { requestId, error: err.message, idempotency_key: orderKey });
    await releaseInventory(orderKey).catch(() => {});
    return respond(res, 500, { error: 'Order creation failed. Please try again later.' });
  }
}

async function handleRazorpayWebhook(req, res) {
  const raw = await readBody(req);
  const signature = req.headers['x-razorpay-signature'];
  const requestId = generateRequestId();
  if (!signature || !verifyRazorpayWebhookSignature(raw, signature)) return respond(res, 400, { error: 'Invalid webhook signature' });
  const event = parseJSON(raw);
  if (!event) return respond(res, 400, { error: 'Invalid payload' });
  const eventId = event.id || `${event.event}:${event.payload?.payment?.entity?.id || 'unknown'}`;
  try {
    const existingKey = await fetchIdempotencyKey(`webhook:${eventId}`);
    if (existingKey && existingKey.status === 'completed') return respond(res, 200, { received: true });
    await reserveIdempotencyKey(`webhook:${eventId}`, '/razorpay-webhook', hashValue(JSON.stringify(event)), 24 * 60 * 60);
    await enqueueJob('process_webhook', { event, event_id: eventId }, { maxAttempts: 5 });
    await recordAuditLog({ actorType: 'system', action: 'webhook_enqueued', entityType: 'webhook', entityId: eventId, metadata: { event: event.event, requestId } });
    return respond(res, 200, { received: true });
  } catch (err) {
    log('error', 'Webhook enqueue failed', { requestId, eventId, error: err.message });
    return respond(res, 500, { error: 'Webhook processing failed' });
  }
}

async function handleJobStatus(req, res, parsedURL) {
  const jobId = parsedURL.query.id;
  if (!jobId) return respond(res, 400, { error: 'job id required' });
  const { data, error } = await supabase.from('job_queue').select('id,job_type,status,attempts,max_attempts,next_run_at,last_error,created_at,updated_at').eq('id', jobId).limit(1).maybeSingle();
  if (error) return respond(res, 500, { error: 'Failed to fetch job status' });
  if (!data) return respond(res, 404, { error: 'Job not found' });
  return respond(res, 200, data);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.NODE_ENV === 'production' ? APP_URL : '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); res.end(); return; }
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  const parsedURL = url.parse(req.url, true);
  const pathname = parsedURL.pathname;
  const method = req.method;
  const requestId = generateRequestId();
  log('info', 'Request received', { requestId, method, pathname, ip: getClientIP(req), userAgent: req.headers['user-agent'] || 'unknown' });
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
    if (method === 'GET' && pathname === '/job-status') return await handleJobStatus(req, res, parsedURL);
    if (method === 'GET' && pathname === '/health') return respond(res, 200, { status: 'ok', ts: Date.now() });
    respond(res, 404, { error: 'Not found' });
  } catch (err) {
    log('error', 'Unhandled request error', { requestId, error: err.message });
    respond(res, 500, { error: 'Internal server error' });
  }
});

server.listen(parseInt(PORT, 10), '0.0.0.0', () => {
  console.log(`✅ Checkout server running on port ${PORT}`);
});

server.on('error', (err) => { console.error('Server error:', err); process.exit(1); });
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled rejection:', reason); });
