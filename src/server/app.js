'use strict';

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const config = require('../config');
const Logger = require('../lib/logger');
const SupabaseClient = require('../lib/supabase');
const ShopifyClient = require('../lib/shopify');
const RazorpayClient = require('../lib/razorpay');
const WhatsAppClient = require('../lib/whatsapp');
const {
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
  retryAsync,
  getTimestamps,
  respondJSON,
  respondHTML,
  respondError,
} = require('../lib/utils');

const logger = new Logger(config.app.log_level);
const supabase = new SupabaseClient(config, logger);
const shopify = new ShopifyClient(config, logger);
const razorpay = new RazorpayClient(config, logger);
const whatsapp = new WhatsAppClient(config, logger);

// ─── RATE LIMITING (Per-request validation) ────────────────────────────────
async function checkRateLimit(supabase, key, maxRequests, windowMs) {
  try {
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowMs);

    const { data, error } = await supabase.select('rate_limits', {
      select: 'id, count, reset_at',
      key: `eq.${key}`,
      reset_at: `gt.${windowStart.toISOString()}`,
    });

    if (error) {
      logger.warn('Rate limit check failed', { error: error.message, key });
      return { allowed: true }; // Fail open on error
    }

    if (!data || data.length === 0) {
      // Create new rate limit entry
      await supabase.insert('rate_limits', {
        key,
        count: 1,
        reset_at: new Date(now.getTime() + windowMs).toISOString(),
      });
      return { allowed: true };
    }

    const entry = data[0];
    if (entry.count >= maxRequests) {
      return { allowed: false };
    }

    // Increment count
    await supabase.update(
      'rate_limits',
      { count: entry.count + 1 },
      { id: `eq.${entry.id}` },
    );

    return { allowed: true };
  } catch (err) {
    logger.warn('Rate limit error', { error: err.message });
    return { allowed: true }; // Fail open
  }
}

// ─── FRAUD DETECTION ───────────────────────────────────────────────────────
async function calculateRiskScore(supabase, customerId, phone, amount, isCOD) {
  if (!config.features.enable_fraud_detection) return 0;

  let score = 0;

  try {
    // Check COD orders per phone per day
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { data: codOrders } = await supabase.select('orders', {
      select: 'id',
      phone_snapshot: `eq.${phone}`,
      is_cod: 'eq.true',
      created_at: `gte.${today.toISOString()}`,
    });

    if (codOrders && codOrders.length >= config.limits.cod_max_per_day) {
      score += 40;
    }

    // Check high COD amounts
    if (isCOD && amount > config.limits.cod_max_amount) {
      score += 30;
    }

    // Check customer history
    if (customerId) {
      const { data: customer } = await supabase.select('customers', {
        select: 'risk_score,refund_count,chargeback_count',
        id: `eq.${customerId}`,
      });

      if (customer && customer.length > 0) {
        const cust = customer[0];
        if (cust.refund_count) score += Math.min(20, cust.refund_count * 5);
        if (cust.chargeback_count) score += 30;
      }
    }

    // Check failed payments
    const { data: failedPayments } = await supabase.select('payments', {
      select: 'id',
      payment_status: 'eq.failed',
      created_at: `gte.${new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()}`,
    });

    if (failedPayments) {
      score += Math.min(20, failedPayments.length * 3);
    }
  } catch (err) {
    logger.warn('Risk score calculation failed', { error: err.message });
  }

  return Math.min(score, 100);
}

// ─── ROUTE HANDLERS ───────────────────────────────────────────────────────

