# E-Commerce Checkout System — Architecture & Implementation Guide

## Overview

A production-grade, secure e-commerce checkout backend built with Node.js, combining:
- **Shopify Storefront** for product catalog & cart management
- **Razorpay** for payment processing
- **Meta WhatsApp** for OTP delivery
- **Supabase PostgreSQL** for order/customer data persistence
- **Async job queue** for reliable background processing

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (HTML/JS)                       │
│              checkout.html in same directory                │
└────────────────────┬────────────────────────────────────────┘
                     │ HTTP/JSON
┌────────────────────▼─────────────────────────────────────────┐
│              Express HTTP Server (app.js)                     │
│  - Route handling, CORS, rate-limiting                        │
│  - Session token verification                                │
│  - Request validation & fraud detection                       │
│  - Worker job queueing                                        │
└────────┬──────────────────┬────────────────────┬─────────────┘
         │                  │                    │
    ┌────▼─────┐    ┌──────▼──────┐    ┌────────▼────────┐
    │ Shopify   │    │ Razorpay    │    │ Meta WhatsApp   │
    │ Storefront│    │ Payment API │    │ Message API     │
    │           │    │             │    │                 │
    │ - Cart    │    │ - Create    │    │ - Send OTP      │
    │ - Checkout│    │   Order     │    │ - Send Receipt  │
    │ - Products│    │ - Verify    │    │                 │
    └───────────┘    │   Signature │    └─────────────────┘
                     └─────────────┘
                     
         ┌──────────────────────────┐
         │  Supabase PostgreSQL     │
         │  (Data Persistence)      │
         │                          │
         │ - Orders                 │
         │ - Customers              │
         │ - Payments               │
         │ - Rate Limits            │
         │ - OTP Records            │
         │ - Job Queue              │
         │ - Audit Logs             │
         └──────────────────────────┘
         
┌────────────────────────────────────────────────────────────┐
│            Background Worker Process (index.js)             │
│  - Polls job queue every 2 seconds                          │
│  - Executes jobs with retry logic (exponential backoff)    │
│  - Processes orders, webhooks, OTPs                        │
│  - Graceful shutdown on SIGTERM                            │
└────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
src/
├── config.js                 # Environment & configuration
├── server/
│   └── app.js               # HTTP server & route handlers
├── worker/
│   └── index.js             # Background job processor
└── lib/
    ├── logger.js            # Structured logging
    ├── supabase.js          # Database client wrapper
    ├── shopify.js           # Shopify API client
    ├── razorpay.js          # Razorpay API client
    ├── whatsapp.js          # Meta WhatsApp API client
    └── utils.js             # Shared utilities

Root:
├── server.js               # Entry point for production
├── server_new.js          # Alternative entry point
├── .env.example           # Environment variables template
└── package.json           # Dependencies
```

---

## Key Features

### 1. OTP-Based Phone Verification
- SMS via WhatsApp for UX advantage
- 6-digit OTP with 10-minute validity
- Salted SHA-256 hashing with timing-safe comparison
- Rate limiting: 10 OTP requests per IP per minute
- Session tokens valid for 30 minutes post-verification

### 2. Cart & Product Management
- Shopify Storefront API integration
- Fetch cart by token with cost breakdown
- Support for discount calculation
- Line item detail capture

### 3. Payment Processing
- Razorpay integration for online payments
- COD (Cash on Delivery) support with fraud scoring
- Signature verification for all transactions
- Idempotency checking to prevent duplicate charges
- Webhook handling for payment status updates

### 4. Fraud Detection & Risk Scoring
- Real-time risk assessment (0-100 score)
- Blocks high-risk transactions (score > 50)
- Factors: COD frequency, order amount, refund history, failed payments
- COD amount cap: ₹3000, max 3 orders/day per phone

### 5. Order Management
- Customer creation/update with first purchase
- Address snapshots in orders for historical accuracy
- Order status tracking: pending → confirmed → shipped → delivered
- Line item capture from Shopify cart
- Payment record per order

### 6. Shopify Order Sync
- Draft order creation in Shopify
- Auto-completion with payment source
- Custom order notes and tags (COD, payment method)
- COD payment source setup

### 7. Async Job Queue
- Prevent blocking HTTP requests
- Reliable processing with exponential backoff
- Job types: send_otp, create_order, shopify_sync, process_webhook
- Max 3 retry attempts, 2s/4s/8s delays
- Graceful worker shutdown

### 8. Security
- CORS: Configurable per environment
- Rate limiting: Per IP and per identifier (phone)
- Input sanitization with length limits
- Email & phone validation
- HTTPS in production (reverse proxy)
- Service role key for Supabase (server-only)

### 9. Audit & Logging
- Structured JSON logging
- Request ID tracking throughout flow
- Audit log entries for sensitive actions
- Webhook event deduplication
- Error tracking with stack traces

---

## Database Schema Overview

### Key Tables

**customers**
```sql
- id (UUID, primary key)
- first_name, last_name
- email
- phone_verified (boolean)
- risk_score (0-100)
- cod_eligible (boolean)
- refund_count, chargeback_count
- created_at, updated_at
```

**orders**
```sql
- id (UUID)
- customer_id (FK)
- order_status (pending/confirmed/shipped/delivered)
- payment_status (pending/paid/failed)
- fulfillment_status
- is_cod (boolean)
- grand_total (decimal)
- various snapshots (email, phone, addresses)
- custom_fields (JSON for Shopify order number, etc.)
```

**payments**
```sql
- id (UUID)
- order_id (FK)
- payment_provider (razorpay/cod)
- provider_payment_id, provider_order_id
- payment_status (paid/failed/pending)
- gateway_response (JSON)
- fraud_risk_result (numeric score)
```

**job_queue**
```sql
- id (UUID)
- job_type (send_otp/create_order/shopify_sync/process_webhook)
- payload (JSONB)
- status (pending/processing/completed/failed)
- attempts, max_attempts
- next_run_at, scheduled_at
- error_message
```

**temp_otp**
```sql
- id (UUID)
- identifier (phone/email)
- otp_hash (salted hash)
- purpose (checkout/checkout_session)
- expires_at
- attempts, max_attempts
- consumed (boolean)
```

**rate_limits**
```sql
- id (UUID)
- key (IP + context)
- count (request count in window)
- reset_at (window expiry)
```

---

## Environment Variables

```bash
# Shopify
SHOPIFY_SHOP_DOMAIN=myshop.myshopify.com
SHOPIFY_STOREFRONT_TOKEN=xxxxx
SHOPIFY_ADMIN_TOKEN=xxxxx
SHOPIFY_API_KEY=xxxxx
SHOPIFY_API_SECRET=xxxxx

