'use strict';

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

const OPTIONAL_ENV = [
  'NODE_ENV',
  'LOG_LEVEL',
];

// Validate all required env vars
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`FATAL: Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

module.exports = {
  // Shopify
  shopify: {
    shop_domain: process.env.SHOPIFY_SHOP_DOMAIN,
    storefront_token: process.env.SHOPIFY_STOREFRONT_TOKEN,
    admin_token: process.env.SHOPIFY_ADMIN_TOKEN,
    api_key: process.env.SHOPIFY_API_KEY,
    api_secret: process.env.SHOPIFY_API_SECRET,
  },

  // Razorpay
  razorpay: {
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
    webhook_secret: process.env.RAZORPAY_WEBHOOK_SECRET,
  },

  // WhatsApp / Meta
  meta: {
    whatsapp_token: process.env.META_WHATSAPP_TOKEN,
    phone_number_id: process.env.META_PHONE_NUMBER_ID,
  },

  // Supabase
  supabase: {
    url: process.env.SUPABASE_URL,
    service_key: process.env.SUPABASE_SERVICE_KEY,
  },

  // Application
  app: {
    url: process.env.APP_URL,
    port: parseInt(process.env.PORT, 10) || 3000,
    env: process.env.NODE_ENV || 'production',
    log_level: process.env.LOG_LEVEL || 'info',
  },

  // Limits
  limits: {
    rate_limit_window_ms: 60 * 1000, // 1 minute
    rate_limit_max_requests: 100,
    otp_max_attempts: 5,
    otp_validity_ms: 10 * 60 * 1000, // 10 minutes
    cod_max_per_day: 3,
    cod_max_amount: 3000,
    request_timeout_ms: 30 * 1000,
    body_size_limit: 1024 * 1024, // 1MB
  },

  // Feature flags
  features: {
    enable_fraud_detection: true,
    enable_payment_verification: true,
  },
};