async function handleGetCheckout(req, res) {
  try {
    const htmlPath = path.join(__dirname, '../../checkout.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    respondHTML(res, html);
  } catch (err) {
    logger.error('Checkout page load failed', { error: err.message });
    respondError(res, 500, 'Failed to load checkout page', '');
  }
}

async function handleGetCartData(req, res, query) {
  const requestId = generateRequestId();

  try {
    const cartToken = query.cart_token;
    if (!cartToken || typeof cartToken !== 'string' || cartToken.length < 10) {
      return respondError(res, 400, 'Invalid cart_token', requestId);
    }

    const ip = getClientIP(req);
    const rateLimit = await checkRateLimit(
      supabase,
      `cart:${ip}`,
      20,
      config.limits.rate_limit_window_ms,
    );
    if (!rateLimit.allowed) {
      return respondError(res, 429, 'Too many requests', requestId);
    }

    const cart = await shopify.fetchCart(sanitizeText(cartToken, 100));
    if (!cart) {
      return respondError(res, 404, 'Cart not found or expired', requestId);
    }

    // Create checkout session
    const { data: sessionData } = await supabase.insert(
      'checkout_sessions',
      {
        status: 'started',
        created_at: getTimestamps().iso,
        updated_at: getTimestamps().iso,
      },
    );

    const sessionId = sessionData?.[0]?.id || null;

    return respondJSON(res, 200, {
      cart,
      checkout_session_id: sessionId,
    });
  } catch (err) {
    logger.error('Cart fetch failed', { requestId, error: err.message });
    return respondError(res, 500, 'Failed to fetch cart', requestId);
  }
}

async function handleSendOTP(req, res) {
  const requestId = generateRequestId();

  try {
    const ip = getClientIP(req);
    const rateLimit = await checkRateLimit(
      supabase,
      `otp:${ip}`,
      10,
      config.limits.rate_limit_window_ms,
    );
    if (!rateLimit.allowed) {
      return respondError(res, 429, 'Too many requests', requestId);
    }

    const body = await readBody(req, config.limits.body_size_limit);
    const data = parseJSON(body);

    if (!data || !data.phone) {
      return respondError(res, 400, 'Phone number required', requestId);
    }

    const phone = cleanPhone(data.phone);
    if (!validatePhone(phone)) {
      return respondError(res, 400, 'Invalid phone number', requestId);
    }

    // Rate limit per phone
    const phoneRateLimit = await checkRateLimit(
      supabase,
      `otp:phone:${phone}`,
      config.limits.rate_limit_max_requests,
      config.limits.rate_limit_window_ms,
    );
    if (!phoneRateLimit.allowed) {
      return respondError(res, 429, 'Too many OTP requests', requestId);
    }

    const otp = generateOTP();
    const salt = require('crypto').randomBytes(16).toString('hex');
    const otpHash = hashOTP(otp, salt) + ':' + salt;
    const expiresAt = new Date(
      Date.now() + config.limits.otp_validity_ms,
    ).toISOString();

    // Mark previous OTPs as consumed
    await supabase.update(
      'temp_otp',
      { consumed: true },
      {
        identifier: `eq.${phone}`,
        identifier_type: 'eq.phone',
        purpose: 'eq.checkout',
        consumed: 'eq.false',
      },
    );

    // Store new OTP
    await supabase.insert('temp_otp', {
      identifier: phone,
      identifier_type: 'phone',
      otp_hash: otpHash,
      purpose: 'checkout',
      expires_at: expiresAt,
      ip_address: ip,
      user_agent: req.headers['user-agent'] || '',
    });

    // Queue OTP sending
    await supabase.insert('job_queue', {
      job_type: 'send_otp',
      payload: { phone, otp },
      status: 'pending',
      priority: 2,
      created_at: getTimestamps().iso,
      scheduled_at: getTimestamps().iso,
      max_attempts: 3,
      attempts: 0,
    });

    logger.info('OTP queued', { requestId, phone });
    return respondJSON(res, 200, { success: true, message: 'OTP sent via WhatsApp' });
  } catch (err) {
    logger.error('OTP send failed', { requestId, error: err.message });
    return respondError(res, 500, 'Failed to send OTP', requestId);
  }
}

async function handleVerifyOTP(req, res) {
  const requestId = generateRequestId();

  try {
    const body = await readBody(req, config.limits.body_size_limit);
    const data = parseJSON(body);

    if (!data || !data.phone || !data.otp) {
      return respondError(res, 400, 'Phone and OTP required', requestId);
    }

    const phone = cleanPhone(data.phone);
    const otp = String(data.otp || '').replace(/\D/g, '').slice(0, 6);

    if (!validatePhone(phone)) {
      return respondError(res, 400, 'Invalid phone number', requestId);
    }

    if (otp.length !== 6) {
      return respondError(res, 400, 'Invalid OTP format', requestId);
    }

    const now = getTimestamps().iso;
    const { data: otpRecord } = await supabase.select('temp_otp', {
      select: 'id,otp_hash,attempts,max_attempts,expires_at,consumed',
      identifier: `eq.${phone}`,
      identifier_type: 'eq.phone',
      purpose: 'eq.checkout',
      consumed: 'eq.false',
      expires_at: `gt.${now}`,
      order: 'created_at.desc',
      limit: '1',
    });

    if (!otpRecord || otpRecord.length === 0) {
      return respondError(res, 401, 'OTP expired or not found', requestId);
    }

    const record = otpRecord[0];

    if (record.attempts >= record.max_attempts) {
      return respondError(res, 401, 'Max OTP attempts exceeded', requestId);
    }

    // Increment attempts
    await supabase.update(
      'temp_otp',
      {
        attempts: record.attempts + 1,
        updated_at: now,
      },
      { id: `eq.${record.id}` },
    );

    // Verify hash
    const [storedHash, salt] = record.otp_hash.split(':');
    const inputHash = hashOTP(otp, salt);

    if (
      !require('crypto').timingSafeEqual(
        Buffer.from(inputHash),
        Buffer.from(storedHash),
      )
    ) {
      return respondError(res, 401, 'Invalid OTP', requestId);
    }

    // Mark consumed
    await supabase.update(
      'temp_otp',
      { consumed: true },
      { id: `eq.${record.id}` },
    );

    // Generate session token
    const sessionToken = require('crypto').randomBytes(32).toString('hex');
    const tokenExpiry = new Date(
      Date.now() + 30 * 60 * 1000,
    ).toISOString();

    await supabase.insert('temp_otp', {
      identifier: phone,
      identifier_type: 'phone',
      otp_hash: require('crypto')
        .createHash('sha256')
        .update(sessionToken)
        .digest('hex'),
      purpose: 'checkout_session',
      expires_at: tokenExpiry,
      ip_address: getClientIP(req),
    });

    logger.info('OTP verified', { requestId, phone });
    return respondJSON(res, 200, {
      verified: true,
      session_token: sessionToken,
      expires_at: tokenExpiry,
    });
  } catch (err) {
    logger.error('OTP verification failed', { requestId, error: err.message });
    return respondError(res, 500, 'OTP verification failed', requestId);
  }
}

async function handleApplyCoupon(req, res) {
  const requestId = generateRequestId();

  try {
    const body = await readBody(req, config.limits.body_size_limit);
    const data = parseJSON(body);

    if (!data || !data.coupon_code || !data.subtotal) {
      return respondError(
        res,
        400,
        'coupon_code and subtotal required',
        requestId,
      );
    }

    const couponCode = sanitizeText(data.coupon_code, 50).toUpperCase();
    const subtotal = parseFloat(data.subtotal);

    if (isNaN(subtotal) || subtotal <= 0) {
      return respondError(res, 400, 'Invalid subtotal', requestId);
    }

    const now = getTimestamps().iso;
    const { data: coupons } = await supabase.select('coupons', {
      select: '*',
      code: `eq.${couponCode}`,
      is_active: 'eq.true',
      valid_from: `lte.${now}`,
      valid_until: `gte.${now}`,
    });

    if (!coupons || coupons.length === 0) {
      return respondJSON(res, 200, { valid: false, error: 'Invalid or expired coupon' });
    }

    const coupon = coupons[0];

    if (subtotal < (coupon.min_cart_value || 0)) {
      return respondJSON(res, 200, {
        valid: false,
        error: `Minimum cart value ₹${coupon.min_cart_value} required`,
      });
    }

    if (
      coupon.usage_limit_total &&
      coupon.current_usage_count >= coupon.usage_limit_total
    ) {
      return respondJSON(res, 200, {
        valid: false,
        error: 'Coupon usage limit reached',
      });
    }

    let discountAmount = 0;
    if (coupon.coupon_type === 'percentage') {
      discountAmount = (subtotal * coupon.discount_value) / 100;
      if (coupon.max_discount_amount) {
        discountAmount = Math.min(discountAmount, coupon.max_discount_amount);
      }
    } else if (coupon.coupon_type === 'fixed') {
      discountAmount = Math.min(coupon.discount_value, subtotal);
    }

    discountAmount = parseFloat(discountAmount.toFixed(2));
    const finalTotal = parseFloat((subtotal - discountAmount).toFixed(2));

    logger.info('Coupon applied', { requestId, coupon_code: couponCode });
    return respondJSON(res, 200, {
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
    logger.error('Coupon validation failed', { requestId, error: err.message });
    return respondError(res, 500, 'Coupon validation failed', requestId);
  }
}

async function handleCreateRazorpayOrder(req, res) {
  const requestId = generateRequestId();

  try {
    const body = await readBody(req, config.limits.body_size_limit);
    const data = parseJSON(body);

    if (!data || !data.amount || !data.phone || !data.session_token) {
      return respondError(
        res,
        400,
        'amount, phone, and session_token required',
        requestId,
      );
    }

    const phone = cleanPhone(data.phone);
    if (!validatePhone(phone)) {
      return respondError(res, 400, 'Invalid phone number', requestId);
    }

    const amount = Math.round(parseFloat(data.amount) * 100);
    if (amount < 100) {
      return respondError(res, 400, 'Minimum amount ₹1', requestId);
    }

    // Verify session token
    const sessionToken = sanitizeText(data.session_token, 64);
    const tokenHash = require('crypto')
      .createHash('sha256')
      .update(sessionToken)
      .digest('hex');
    const now = getTimestamps().iso;

    const { data: sessionData } = await supabase.select('temp_otp', {
      select: 'id',
      identifier: `eq.${phone}`,
      otp_hash: `eq.${tokenHash}`,
      purpose: 'eq.checkout_session',
      consumed: 'eq.false',
      expires_at: `gt.${now}`,
    });

    if (!sessionData || sessionData.length === 0) {
      return respondError(res, 401, 'Phone not verified. Please re-verify.', requestId);
    }

    const receipt = `rcpt_${Date.now()}_${require('crypto').randomBytes(4).toString('hex')}`;

    try {
      const rzOrder = await razorpay.createOrder(
        amount,
        'INR',
        receipt,
        { phone },
      );

      if (!rzOrder || !rzOrder.id) {
        return respondError(
          res,
          500,
          'Razorpay order creation failed',
          requestId,
        );
      }

      logger.info('Razorpay order created', { requestId, order_id: rzOrder.id });
      return respondJSON(res, 200, {
        razorpay_order_id: rzOrder.id,
        amount: rzOrder.amount,
        currency: rzOrder.currency,
        key_id: config.razorpay.key_id,
      });
    } catch (err) {
      logger.error('Razorpay error', { requestId, error: err.message });
      return respondError(res, 500, 'Payment gateway error', requestId);
    }
  } catch (err) {
    logger.error('Create Razorpay order failed', { requestId, error: err.message });
    return respondError(res, 500, 'Internal server error', requestId);
  }
}

async function handleVerifyPayment(req, res) {
  const requestId = generateRequestId();

  try {
    const body = await readBody(req, config.limits.body_size_limit);
    const data = parseJSON(body);

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = data || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return respondError(res, 400, 'Payment verification data required', requestId);
    }

    const isValid = razorpay.verifySignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    );

    if (!isValid) {
      logger.warn('Payment signature invalid', { requestId, razorpay_order_id });
      await supabase.insert('audit_logs', {
        actor_type: 'system',
        action: 'payment_signature_invalid',
        entity_type: 'payment',
        new_value: { razorpay_order_id, razorpay_payment_id },
        created_at: getTimestamps().iso,
      });
      return respondError(res, 400, 'Payment signature verification failed', requestId);
    }

    // Check if already processed (idempotency)
    const { data: existing } = await supabase.select('payments', {
      select: 'id',
      provider_order_id: `eq.${razorpay_order_id}`,
      payment_status: 'eq.paid',
    });

    if (existing && existing.length > 0) {
      logger.info('Duplicate payment detected', { requestId, razorpay_order_id });
      return respondJSON(res, 200, { verified: true, duplicate: true });
    }

    return respondJSON(res, 200, { verified: true, duplicate: false });
  } catch (err) {
    logger.error('Payment verification failed', { requestId, error: err.message });
    return respondError(res, 500, 'Payment verification failed', requestId);
  }
}

async function handleCreateOrder(req, res) {
  const requestId = generateRequestId();
  const ip = getClientIP(req);

  try {
    // Rate limit order creation
    const rateLimit = await checkRateLimit(
      supabase,
      `order:${ip}`,
      5,
      config.limits.rate_limit_window_ms,
    );
    if (!rateLimit.allowed) {
      return respondError(res, 429, 'Too many order attempts', requestId);
    }

    const body = await readBody(req, config.limits.body_size_limit);
    const data = parseJSON(body);

    if (!data) {
      return respondError(res, 400, 'Invalid request body', requestId);
    }

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
    } = data;

    // Validation
    if (!cart_token || !address || !phone || !payment_method) {
      return respondError(
        res,
        400,
        'cart_token, address, phone, payment_method required',
        requestId,
      );
    }

    const cleanedPhone = cleanPhone(phone);
    if (!validatePhone(cleanedPhone)) {
      return respondError(res, 400, 'Invalid phone number', requestId);
    }

    if (!validateAddress(address)) {
      return respondError(res, 400, 'Incomplete address', requestId);
    }

    if (email && !validateEmail(email)) {
      return respondError(res, 400, 'Invalid email address', requestId);
    }

    // Verify session
    const sessionTokenClean = sanitizeText(session_token || '', 64);
    if (!sessionTokenClean) {
      return respondError(res, 401, 'Phone verification required', requestId);
    }

    const tokenHash = require('crypto')
      .createHash('sha256')
      .update(sessionTokenClean)
      .digest('hex');
    const now = getTimestamps().iso;

    const { data: sessionCheck } = await supabase.select('temp_otp', {
      select: 'id',
      identifier: `eq.${cleanedPhone}`,
      otp_hash: `eq.${tokenHash}`,
      purpose: 'eq.checkout_session',
      consumed: 'eq.false',
      expires_at: `gt.${now}`,
    });

    if (!sessionCheck || sessionCheck.length === 0) {
      return respondError(res, 401, 'Session expired. Please re-verify phone.', requestId);
    }

    // Verify payment if not COD
    if (payment_method !== 'cod') {
      if (!razorpay_data) {
        return respondError(res, 400, 'Payment data required', requestId);
      }

      const sigValid = razorpay.verifySignature(
        razorpay_data.razorpay_order_id,
        razorpay_data.razorpay_payment_id,
        razorpay_data.razorpay_signature,
      );

      if (!sigValid) {
        logger.error('Invalid payment signature', { requestId });
        return respondError(res, 400, 'Invalid payment signature', requestId);
      }

      // Check if already processed
      const { data: existingPayment } = await supabase.select('payments', {
        select: 'id',
        provider_order_id: `eq.${razorpay_data.razorpay_order_id}`,
        payment_status: 'eq.paid',
      });

      if (existingPayment && existingPayment.length > 0) {
        logger.info('Duplicate payment', { requestId });
        return respondError(res, 409, 'Order already processed for this payment', requestId);
      }
    }

    // Fetch cart
    let cartData;
    try {
      cartData = await shopify.fetchCart(sanitizeText(cart_token, 100));
      if (!cartData) {
        return respondError(res, 404, 'Cart not found or expired', requestId);
      }
    } catch (err) {
      logger.error('Cart fetch failed', { requestId, error: err.message });
      return respondError(res, 500, 'Could not retrieve cart', requestId);
    }

    const isCOD = payment_method === 'cod';
    const subtotal = parseFloat(cartData.cost.subtotalAmount.amount || 0);
    const discountAmt = discount_amount ? parseFloat(discount_amount) : 0;
    const grandTotal = subtotal - discountAmt;

    // Fraud check
    const riskScore = await calculateRiskScore(
      supabase,
      null,
      cleanedPhone,
      grandTotal,
      isCOD,
    );

    if (riskScore > 50) {
      logger.warn('High risk transaction blocked', {
        requestId,
        risk_score: riskScore,
      });
      return respondError(res, 403, 'Transaction declined due to fraud detection', requestId);
    }

    // Check COD eligibility
    if (isCOD && grandTotal > config.limits.cod_max_amount) {
      logger.warn('COD amount too high', { requestId, amount: grandTotal });
      return respondError(
        res,
        403,
        `COD not available for orders over ₹${config.limits.cod_max_amount}`,
        requestId,
      );
    }

    // Queue order creation as a job
    await supabase.insert('job_queue', {
      job_type: 'create_order',
      payload: {
        cart_token,
        address,
        phone: cleanedPhone,
        email,
        coupon_code,
        discount_amount: discountAmt,
        payment_method,
        razorpay_data,
        checkout_session_id,
        risk_score: riskScore,
      },
      status: 'pending',
      priority: 1,
      created_at: getTimestamps().iso,
      scheduled_at: getTimestamps().iso,
      max_attempts: 3,
      attempts: 0,
    });

    logger.info('Order creation queued', {
      requestId,
      phone: cleanedPhone,
      amount: grandTotal,
    });

    return respondJSON(res, 202, {
      success: true,
      message: 'Order processing started',
      amount: grandTotal,
    });
  } catch (err) {
    logger.error('Create order failed', { requestId, error: err.message });
    return respondError(res, 500, 'Order creation failed. Please contact support.', requestId);
  }
}

