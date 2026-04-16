'use strict';

const { httpRequest, retryAsync, sanitizeText } = require('./utils');
const Logger = require('./logger');

class ShopifyClient {
  constructor(config, logger) {
    this.shopDomain = config.shopify.shop_domain;
    this.storefrontToken = config.shopify.storefront_token;
    this.adminToken = config.shopify.admin_token;
    this.logger = logger;
  }

  async _graphqlRequest(query, variables, token) {
    const options = {
      hostname: this.shopDomain,
      path: '/api/2024-04/graphql.json',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': token,
      },
    };

    const response = await httpRequest(options, { query, variables });

    if (response.statusCode !== 200) {
      throw new Error(`Shopify GraphQL error: ${response.statusCode}`);
    }

    if (response.body?.errors) {
      const errorMsg = response.body.errors
        .map((e) => e.message)
        .join('; ');
      throw new Error(`Shopify GraphQL error: ${errorMsg}`);
    }

    return response.body?.data;
  }

  async _restRequest(endpoint, method = 'GET', body = null) {
    const options = {
      hostname: this.shopDomain,
      path: `/admin/api/2024-04/${endpoint}`,
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': this.adminToken,
      },
    };

    const response = await httpRequest(options, body);

    if (response.statusCode >= 400) {
      throw new Error(
        `Shopify REST error ${response.statusCode}: ${response.raw}`,
      );
    }

    return response.body;
  }

  async fetchCart(cartToken) {
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

    try {
      const data = await retryAsync(
        async () => {
          return this._graphqlRequest(
            query,
            { id: cartId },
            this.storefrontToken,
          );
        },
        { maxAttempts: 2, delayMs: 500 },
      );

      return data?.cart || null;
    } catch (err) {
      this.logger.error('Failed to fetch cart', { error: err.message });
      throw err;
    }
  }

  async searchCustomer(phone) {
    try {
      const result = await retryAsync(
        async () => {
          return this._restRequest(
            `customers/search.json?query=phone:+91${phone}`,
          );
        },
        { maxAttempts: 2, delayMs: 500 },
      );

      return result?.customers || [];
    } catch (err) {
      this.logger.warn('Customer search failed', { phone, error: err.message });
      return [];
    }
  }

  async createCustomer(data) {
    // Check if customer exists first
    const existing = await this.searchCustomer(data.phone);
    if (existing.length > 0) {
      return { customer: existing[0] };
    }

    const payload = {
      customer: {
        first_name: sanitizeText(data.first_name || 'Guest'),
        last_name: sanitizeText(data.last_name || 'Customer'),
        email:
          data.email ||
          `guest_${Date.now()}@checkout.placeholder`,
        phone: `+91${data.phone}`,
        verified_email: false,
        accepts_marketing: false,
        tags: 'checkout-guest',
      },
    };

    try {
      return await retryAsync(
        async () => {
          return this._restRequest('customers.json', 'POST', payload);
        },
        { maxAttempts: 2, delayMs: 500 },
      );
    } catch (err) {
      this.logger.error('Customer creation failed', {
        error: err.message,
        phone: data.phone,
      });
      throw err;
    }
  }

  async createDraftOrder(payload) {
    try {
      return await retryAsync(
        async () => {
          return this._restRequest('draft_orders.json', 'POST', payload);
        },
        { maxAttempts: 2, delayMs: 500 },
      );
    } catch (err) {
      this.logger.error('Draft order creation failed', {
        error: err.message,
      });
      throw err;
    }
  }

  async completeDraftOrder(draftOrderId, paymentPending = true) {
    try {
      return await retryAsync(
        async () => {
          return this._restRequest(
            `draft_orders/${draftOrderId}/complete.json?payment_pending=${paymentPending}`,
            'PUT',
            {},
          );
        },
        { maxAttempts: 2, delayMs: 500 },
      );
    } catch (err) {
      this.logger.error('Draft order completion failed', {
        error: err.message,
        draftOrderId,
      });
      throw err;
    }
  }
}

module.exports = ShopifyClient;