# Razorpay (Payment)
RAZORPAY_KEY_ID=rzp_live_xxxxx
RAZORPAY_KEY_SECRET=xxxxx
RAZORPAY_WEBHOOK_SECRET=xxxxx

# Meta WhatsApp
META_WHATSAPP_TOKEN=xxxxx
META_PHONE_NUMBER_ID=xxxxx

# Supabase
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJxx...

# Application
APP_URL=https://checkout.example.com
PORT=3000
NODE_ENV=production
LOG_LEVEL=info
```

---

## API Endpoints

### Public Endpoints

✅ `GET /checkout`
- Returns checkout.html form
- CORS: Allow from configured origins

✅ `GET /cart-data?cart_token=xxx`
- Fetch Shopify cart details
- Returns: cost breakdown, line items
- Rate limit: 20 per IP per minute

✅ `POST /send-otp`
- Body: `{ phone: "9876543210" }`
- Queues OTP via WhatsApp
- Rate limit: 10 per IP, 5 per phone per minute

✅ `POST /verify-otp`
- Body: `{ phone: "9876543210", otp: "123456" }`
- Validates OTP hash
- Returns: session_token, expiry

✅ `POST /apply-coupon`
- Body: `{ coupon_code: "SAVE10", subtotal: 500 }`
- Validates coupon & calculates discount
- Returns: discount amount, final total

✅ `POST /create-razorpay-order`
- Body: `{ amount: 500, phone: "9876543210", session_token }`
- Creates Razorpay order
- Returns: razorpay_order_id, amount, currency

✅ `POST /verify-payment`
- Body: `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }`
- Verifies signature
- Returns: {verified: true, duplicate: false}

✅ `POST /create-order`
- Body: Full order payload (cart, address, payment data)
- Queues order creation job
- Returns: 202 Accepted with amount

✅ `POST /razorpay-webhook`
- Razorpay → Server webhook
- Idempotency via event ID
- Queues webhook processing

✅ `GET /health`
- Server health check
- Returns: {status: "ok", timestamp}

---

## Request/Response Flow

### 1. OTP Phase
```
Frontend → POST /send-otp 
  ↓
Server validates phone, rate-limits
  ↓
Queue job: send_otp
  ↓
Worker polls job, calls WhatsApp API
  ↓
OTP delivered to customer's WhatsApp

Frontend → POST /verify-otp (user enters code)
  ↓
Server validates OTP hash, rate-limits attempts
  ↓
Returns session_token (valid 30 minutes)
```

### 2. Cart & Payment Setup
```
Frontend → GET /cart-data?cart_token=xxx
  ↓
Server fetches from Shopify Storefront
  ↓
Frontend → POST /apply-coupon (optional)
  ↓