async function handleRazorpayWebhook(req, res) {
  const requestId = generateRequestId();

  try {
    const raw = await readBody(req, config.limits.body_size_limit);
    const signature = req.headers['x-razorpay-signature'];

    if (!signature) {
      logger.warn('Webhook missing signature', { requestId });
      return respondError(res, 400, 'Missing signature', requestId);
    }

    if (!razorpay.verifyWebhookSignature(raw, signature)) {
      logger.warn('Webhook invalid signature', { requestId });
      return respondError(res, 400, 'Invalid webhook signature', requestId);
    }

    const event = parseJSON(raw);
    if (!event) {
      logger.warn('Webhook invalid payload', { requestId });
      return respondError(res, 400, 'Invalid payload', requestId);
    }

    // Create idempotency key for webhook
    const eventId = event.event + ':' + (event.payload?.payment?.entity?.id || 'unknown');

    // Check if already processed
    const { data: processed } = await supabase.select('webhook_logs', {
      select: 'id',
      provider: 'eq.razorpay',
      event_id: `eq.${eventId}`,
    });

    if (processed && processed.length > 0) {
      logger.info('Webhook already processed', { requestId, eventId });
      return respondJSON(res, 200, { received: true });
    }

    // Store webhook
    await supabase.insert('webhook_logs', {
      provider: 'razorpay',
      event_type: event.event,
      event_id: eventId,
      payload: event,
      processed_at: getTimestamps().iso,
    });

    // Queue for processing
    await supabase.insert('job_queue', {
      job_type: 'process_webhook',
      payload: { event, eventId },
      status: 'pending',
      priority: 2,
      created_at: getTimestamps().iso,
      scheduled_at: getTimestamps().iso,
      max_attempts: 3,
      attempts: 0,
    });

    logger.info('Webhook queued', { requestId, eventId });
    return respondJSON(res, 200, { received: true });
  } catch (err) {
    logger.error('Webhook processing failed', { requestId, error: err.message });
    // Return 200 to prevent Razorpay from retrying
    return respondJSON(res, 200, { received: true });
  }
}

