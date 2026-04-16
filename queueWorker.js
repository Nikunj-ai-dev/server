'use strict';

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Queue worker
async function processQueue() {
  while (true) {
    try {
      // Get pending jobs
      const { data: jobs, error } = await supabase
        .from('job_queue')
        .select('*')
        .eq('status', 'pending')
        .lte('scheduled_at', new Date().toISOString())
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(10);

      if (error) throw error;

      for (const job of jobs) {
        await processJob(job);
      }
    } catch (err) {
      console.error('Queue processing error:', err);
    }

    // Poll every 5 seconds
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

async function processJob(job) {
  try {
    // Mark as processing
    await supabase
      .from('job_queue')
      .update({ status: 'processing', started_at: new Date().toISOString() })
      .eq('id', job.id);

    switch (job.job_type) {
      case 'send_otp':
        await handleSendOTPJob(job.payload);
        break;
      case 'shopify_sync':
        await handleShopifySyncJob(job.payload);
        break;
      case 'process_webhook':
        await handleWebhookJob(job.payload);
        break;
      case 'payment_retry':
        await handlePaymentRetryJob(job.payload);
        break;
      default:
        throw new Error(`Unknown job type: ${job.job_type}`);
    }

    // Mark as completed
    await supabase
      .from('job_queue')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', job.id);

  } catch (err) {
    console.error(`Job ${job.id} failed:`, err);

    const attempts = job.attempts + 1;
    if (attempts >= job.max_attempts) {
      await supabase
        .from('job_queue')
        .update({ status: 'failed', error_message: err.message, completed_at: new Date().toISOString() })
        .eq('id', job.id);
    } else {
      // Retry with exponential backoff
      const delay = Math.pow(2, attempts) * 60000; // minutes
      await supabase
        .from('job_queue')
        .update({
          status: 'pending',
          attempts,
          scheduled_at: new Date(Date.now() + delay).toISOString(),
          error_message: err.message
        })
        .eq('id', job.id);
    }
  }
}

// Job handlers
async function handleSendOTPJob({ phone, otp }) {
  // WhatsApp sending logic
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

  const https = require('https');
  const options = {
    hostname: 'graph.facebook.com',
    path: `/v19.0/${process.env.META_PHONE_NUMBER_ID}/messages`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.META_WHATSAPP_TOKEN}`,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve();
        else reject(new Error(`WhatsApp API error: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(payload));
    req.end();
  });
}

async function handleShopifySyncJob({ orderId, cartData, address, phone, email, isCOD }) {
  // Shopify customer and order creation logic
  // Similar to createFullOrder but async
  // Implement Shopify sync here
  console.log('Syncing to Shopify for order:', orderId);
  // ... (add Shopify API calls)
}

