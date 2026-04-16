'use strict';

const { httpRequest, retryAsync } = require('./utils');
const Logger = require('./logger');

class WhatsAppClient {
  constructor(config, logger) {
    this.token = config.meta.whatsapp_token;
    this.phoneNumberId = config.meta.phone_number_id;
    this.logger = logger;
  }

  async sendOTP(phone, otp) {
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
      path: `/v19.0/${this.phoneNumberId}/messages`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
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
          `WhatsApp API error: ${response.statusCode} - ${response.raw}`,
        );
      }

      return response.body;
    } catch (err) {
      this.logger.error('WhatsApp OTP send failed', {
        error: err.message,
        phone,
      });
      throw err;
    }
  }
}

module.exports = WhatsAppClient;