async function handleHealth(req, res) {
  return respondJSON(res, 200, {
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
}

// ─── CORS HEADERS ──────────────────────────────────────────────────────────
function getCORSHeaders() {
  const allowedOrigin =
    config.app.env === 'production' ? config.app.url : '*';

  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
  };
}

// ─── SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, getCORSHeaders());
      res.end();
      return;
    }

    // Apply CORS to all responses
    Object.entries(getCORSHeaders()).forEach(([key, value]) => {
      res.setHeader(key, value);
    });

    const parsedURL = url.parse(req.url, true);
    const pathname = parsedURL.pathname;
    const method = req.method;
    const requestId = generateRequestId();

    logger.info('Request', {
      requestId,
      method,
      pathname,
      ip: getClientIP(req),
    });

    // Routes
    if (method === 'GET' && pathname === '/checkout') {
      return handleGetCheckout(req, res);
    }
    if (method === 'GET' && pathname === '/cart-data') {
      return handleGetCartData(req, res, parsedURL.query);
    }
    if (method === 'POST' && pathname === '/send-otp') {
      return handleSendOTP(req, res);
    }
    if (method === 'POST' && pathname === '/verify-otp') {
      return handleVerifyOTP(req, res);
    }
    if (method === 'POST' && pathname === '/apply-coupon') {
      return handleApplyCoupon(req, res);
    }
    if (method === 'POST' && pathname === '/create-razorpay-order') {
      return handleCreateRazorpayOrder(req, res);
    }
    if (method === 'POST' && pathname === '/verify-payment') {
      return handleVerifyPayment(req, res);
    }
    if (method === 'POST' && pathname === '/create-order') {
      return handleCreateOrder(req, res);
    }
    if (method === 'POST' && pathname === '/razorpay-webhook') {
      return handleRazorpayWebhook(req, res);
    }
    if (method === 'GET' && pathname === '/health') {
      return handleHealth(req, res);
    }

    return respondError(res, 404, 'Not found', requestId);
  } catch (err) {
    logger.error('Unhandled error', { error: err.message, stack: err.stack });
    const requestId = generateRequestId();
    return respondError(res, 500, 'Internal server error', requestId);
  }
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;

  isShuttingDown = true;
  logger.info(`${signal} received, shutting down gracefully`);

  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });

  // Force shutdown after 30 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { error: String(reason) });
});

// ─── START SERVER ─────────────────────────────────────────────────────────
server.listen(config.app.port, '0.0.0.0', () => {
  logger.info('Checkout server started', { port: config.app.port, env: config.app.env });
});

module.exports = server;