async function handleWebhookJob({ event, eventId }) {
  // Process webhook
  if (event.event === 'payment.captured') {
    const payment = event.payload.payment.entity;
    await supabase
      .from('payments')
      .update({
        payment_status: 'paid',
        payment_timestamp: new Date().toISOString(),
        gateway_response: payment,
        updated_at: new Date().toISOString(),
      })
      .eq('provider_payment_id', payment.id);

    const { data: paymentRecord } = await supabase
      .from('payments')
      .select('order_id')
      .eq('provider_payment_id', payment.id)
      .single();

    if (paymentRecord) {
      await supabase
        .from('orders')
        .update({
          payment_status: 'paid',
          order_status: 'confirmed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', paymentRecord.order_id);
    }
  }
  // Handle other events...
}

async function handlePaymentRetryJob({ paymentId }) {
  // Retry payment logic
  console.log('Retrying payment:', paymentId);
}

// Start worker
processQueue().catch(console.error);

function parseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sanitizeText(value, maxLen = 255) {
  if (typeof value !== 'string') return '';
  return value.replace(/[<>"'`]/g, '').trim().slice(0, maxLen);
}

function buildShopifyVariantId(rawId) {
  if (!rawId || typeof rawId !== 'string') return rawId;
  const match = rawId.match(/[^/]+$/);
  return match ? match[0] : rawId;
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
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.write(payload);
    }
    req.end();
  });
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

async function createShopifyCustomer(data) {
  const existing = await shopifyCustomerSearch(data.phone);
  if (existing && existing.length > 0) {
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

async function shopifyCustomerSearch(phone) {
  const result = await shopifyAdminRequest(`customers/search.json?query=phone:+91${phone}`, 'GET');
  return result.body?.customers || [];
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

async function createShopifyDraftOrder(payload) {
  const res = await shopifyAdminRequest('draft_orders.json', 'POST', payload);
  return res.body;
}

async function completeDraftOrder(draftOrderId, paymentPending) {
  const endpoint = `draft_orders/${draftOrderId}/complete.json?payment_pending=${paymentPending}`;
  const res = await shopifyAdminRequest(endpoint, 'PUT', {});
  return res.body;
}

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
      ],
    },
  };

  const options = {
    hostname: 'graph.facebook.com',
    path: `/v19.0/${META_PHONE_NUMBER_ID}/messages`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${META_WHATSAPP_TOKEN}`,
    },
  };
  const result = await httpRequest(options, payload);
  if (result.statusCode !== 200) {
    throw new Error(`WhatsApp API error: ${result.raw}`);
  }
  return result.body;
}

async function processSendOtpJob(job) {
  const { challenge_id: challengeId, phone, otp } = job.payload || {};
  if (!challengeId || !phone || !otp) {
    throw new Error('Invalid send_otp payload');
  }

  const { data, error } = await supabase
    .from('customer_otp_challenges')
    .select('*')
    .eq('id', challengeId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    log('warn', 'OTP challenge missing for send_otp job', { jobId: job.id, challengeId });
    return;
  }

  await sendWhatsAppOTP(phone, otp);
  await supabase
    .from('customer_otp_challenges')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', challengeId);
  await recordAuditLog({ actorType: 'system', action: 'otp_dispatched', entityType: 'customer_otp_challenges', entityId: challengeId, metadata: { phone } });
}

async function getOrderPayloadPrice(cartData) {
  return parseFloat(cartData.cost.subtotalAmount.amount || '0');
}

async function createOrUpdateCustomer(phone, email, fullName) {
  const normalizedPhone = phone.replace(/\D/g, '').slice(-10);
  const emailCandidate = email || `guest_${normalizedPhone}@checkout.placeholder`;
  const { data: existing } = await supabase
    .from('customers')
    .select('id,refund_count,chargeback_count,risk_score')
    .or(`phone.eq.${normalizedPhone},email.eq.${emailCandidate}`)
    .limit(1)
    .maybeSingle();

  if (existing) {
    const updatePayload = { phone: normalizedPhone, updated_at: new Date().toISOString() };
    await supabase.from('customers').update(updatePayload).eq('id', existing.id);
    return existing.id;
  }

  const nameParts = (fullName || 'Guest Customer').split(' ');
  const { data, error } = await supabase
    .from('customers')
    .insert([
      {
        first_name: sanitizeText(nameParts[0] || 'Guest'),
        last_name: sanitizeText(nameParts.slice(1).join(' ') || 'Customer'),
        full_name: sanitizeText(fullName || 'Guest Customer'),
        email: emailCandidate,
        phone: normalizedPhone,
        phone_verified: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ])
    .select('id')
    .single();

  if (error) {
    throw error;
  }
  return data.id;
}

async function createAddress(customerId, address) {
  if (!customerId) return null;
  return supabase.from('customer_addresses').insert([
    {
      customer_id: customerId,
      full_name: sanitizeText(address.full_name),
      phone_number: address.phone,
      address_line1: sanitizeText(address.address_line1),
      city: sanitizeText(address.city),
      state: sanitizeText(address.state),
      postal_code: sanitizeText(address.postal_code || '000000'),
      country: 'India',
      is_default: true,
      verified: true,
      created_at: new Date().toISOString(),
    },
  ]);
}

async function createOrderRecord(payload, customerId, addressSnapshot, subtotal, discountAmount, grandTotal, isCOD) {
  const now = new Date().toISOString();
  const { data, error } = await supabase.from('orders').insert([
    {
      customer_id: customerId,
      order_status: 'pending',
      payment_status: isCOD ? 'pending' : 'pending',
      fulfillment_status: 'unfulfilled',
      source_channel: 'website',
      currency: 'INR',
      subtotal,
      discount_total: discountAmount || 0,
      shipping_total: 0,
      grand_total: grandTotal,
      name_snapshot: sanitizeText(addressSnapshot.full_name),
      email_snapshot: sanitizeText(payload.email || `guest_${payload.phone}@checkout.placeholder`),
      phone_snapshot: payload.phone,
      shipping_address_snapshot: addressSnapshot,
      billing_address_snapshot: addressSnapshot,
      order_notes: payload.coupon_code ? `Coupon:${payload.coupon_code}` : null,
      custom_fields: { idempotency_key: payload.idempotency_key, checkout_session_id: payload.checkout_session_id },
      purchase_date: now,
      created_at: now,
      updated_at: now,
    },
  ]).select('id').single();
  if (error) {
    throw error;
  }
  return data.id;
}

async function createOrderItems(orderId, lines) {
  const items = lines.map(({ node }) => ({
    order_id: orderId,
    product_id_snapshot: node.merchandise.product?.id,
    product_name_snapshot: node.merchandise.product?.title || 'Product',
    variant_id_snapshot: node.merchandise.id,
    variant_name_snapshot: node.merchandise.title,
    sku_snapshot: node.merchandise.sku,
    quantity: node.quantity,
    unit_price: parseFloat(node.cost.amountPerQuantity.amount || '0'),
    line_total: parseFloat(node.cost.totalAmount.amount || '0'),
    discount_amount: 0,
    fulfillment_status: 'unfulfilled',
    created_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from('order_items').insert(items);
  if (error) {
    throw error;
  }
}

async function updatePaymentForOrder(orderId, customerId, payload) {
  if (payload.payment_method === 'cod') {
    await supabase.from('payments').insert([
      {
        order_id: orderId,
        customer_id: customerId,
        payment_provider: 'cod',
        payment_method: 'cod',
        payment_status: 'pending',
        paid_amount: payload.grand_total,
        currency: 'INR',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    return;
  }

  const { data: existingPayment, error: existingError } = await supabase
    .from('payments')
    .select('*')
    .eq('provider_order_id', payload.razorpay_data?.razorpay_order_id)
    .limit(1)
    .maybeSingle();

  if (existingError) {
    throw existingError;
  }

  if (existingPayment) {
    await supabase.from('payments').update({
      customer_id: customerId,
      order_id: orderId,
      provider_payment_id: payload.razorpay_data?.razorpay_payment_id || existingPayment.provider_payment_id,
      payment_status: 'pending',
      verification_status: existingPayment.verification_status || 'unverified',
      updated_at: new Date().toISOString(),
    }).eq('id', existingPayment.id);
    return;
  }

  await supabase.from('payments').insert([
    {
      order_id: orderId,
      customer_id: customerId,
      payment_provider: 'razorpay',
      payment_method: 'razorpay',
      provider_order_id: payload.razorpay_data?.razorpay_order_id,
      provider_payment_id: payload.razorpay_data?.razorpay_payment_id || null,
      payment_status: 'pending',
      verification_status: 'unverified',
      paid_amount: payload.grand_total,
      currency: 'INR',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ]);
}

async function createShopifyOrderForPayload(orderId, cartData, customerId, addressSnapshot, email, phone, couponCode, discountAmount, isCOD) {
  const shopifyCustomer = await createShopifyCustomer({
    first_name: addressSnapshot.full_name.split(' ')[0],
    last_name: addressSnapshot.full_name.split(' ').slice(1).join(' '),
    email,
    phone,
  });

  const shopifyCustomerId = shopifyCustomer?.id;
  const shopifyLineItems = cartData.lines.edges.map(({ node }) => ({
    variant_id: buildShopifyVariantId(node.merchandise.id),
    quantity: node.quantity,
  }));

  const draftPayload = {
    draft_order: {
      line_items: shopifyLineItems,
      customer: shopifyCustomerId ? { id: shopifyCustomerId } : undefined,
      shipping_address: {
        first_name: sanitizeText(addressSnapshot.full_name.split(' ')[0]),
        last_name: sanitizeText(addressSnapshot.full_name.split(' ').slice(1).join(' ') || '.'),
        address1: sanitizeText(addressSnapshot.address_line1),
        city: sanitizeText(addressSnapshot.city),
        province: sanitizeText(addressSnapshot.state),
        country: 'IN',
        phone: `+91${phone}`,
      },
      email,
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
  if (!draftResult || !draftResult.draft_order) {
    throw new Error('Shopify draft order creation failed');
  }

  const completed = await completeDraftOrder(draftResult.draft_order.id, isCOD);
  const shopifyOrderNumber = completed?.order?.name || completed?.order?.order_number || null;

  if (shopifyOrderNumber) {
    await supabase.from('orders').update({ custom_fields: { shopify_order_number: shopifyOrderNumber }, updated_at: new Date().toISOString() }).eq('id', orderId);
  }

  return shopifyOrderNumber;
}

async function confirmInventory(reservationKey) {
  const now = new Date().toISOString();
  await supabase
    .from('inventory_reservations')
    .update({ status: 'confirmed', updated_at: now })
    .eq('reserved_for', reservationKey)
    .eq('status', 'active');
}

async function releaseInventory(reservationKey) {
  const now = new Date().toISOString();
  await supabase
    .from('inventory_reservations')
    .update({ status: 'released', updated_at: now })
    .eq('reserved_for', reservationKey)
    .eq('status', 'active');
}

async function isOrderAlreadyProcessed(idempotencyKey) {
  const existing = await fetchIdempotencyKey(idempotencyKey);
  return existing && existing.status === 'completed';
}

async function getRiskScore(customerId, phone, amount, isCOD) {
  let score = 10;
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const paymentAttempts = await supabase
    .from('payment_attempts')
    .select('id', { count: 'exact' })
    .eq('success', false)
    .gte('attempt_timestamp', thirtyDaysAgo);
  score += Math.min(30, (paymentAttempts.count || 0) * 8);

  const otpAbuse = await supabase
    .from('customer_otp_challenges')
    .select('id', { count: 'exact' })
    .eq('target_normalized', phone)
    .eq('purpose', 'guest_checkout')
    .gte('created_at', thirtyDaysAgo)
    .gte('attempts', 5);
  if (otpAbuse.count > 0) score += 20;

  if (amount >= 3000) score += 15;
  if (isCOD) score += 15;

  if (customerId) {
    const { data: customer } = await supabase.from('customers').select('refund_count,chargeback_count,risk_score').eq('id', customerId).limit(1).maybeSingle();
    if (customer) {
      score += Math.min(20, (customer.refund_count || 0) * 10);
      if ((customer.chargeback_count || 0) > 0) score += 30;
    }

    const codOrders = await supabase
      .from('payments')
      .select('id', { count: 'exact' })
      .eq('payment_provider', 'cod')
      .eq('customer_id', customerId)
      .gte('created_at', todayStart.toISOString());
    if (codOrders.count >= 3) score += 40;
  }

  await supabase.from('customers').update({ risk_score: Math.min(100, score), updated_at: now.toISOString() }).eq('id', customerId);
  return Math.min(100, score);
}

async function processCreateOrderJob(job) {
  const payload = job.payload || {};
  const idempotencyKey = String(payload.idempotency_key || payload.razorpay_data?.razorpay_order_id || `${payload.checkout_session_id || payload.cart_token}:${payload.phone}`);

  if (await isOrderAlreadyProcessed(idempotencyKey)) {
    log('info', 'Skipping already processed create_order job', { jobId: job.id, idempotencyKey });
    return;
  }

  const cartData = await fetchCartFromShopify(payload.cart_token);
  if (!cartData) {
    throw new Error('Cannot fetch Shopify cart for order creation');
  }

  const subtotal = parseFloat(cartData.cost.subtotalAmount.amount || '0');
  const discountAmount = payload.discount_amount ? parseFloat(payload.discount_amount) : 0;
  const grandTotal = subtotal - discountAmount;
  const isCOD = payload.payment_method === 'cod';

  const customerId = await createOrUpdateCustomer(payload.phone, payload.email, payload.address.full_name);
  const addressSnapshot = {
    full_name: sanitizeText(payload.address.full_name),
    address_line1: sanitizeText(payload.address.address_line1),
    city: sanitizeText(payload.address.city),
    state: sanitizeText(payload.address.state),
    postal_code: sanitizeText(payload.address.postal_code || ''),
    country: 'India',
    phone: payload.phone,
  };

  await createAddress(customerId, addressSnapshot);
  const orderId = await createOrderRecord(payload, customerId, addressSnapshot, subtotal, discountAmount, grandTotal, isCOD);
  await createOrderItems(orderId, cartData.lines.edges);
  await updatePaymentForOrder(orderId, customerId, { ...payload, grand_total: grandTotal });

  const shopifyOrderNumber = await createShopifyOrderForPayload(orderId, cartData, customerId, addressSnapshot, payload.email, payload.phone, payload.coupon_code, discountAmount, isCOD);

  await completeIdempotencyKey(idempotencyKey, { orderId, shopifyOrderNumber }, 'completed');
  await recordAuditLog({ actorType: 'system', action: 'order_created', entityType: 'orders', entityId: orderId, metadata: { idempotencyKey, shopifyOrderNumber } });
  await confirmInventory(idempotencyKey);
}

async function processWebhookJob(job) {
  const event = job.payload?.event;
  const eventId = job.payload?.event_id;
  if (!event || !eventId) {
    throw new Error('Invalid webhook payload');
  }

  if (event.event === 'payment.captured') {
    const payment = event.payload.payment.entity;
    const { data: paymentRecord, error: paymentError } = await supabase
      .from('payments')
      .select('*')
      .eq('provider_payment_id', payment.id)
      .limit(1)
      .maybeSingle();
    if (paymentError) throw paymentError;

    if (paymentRecord) {
      await supabase.from('payments').update({
        payment_status: 'paid',
        verification_status: 'verified',
        payment_timestamp: new Date().toISOString(),
        gateway_response: payment,
        updated_at: new Date().toISOString(),
      }).eq('id', paymentRecord.id);

      if (paymentRecord.order_id) {
        await supabase.from('orders').update({ payment_status: 'paid', order_status: 'confirmed', updated_at: new Date().toISOString() }).eq('id', paymentRecord.order_id);
      }

      await confirmInventory(paymentRecord.provider_order_id || paymentRecord.provider_payment_id || eventId);
    }
  }

  if (event.event === 'payment.failed') {
    const payment = event.payload.payment.entity;
    const { data: paymentRecord, error: paymentError } = await supabase
      .from('payments')
      .select('*')
      .eq('provider_payment_id', payment.id)
      .limit(1)
      .maybeSingle();
    if (paymentError) throw paymentError;

    if (paymentRecord) {
      await supabase.from('payments').update({
        payment_status: 'failed',
        failure_reason: payment.error_description,
        verification_status: 'unverified',
        gateway_response: payment,
        updated_at: new Date().toISOString(),
      }).eq('id', paymentRecord.id);

      if (paymentRecord.order_id) {
        await supabase.from('orders').update({ payment_status: 'failed', order_status: 'pending', updated_at: new Date().toISOString() }).eq('id', paymentRecord.order_id);
      }

      await supabase.from('payment_attempts').insert([
        {
          payment_id: paymentRecord.id,
          checkout_id: paymentRecord.order_id,
          ip_address: null,
          attempt_timestamp: new Date().toISOString(),
          success: false,
          error_logs: { reason: payment.error_description },
        },
      ]);

      await releaseInventory(paymentRecord.provider_order_id || paymentRecord.provider_payment_id || eventId);
      await enqueueJob('retry_payment', { provider_payment_id: payment.id, provider_order_id: paymentRecord?.provider_order_id }, { delayMs: 2 * 60 * 1000, maxAttempts: 4 });
    }
  }

  if (event.event === 'payment.captured' || event.event === 'payment.failed') {
    await supabase.from('webhook_logs').insert([
      {
        provider: 'razorpay',
        event_type: event.event,
        event_id: eventId,
        payload: event,
        processed_at: new Date().toISOString(),
      },
    ]);
  }

  await completeIdempotencyKey(`webhook:${eventId}`, { processed: true }, 'completed');
}

async function processRetryPaymentJob(job) {
  const { provider_payment_id } = job.payload || {};
  if (!provider_payment_id) {
    throw new Error('Missing provider_payment_id on retry_payment');
  }

  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
  const options = {
    hostname: 'api.razorpay.com',
    path: `/v1/payments/${provider_payment_id}`,
    method: 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
    },
  };

  const result = await httpRequest(options, null);
  const payment = result.body;
  if (!payment) {
    throw new Error('Failed to query Razorpay payment during retry');
  }

  if (payment.status === 'captured') {
    await enqueueJob('process_webhook', { event: { event: 'payment.captured', payload: { payment: { entity: payment } } }, event_id: `retry:${provider_payment_id}` }, { maxAttempts: 2 });
  } else if (payment.status === 'failed') {
    throw new Error('Payment remains failed on retry');
  } else {
    await failJob(job.id, 'Payment still pending; retry later', 5 * 60 * 1000);
  }
}

async function processJob(job) {
  if (!job) return;
  log('info', 'Processing queue job', { jobId: job.id, jobType: job.job_type });
  if (job.job_type === 'send_otp') {
    await processSendOtpJob(job);
  } else if (job.job_type === 'create_order') {
    await processCreateOrderJob(job);
  } else if (job.job_type === 'process_webhook') {
    await processWebhookJob(job);
  } else if (job.job_type === 'retry_payment') {
    await processRetryPaymentJob(job);
  } else {
    throw new Error(`Unsupported job type: ${job.job_type}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWorkerLoop() {
  log('info', 'Queue worker started');
  while (true) {
    try {
      const job = await claimNextJob();
      if (!job) {
        await sleep(1000);
        continue;
      }
      try {
        await processJob(job);
        await completeJob(job.id);
        log('info', 'Job completed', { jobId: job.id, jobType: job.job_type });
      } catch (jobError) {
        const message = jobError?.message || 'Unknown job failure';
        const delayMs = 60 * 1000;
        await failJob(job.id, message, delayMs);
        log('error', 'Job failed', { jobId: job.id, error: message });
      }
    } catch (loopError) {
      log('error', 'Queue worker loop error', { error: loopError.message });
      await sleep(2000);
    }
  }
}

runWorkerLoop().catch((error) => {
  console.error('Queue worker fatal error:', error);
  process.exit(1);
});