Server validates coupon, calculates discount
  ↓
Frontend → POST /create-razorpay-order
  ↓
Server creates Razorpay order, returns order_id
  ↓
Frontend shows Razorpay checkout modal
```

### 3. Order Creation
```
Frontend → Razorpay checkout
  ↓ (user enters card/UPI)
Razorpay → POST /razorpay-webhook (payment.captured)
  ↓
Server queues webhook job
  ↓
Worker processes webhook, marks payment as paid
  ↓
Frontend → POST /create-order
  ↓
Server verifies payment signature, fraud score, stock
  ↓
Queue job: create_order
  ↓
Worker inserts order, items, payment record
  ↓
Queue job: shopify_sync
  ↓
Worker creates Shopify draft order, marks as fulfilled
```

---

## Error Handling & Retries

### HTTP Status Codes
- **200**: Success
- **202**: Accepted (async job queued)
- **400**: Bad request (validation failed)
- **401**: Unauthorized (invalid OTP/session)
- **403**: Forbidden (fraud, COD limit)
- **404**: Not found
- **409**: Conflict (duplicate payment)
- **429**: Rate limited
- **500**: Server error

### Transient Errors
- Rate limit check fails → Fail open (allow)
- Shopify API timeout → Retry (handled at app level)
- Supabase insert fails → Retry in job queue

### Job Queue Retry Logic
```
Attempt 1 → Failed → Retry after 2s
Attempt 2 → Failed → Retry after 4s
Attempt 3 → Failed → Final failure, log error
```

---

## Deployment

### Prerequisites
- Node.js 20+
- Supabase project with tables created (see SQL file)
- Shopify app with API credentials
- Razorpay account
- Meta Business account with WhatsApp API
- AWS App Runner (or equivalent container service)

### Docker (AWS App Runner)
```dockerfile
FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .

CMD ["npm", "start"]
```

### Environment Setup
1. Copy `.env.example` → `.env`
2. Fill in all required variables
3. Run database migrations (see SQL file)
4. Deploy to AWS App Runner

### Health Check
```bash
curl https://checkout.example.com/health
# {
#   "status": "ok",
#   "timestamp": "2025-01-15T10:30:00Z"
# }
```

### Scaling
- **Horizontal**: Deploy multiple app instances behind load balancer
- **Job Queue**: Worker runs as separate process, can scale independently
- **Database**: Supabase handles auto-scaling

---

## Monitoring & Debugging

### Logs
- Check CloudWatch (AWS) or equivalent container logs
- Structured JSON format

### Key Metrics
- Request latency (P50, P95, P99)
- Job queue depth (pending, processing)
- Error rate by endpoint
- OTP delivery success rate
- Payment success rate

### Common Issues

**OTP not received**
- Check Meta WhatsApp configuration
- Verify phone number is in correct format
- Check job queue for failures

**Orders not syncing to Shopify**
- Check Shopify API token permissions
- Review job queue errors
- Verify cart still exists in Shopify

**High fraud scores**
- Review customer history
- Adjust fraud detection thresholds in code
- Monitor refund patterns

---

## Security Considerations

1. **Secrets Management**: Use AWS Secrets Manager or equivalent
2. **HTTPS/TLS**: Enforce in production (reverse proxy)
3. **Rate Limiting**: Per-IP and per-identifier
4. **Input Validation**: Length limits, regex patterns
5. **Database**: Service role key (server-only), Row-level security optional
6. **Logging**: Never log full payment details or OTPs
7. **CORS**: Restrict to specific origins in production
8. **Webhook Verification**: Always verify signatures

---

## Future Enhancements

1. **Payment Retries**: Auto-retry failed Razorpay orders
2. **SMS Fallback**: If WhatsApp unavailable, send SMS
3. **Multi-language**: Support for regional languages
4. **Recurring Orders**: Subscription support
5. **Inventory Management**: Real-time stock checks
6. **Advanced Analytics**: Conversion funnel tracking
7. **A/B Testing**: Coupon/discount variations
8. **Customer Support**: Chat integration
9. **Refunds**: Automated refund processing
10. **Payment Methods**: PayPal, Apple Pay, Google Pay

---

## Support & Troubleshooting

### Health Check Script
```bash
# Monitor worker
tail -f logs/worker.log

# Monitor server
tail -f logs/server.log

# Check job queue
curl https://checkout.example.com/health
```

### Emergency Actions
```bash
# Clear stuck jobs
UPDATE job_queue SET status = 'failed' WHERE status = 'processing' AND updated_at < now() - interval '1 hour';

# Reset rate limits
DELETE FROM rate_limits WHERE reset_at < now();
```

---

**Version**: 1.0.0  
**Last Updated**: January 2025  
**Maintainers**: Your Team
