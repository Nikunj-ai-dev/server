'use strict';

const crypto = require('crypto');
const { httpRequest, retryAsync } = require('./utils');
const Logger = require('./logger');

class RazorpayClient {
  constructor(config, logger) {
    this.keyId = config.razorpay.key_id;
    this.keySecret = config.razorpay.key_secret;
    this.webhookSecret = config.razorpay.webhook_secret;
    this.logger = logger;
  }

  async createOrder(amountInPaise, currency, receipt, notes) {
    const payload = {
      amount: amountInPaise,
      currency,
      receipt,
      notes,
    };

    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString(
      'base64',
    );
    const options = {
      hostname: 'api.razorpay.com',
      path: '/v1/orders',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
      },
    };

    try {
      const response = await retryAsync(
        async () => {
          return httpRequest(options, payload);
        },
        { maxAttempts: 3, delayMs: 1000 },
      );

      if (response.statusCode !== 200) {
        throw new Error(
          `Razorpay create order failed: ${response.statusCode}`,
        );
      }

      return response.body;
    } catch (err) {
      this.logger.error('Razorpay order creation failed', {
        error: err.message,
        amount: amountInPaise,
      });
      throw err;
    }
  }

  verifySignature(orderId, paymentId, signature) {
    try {
      const message = `${orderId}|${paymentId}`;
      const expectedSignature = crypto
        .createHmac('sha256', this.keySecret)
        .update(message)
        .digest('hex');

      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(signature),
      );
    } catch (err) {
      this.logger.warn('Signature verification failed', {
        error: err.message,
      });
      return false;
    }
  }

  verifyWebhookSignature(rawBody, signature) {
    try {
      const expectedSignature = crypto
        .createHmac('sha256', this.webhookSecret)
        .update(rawBody)
        .digest('hex');

      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(signature),
      );
    } catch (err) {
      this.logger.warn('Webhook signature verification failed', {
        error: err.message,
      });
      return false;
    }
  }

  async fetchPayment(paymentId) {
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString(
      'base64',
    );
    const options = {
      hostname: 'api.razorpay.com',
      path: `/v1/payments/${paymentId}`,
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
      },
    };

    try {
      const response = await retryAsync(
        async () => {
          return httpRequest(options, null);
        },
        { maxAttempts: 2, delayMs: 500 },
      );

      if (response.statusCode !== 200) {
        throw new Error(
          `Razorpay fetch payment failed: ${response.statusCode}`,
        );
      }

      return response.body;
    } catch (err) {
      this.logger.error('Razorpay payment fetch failed', {
        error: err.message,
        paymentId,
      });
      throw err;
    }
  }
}

module.exports = RazorpayClient;
