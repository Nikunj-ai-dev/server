'use strict';

const config = require('../config');
const Logger = require('../lib/logger');
const SupabaseClient = require('../lib/supabase');
const ShopifyClient = require('../lib/shopify');
const WhatsAppClient = require('../lib/whatsapp');
const RazorpayClient = require('../lib/razorpay');
const {
  sanitizeText,
  getTimestamps,
  generateRequestId,
} = require('../lib/utils');

const logger = new Logger(config.app.log_level);
const supabase = new SupabaseClient(config, logger);
const shopify = new ShopifyClient(config, logger);
const whatsapp = new WhatsAppClient(config, logger);
const razorpay = new RazorpayClient(config, logger);

// ─── JOB PROCESSORS ───────────────────────────────────────────────────────

async function processSendOTPJob(payload) {
  const { phone, otp } = payload;

  if (!phone || !otp) {
    throw new Error('Invalid send_otp payload: missing phone or otp');
  }

  await whatsapp.sendOTP(phone, otp);
  logger.info('OTP sent via WhatsApp', { phone });
}

async function processCreateOrderJob(payload) {
  const requestId = generateRequestId();
  const {
    cart_token,
    address,
    phone,
    email,
    coupon_code,
    discount_amount,
    payment_method,
    razorpay_data,
    checkout_session_id,
    risk_score,
  } = payload;

  try {
    // Fetch cart from Shopify
    const cartData = await shopify.fetchCart(sanitizeText(cart_token, 100));
    if (!cartData) {
      throw new Error('Cart not found or expired');
    }

    const subtotal = parseFloat(cartData.cost.subtotalAmount.amount || 0);
    const grandTotal = subtotal - (discount_amount || 0);
    const isCOD = payment_method === 'cod';

    // Create or update customer
    let customerId = null;
    const emailCandidate =
      email || `guest_${phone}@checkout.noemail`;

    const { data: existingCustomer } = await supabase.select('customers', {
      select: 'id',
      phone: `eq.${phone}`,
    });

    if (existingCustomer && existingCustomer.length > 0) {
      customerId = existingCustomer[0].id;
      await supabase.update(
        'customers',
        {
          phone_verified: true,
          risk_score: risk_score,
          updated_at: getTimestamps().iso,
        },
        { id: `eq.${customerId}` },
      );
    } else {
      const nameParts = address.full_name.split(' ');
      const { data: newCustomer } = await supabase.insert('customers', {
        first_name: sanitizeText(nameParts[0] || 'Guest'),
        last_name: sanitizeText(nameParts.slice(1).join(' ') || 'Customer'),
        email: emailCandidate,
        phone,
        phone_verified: true,
        cod_eligible: risk_score < 30,
        risk_score: risk_score,
        created_at: getTimestamps().iso,
        updated_at: getTimestamps().iso,
      });

      if (newCustomer && newCustomer[0]) {
        customerId = newCustomer[0].id;
      }
    }

    // Create address
    if (customerId) {
      await supabase.insert('customer_addresses', {
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

    // Create order
    const addressSnapshot = {
      full_name: sanitizeText(address.full_name),
      address_line1: sanitizeText(address.address_line1),
      city: sanitizeText(address.city),
      state: sanitizeText(address.state),
      postal_code: sanitizeText(address.postal_code || '000000'),
      country: 'India',
      phone,
    };

    const { data: orderData } = await supabase.insert('orders', {
      customer_id: customerId,
      order_status: 'pending',
      payment_status: isCOD ? 'pending' : 'paid',
      fulfillment_status: 'unfulfilled',
      source_channel: 'website',
      is_cod: isCOD,
      currency: 'INR',
      subtotal,
      discount_total: discount_amount || 0,
      shipping_total: 0,
      grand_total: grandTotal,
      name_snapshot: sanitizeText(address.full_name),
      email_snapshot: emailCandidate,
      phone_snapshot: phone,
      shipping_address_snapshot: addressSnapshot,
      billing_address_snapshot: addressSnapshot,
      is_guest: !customerId,
      guest_phone_verified: true,
      guest_phone_verified_at: getTimestamps().iso,
      created_at: getTimestamps().iso,
      updated_at: getTimestamps().iso,
    });

    const orderId = orderData?.[0]?.id;

    if (!orderId) {
      throw new Error('Order creation returned no ID');
    }

    // Create order items
    for (const item of cartData.lines.edges) {
      const node = item.node;
      await supabase.insert('order_items', {
        order_id: orderId,
        product_id_snapshot: node.merchandise.product?.id,
        product_name_snapshot: node.merchandise.product?.title || 'Product',
        variant_id_snapshot: node.merchandise.id,
        variant_name_snapshot: node.merchandise.title,
        sku_snapshot: node.merchandise.sku,
        quantity: node.quantity,
        unit_price: parseFloat(node.cost.amountPerQuantity.amount || 0),
        line_total: parseFloat(node.cost.totalAmount.amount || 0),
        discount_amount: 0,
        fulfillment_status: 'unfulfilled',
      });
    }

    // Create payment record
    if (!isCOD && razorpay_data) {
      await supabase.insert('payments', {
        order_id: orderId,
        customer_id: customerId,
        payment_provider: 'razorpay',
        provider_payment_id: razorpay_data.razorpay_payment_id,
        provider_order_id: razorpay_data.razorpay_order_id,
        payment_method: razorpay_data.method || 'razorpay',
        payment_status: 'paid',
        paid_amount: grandTotal,
        currency: 'INR',
        payment_timestamp: getTimestamps().iso,
        verification_status: 'verified',
        is_cod: false,
        fraud_risk_result: risk_score,
        gateway_response: razorpay_data,
        created_at: getTimestamps().iso,
        updated_at: getTimestamps().iso,
      });
    } else if (isCOD) {
      await supabase.insert('payments', {
        order_id: orderId,
        customer_id: customerId,
        payment_provider: 'cod',
        payment_method: 'cod',
        payment_status: 'pending',
        paid_amount: grandTotal,
        currency: 'INR',
        is_cod: true,
        cod_amount: grandTotal,
        fraud_risk_result: risk_score,
        created_at: getTimestamps().iso,
        updated_at: getTimestamps().iso,
      });
    }

    // Sync to Shopify (queue another job)
    await supabase.insert('job_queue', {
      job_type: 'shopify_sync',
      payload: {
        orderId,
        cartData,
        address,
        phone,
        email,
        isCOD,
      },
      status: 'pending',
      priority: 1,
      created_at: getTimestamps().iso,
      scheduled_at: getTimestamps().iso,
      max_attempts: 3,
      attempts: 0,
    });

    // Log analytics
    await supabase.insert('analytics_events', {
      event_name: 'order_created',
      metadata: {
        order_id: orderId,
        payment_method,
        grand_total: grandTotal,
        risk_score,
      },
      event_timestamp: getTimestamps().iso,
    });

    logger.info('Order created', { requestId, orderId, phone });
  } catch (err) {
    logger.error('Order creation job failed', {
      requestId,
      error: err.message,
      phone,
    });
    throw err;
  }
}

async function processShopifySyncJob(payload) {
  const { orderId, cartData, address, phone, email, isCOD } = payload;

  try {
    // Create Shopify customer
    const shopifyCustomer = await shopify.createCustomer({
      first_name: address.full_name.split(' ')[0],
      last_name: address.full_name.split(' ').slice(1).join(' '),
      email: email || `guest_${phone}@checkout.placeholder`,
      phone,
    });

    const shopifyCustomerId = shopifyCustomer?.customer?.id;

    // Create Shopify draft order
    const shopifyLineItems = cartData.lines.edges.map(({ node }) => ({
      variant_id: node.merchandise.id
        .replace('gid://shopify/ProductVariant/', '')
        .split('/')
        .pop(),
      quantity: node.quantity,
    }));

    const draftPayload = {
      draft_order: {
        line_items: shopifyLineItems,
        customer: shopifyCustomerId ? { id: shopifyCustomerId } : undefined,
        shipping_address: {
          first_name: sanitizeText(address.full_name.split(' ')[0]),
          last_name:
            sanitizeText(address.full_name.split(' ').slice(1).join(' ')) ||
            '.',
          address1: sanitizeText(address.address_line1),
          city: sanitizeText(address.city),
          province: sanitizeText(address.state),
          country: 'IN',
          phone: `+91${phone}`,
        },
        email: email || `guest_${phone}@checkout.placeholder`,
        use_customer_default_address: false,
        send_receipt: true,
        send_fulfillment_receipt: true,
        note: isCOD
          ? 'COD Order - Custom Checkout'
          : 'Paid via Razorpay - Custom Checkout',
        tags: isCOD ? 'cod,custom-checkout' : 'razorpay,custom-checkout',
      },
    };

    const draftResult = await shopify.createDraftOrder(draftPayload);

    if (draftResult && draftResult.draft_order) {
      const completed = await shopify.completeDraftOrder(
        draftResult.draft_order.id,
        isCOD,
      );
      const shopifyOrderNumber =
        completed?.order?.name || completed?.order?.order_number;

      if (orderId && shopifyOrderNumber) {
        await supabase.update(
          'orders',
          {
            custom_fields: { shopify_order_number: shopifyOrderNumber },
            updated_at: getTimestamps().iso,
          },
          { id: `eq.${orderId}` },
        );
      }

      logger.info('Shopify sync completed', { orderId, shopifyOrderNumber });
    }
  } catch (err) {
    logger.warn('Shopify sync failed (non-fatal)', {
      error: err.message,
      orderId,
    });
    // Don't throw - Shopify sync failure shouldn't fail the order
  }
}

async function processWebhookJob(payload) {
  const { event, eventId } = payload;

  try {
    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;

      await supabase.update(
        'payments',
        {
          payment_status: 'paid',
          payment_timestamp: getTimestamps().iso,
          gateway_response: payment,
          updated_at: getTimestamps().iso,
        },
        { provider_payment_id: `eq.${payment.id}` },
      );

      const { data: paymentRecord } = await supabase.select('payments', {
        select: 'order_id',
        provider_payment_id: `eq.${payment.id}`,
      });

      if (paymentRecord && paymentRecord.length > 0) {
        const orderId = paymentRecord[0].order_id;
        await supabase.update(
          'orders',
          {
            payment_status: 'paid',
            order_status: 'confirmed',
            updated_at: getTimestamps().iso,
          },
          { id: `eq.${orderId}` },
        );

        logger.info('Order confirmed via webhook', { orderId });
      }
    } else if (event.event === 'payment.failed') {
      const payment = event.payload.payment.entity;

      await supabase.update(
        'payments',
        {
          payment_status: 'failed',
          failure_reason: payment.error_description,
          gateway_response: payment,
          updated_at: getTimestamps().iso,
        },
        { provider_payment_id: `eq.${payment.id}` },
      );

      logger.warn('Payment failed via webhook', { payment_id: payment.id });
    }

    logger.info('Webhook processed', { eventId, event: event.event });
  } catch (err) {
    logger.error('Webhook processing failed', {
      error: err.message,
      eventId,
    });
    throw err;
  }
}

// ─── MAIN WORKER LOOP ──────────────────────────────────────────────────────

async function processNextJob() {
  try {
    // Claim next pending job
    const { data: jobs } = await supabase.select('job_queue', {
      select: '*',
      status: 'eq.pending',
      next_run_at: `lte.${getTimestamps().iso}`,
      order: 'priority.desc,created_at.asc',
      limit: '1',
    });

    if (!jobs || jobs.length === 0) {
      return;
    }

    const job = jobs[0];
    const requestId = generateRequestId();

    logger.info('Processing job', {
      requestId,
      jobId: job.id,
      jobType: job.job_type,
    });

    try {
      // Mark as processing
      await supabase.update(
        'job_queue',
        {
          status: 'processing',
          started_at: getTimestamps().iso,
        },
        { id: `eq.${job.id}` },
      );

      // Execute job
      switch (job.job_type) {
        case 'send_otp':
          await processSendOTPJob(job.payload);
          break;
        case 'create_order':
          await processCreateOrderJob(job.payload);
          break;
        case 'shopify_sync':
          await processShopifySyncJob(job.payload);
          break;
        case 'process_webhook':
          await processWebhookJob(job.payload);
          break;
        default:
          throw new Error(`Unknown job type: ${job.job_type}`);
      }

      // Mark as completed
      await supabase.update(
        'job_queue',
        {
          status: 'completed',
          completed_at: getTimestamps().iso,
        },
        { id: `eq.${job.id}` },
      );

      logger.info('Job completed', { requestId, jobId: job.id });
    } catch (jobErr) {
      const attempts = job.attempts + 1;
      const isLastAttempt = attempts >= job.max_attempts;

      logger.error('Job failed', {
        requestId,
        jobId: job.id,
        attempt: attempts,
        error: jobErr.message,
      });

      if (isLastAttempt) {
        // Final failure
        await supabase.update(
          'job_queue',
          {
            status: 'failed',
            error_message: jobErr.message,
            completed_at: getTimestamps().iso,
          },
          { id: `eq.${job.id}` },
        );

        logger.error('Job permanently failed', {
          jobId: job.id,
          jobType: job.job_type,
        });
      } else {
        // Retry with exponential backoff
        const delayMs = Math.pow(2, attempts) * 1000; // 2s, 4s, 8s
        const nextRunAt = new Date(Date.now() + delayMs).toISOString();

        await supabase.update(
          'job_queue',
          {
            status: 'pending',
            attempts,
            next_run_at: nextRunAt,
            error_message: jobErr.message,
          },
          { id: `eq.${job.id}` },
        );

        logger.info('Job queued for retry', {
          jobId: job.id,
          nextAttempt: attempts + 1,
          retryDelayMs: delayMs,
        });
      }
    }
  } catch (err) {
    logger.error('Worker loop error', { error: err.message });
  }
}

async function runWorker() {
  logger.info('Worker started', { env: config.app.env, logLevel: config.app.log_level });

  let isRunning = true;

  const processLoop = async () => {
    while (isRunning) {
      try {
        await processNextJob();
      } catch (err) {
        logger.error('Worker fatal error', { error: err.message });
      }

      // Poll every 2 seconds
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  };

  // Graceful shutdown
  const gracefulShutdown = (signal) => {
    logger.info(`${signal} received, shutting down`);
    isRunning = false;

    // Give time for current job to finish
    setTimeout(() => {
      logger.info('Worker shutdown complete');
      process.exit(0);
    }, 30000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { error: String(reason) });
  });

  await processLoop();
}

runWorker().catch((err) => {
  logger.error('Worker startup failed', { error: err.message });
  process.exit(1);
});
