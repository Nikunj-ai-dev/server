# E-Commerce Checkout Backend

Secure, production-grade checkout system integrating Shopify, Razorpay, Meta WhatsApp, and Supabase.
Handles cart management, OTP verification, payment processing, fraud detection, and order fulfillment.

---

## Features

✅ **OTP Verification** — Phone verification via WhatsApp with 10-minute validity  
✅ **Shopify Integration** — Real-time cart fetching, product catalog  
✅ **Razorpay Payments** — Online & COD (cash on delivery) support  
✅ **Fraud Detection** — Risk scoring on orders (machine learning ready)  
✅ **Async Processing** — Background job queue for order creation, syncs  
✅ **Rate Limiting** — Per-IP and per-identifier protection  
✅ **Webhook Handling** — Razorpay payment callbacks with idempotency  
✅ **Audit Logging** — Full request tracking and sensitive action logs  

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for full system design, database schema, and API documentation.

Quick overview:
```
Frontend (checkout.html)
    ↓
HTTP Server (src/server/app.js) — request validation, CORS, rate limits
    ├─ Shopify API (cart data)
    ├─ Razorpay API (payments)
    ├─ Meta WhatsApp API (OTP)
    └─ Supabase PostgreSQL (data persistence)
         ↓
Job Queue (src/worker/index.js) — async processing with retries
```

---

## Stack

| Layer        | Technology                  |
|--------------|-----------------------------|
| Runtime      | Node.js 20+                 |
| HTTP Server  | Native Node.js `http`       |
| Database     | Supabase PostgreSQL         |
| Payment      | Razorpay API                |
| Commerce     | Shopify Storefront API      |
| Messaging    | Meta WhatsApp API           |
| Deployment   | AWS App Runner              |

---

## Local Development

### Prerequisites
- Node.js 20+
- Supabase account with database configured
- Shopify store with API credentials
- Razorpay account
- Meta Business account with WhatsApp API

### Setup

```bash
# 1. Clone and install
git clone <repo>
cd checkout-backend
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 3. Run server
npm start

# Or with auto-restart
npm run dev

# 4. Run worker in separate terminal
node src/worker/index.js
```

**Server**: http://localhost:3000  
**Health check**: http://localhost:3000/health

---

## Deployment

### AWS App Runner

1. **Build & Push Docker Image**
   ```bash
   docker build -t checkout:latest .
   docker push your-ecr-repo/checkout:latest
   ```

2. **Create App Runner Service**
   - ECR image: `your-ecr-repo/checkout:latest`
   - Port: 3000
   - Memory: 1 GB, CPU: 0.5
   - Environment variables: Copy from `.env.example`

3. **Worker Process**
   - Deploy separate App Runner service OR
   - Run as background task in same container
   - Or use AWS SQS + Lambda

### Environment Variables

All required in App Runner service config:

```
SHOPIFY_SHOP_DOMAIN
SHOPIFY_API_KEY
SHOPIFY_API_SECRET
SHOPIFY_STOREFRONT_TOKEN
SHOPIFY_ADMIN_TOKEN
RAZORPAY_KEY_ID
RAZORPAY_KEY_SECRET
RAZORPAY_WEBHOOK_SECRET
META_WHATSAPP_TOKEN
META_PHONE_NUMBER_ID
SUPABASE_URL
SUPABASE_SERVICE_KEY
APP_URL
PORT (default: 3000)
NODE_ENV (default: production)
LOG_LEVEL (default: info)
```

---

## API Endpoints

### Public Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/checkout` | Returns checkout HTML form |
| `GET` | `/cart-data?cart_token=xxx` | Fetch Shopify cart details |
| `POST` | `/send-otp` | Send OTP via WhatsApp |
| `POST` | `/verify-otp` | Verify OTP and get session |
| `POST` | `/apply-coupon` | Validate coupon and calculate discount |
| `POST` | `/create-razorpay-order` | Create Razorpay order |
| `POST` | `/verify-payment` | Verify payment signature |
| `POST` | `/create-order` | Create order (async) |
| `POST` | `/razorpay-webhook` | Razorpay payment callbacks |
| `GET` | `/health` | Health check |

### Example: Complete Checkout Flow

```javascript
// 1. Send OTP
POST /send-otp
{"phone": "9876543210"}
→ Queues WhatsApp OTP delivery

// 2. Verify OTP
POST /verify-otp
{"phone": "9876543210", "otp": "123456"}
→ Returns session_token

// 3. Fetch cart
GET /cart-data?cart_token=xyz123
→ Returns cart items and costs

// 4. Apply coupon (optional)
POST /apply-coupon
{"coupon_code": "SAVE10", "subtotal": 5000}
→ Returns discount and final total

// 5. Create Razorpay order
POST /create-razorpay-order
{"amount": 4900, "phone": "9876543210", "session_token": "abc..."}
→ Returns razorpay_order_id

// 6. Process payment (Razorpay UI)
// User enters card/UPI in Razorpay modal

// 7. Verify payment
POST /verify-payment
{"razorpay_order_id": "...", "razorpay_payment_id": "...", "razorpay_signature": "..."}
→ Returns {verified: true, duplicate: false}

// 8. Create order
POST /create-order
{
  "cart_token": "xyz123",
  "phone": "9876543210",
  "address": {...},
  "payment_method": "razorpay",
  "razorpay_data": {...},
  "session_token": "abc...",
  "discount_amount": 100
}
→ Returns 202 Accepted (async processing)
```

---

## Database

### Required Tables

Run SQL migrations from `Supabase SQL (2).txt` to create:
- customers
- orders
- order_items
- payments
- shipments
- coupons
- job_queue
- temp_otp
- rate_limits
- webhook_logs
- audit_logs
- analytics_events

---

## File Structure

```
src/
├── config.js              # Environment + configuration
├── server/
│   └── app.js            # HTTP server & routes
├── worker/
│   └── index.js          # Job queue processor
└── lib/
    ├── logger.js         # Structured logging
    ├── supabase.js       # DB client
    ├── shopify.js        # Shopify API client
    ├── razorpay.js       # Razorpay API client
    ├── whatsapp.js       # WhatsApp API client
    └── utils.js          # Helpers

Root:
├── server.js             # Production entry point
├── checkout.html         # Checkout form
├── package.json
├── .env.example
└── ARCHITECTURE.md       # Full documentation
```

---

## Security Best Practices

1. **Secrets**: Use AWS Secrets Manager, never hardcode
2. **HTTPS**: Enforce in production (reverse proxy)
3. **Rate Limiting**: Per-IP and per-identifier
4. **Validation**: Sanitize all input, enforce length limits
5. **Logging**: Never log full payment details or OTPs
6. **CORS**: Restrict to specific origins
7. **Signatures**: Always verify Razorpay webhooks
8. **Timing**: Use timing-safe comparison for OTP hashes

---

## Monitoring

### Health Check
```bash
curl https://your-domain/health
```

### Logs Structure
```json
{
  "timestamp": "2025-01-15T10:30:00Z",
  "level": "INFO",
  "message": "Order created",
  "pid": 1234,
  "requestId": "req_abc123",
  "orderId": "ord_xyz789"
}
```

### Key Metrics
- Request latency (P50, P95, P99)
- Error rate by endpoint
- Job queue depth (pending/processing/failed)
- OTP delivery success rate
- Payment success rate
- Fraud detection blocks

---

## Troubleshooting

### OTP Not Received
- Verify Meta WhatsApp token and phone number ID
- Check job queue for `send_otp` failures
- Ensure phone number is in `+91` Indian format

### Orders Not Syncing to Shopify
- Verify Shopify admin token permissions
- Check `shopify_sync` job failures
- Ensure cart still exists in Shopify

### Payment Signature Invalid
- Verify `RAZORPAY_KEY_SECRET` is correct
- Check webhook signature is in correct format
- Compare signature generation logic

### High Job Queue Backlog
- Increase worker concurrency or add more worker instances
- Check for rate limit errors from external APIs
- Review database query performance

---

## License

Proprietary — All rights reserved

---

## Support

For issues or questions, contact your development team.

---

## AWS App Runner Deployment

### Option A — GitHub Auto-Deploy (recommended)

1. Push this repo to GitHub.
2. In AWS Console → App Runner → Create service.
3. Source: GitHub repository, branch: `main`.
4. Build command: `npm ci --omit=dev`
5. Start command: `node server.js`
6. Port: `8080`
7. Add all environment variables from `.env.example`.
8. Set health check path to `/health`.
9. Deploy.

### Option B — ECR Container Image

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js .
EXPOSE 8080
CMD ["node", "server.js"]
```

Build and push to ECR, then create App Runner service from ECR image.

### Health Check

App Runner requires a health check endpoint. Configured to:
- Path: `/health`
- Protocol: HTTP
- Healthy threshold: 1
- Unhealthy threshold: 5
- Interval: 10s
- Timeout: 5s

---

## Socket.IO Client Connection

```javascript
import { io } from 'socket.io-client';

const socket = io('https://your-apprunner-url.awsapprunner.com', {
  transports: ['websocket', 'polling'],
  withCredentials: true,
});

// Step 1: Authenticate immediately after connect
socket.on('connect', async () => {
  const { data: { session } } = await supabase.auth.getSession();
  
  socket.emit('authenticate', {
    token: session.access_token,
    roomCode: currentRoomCode ?? undefined, // for reconnection
  }, (res) => {
    if (!res.ok) { console.error('auth failed', res.error); return; }
    // Ready to use socket
  });
});
```

---

## Event Reference

### Client → Server

| Event                  | Payload                                 | Description                          |
|------------------------|-----------------------------------------|--------------------------------------|
| `authenticate`         | `{ token, roomCode? }`                  | Must be first event after connect    |
| `room:create`          | `{ roomId, roomCode, gameConfig? }`     | Register room in live state          |
| `room:join`            | `{ roomCode }`                          | Join an existing room                |
| `room:leave`           | —                                       | Leave waiting room                   |
| `room:start`           | `{ gameConfig? }`                       | Host starts the match                |
| `room:snapshot_request`| —                                       | Request fresh room state             |
| `player:ready`         | `{ ready: boolean }`                    | Toggle ready state                   |
| `player:flap`          | `{ ts: number }`                        | Broadcast flap to other players      |
| `player:score_update`  | `{ score, pipesCleared }`               | Report local score                   |
| `player:died`          | —                                       | Report self death (collision)        |

### Server → Client

| Event                  | Payload                                 | Description                          |
|------------------------|-----------------------------------------|--------------------------------------|
| `room:snapshot`        | `RoomSnapshot`                          | Full room state                      |
| `room:host_changed`    | `{ newHostId }`                         | Host transferred                     |
| `room:expired`         | `{ reason }`                            | Room was evicted (stale/empty)       |
| `player:ready_changed` | `{ userId, isReady }`                   | A player toggled ready               |
| `player:reconnected`   | `{ userId }`                            | A player came back online            |
| `player:flap`          | `{ userId, ts }`                        | Another player flapped               |
| `player:died`          | `{ userId, eliminationOrder, survivedMs }` | A player died                     |
| `match:starting`       | `{ seed, startAt, gameConfig, players }`| Match countdown started              |
| `match:ids`            | `{ matchId }`                           | Supabase match ID (after DB write)   |
| `match:finished`       | `{ winnerId, eliminationOrder, players }`| Match over                          |
| `session:superseded`   | —                                       | New tab/device took over session     |
| `server:shutdown`      | `{ message }`                           | Server is restarting                 |

---

## Architecture Notes

### Why no per-frame position sync?
Each client runs an identical deterministic physics simulation seeded with the same
random seed. Pipe positions are fully reproducible client-side. The server only relays
discrete flap events. This eliminates ~60 messages/sec/player and scales to many rooms.

### Auth flow
Supabase issues JWTs signed with HS256. The backend verifies them using the JWT secret
directly (`jsonwebtoken`), avoiding a round-trip to Supabase on every connect.
Profile data is fetched once from Supabase on first authentication and cached on the socket.

### Reconnection
Socket.IO's `connectionStateRecovery` handles brief reconnects transparently.
For longer disconnects, the client re-sends `authenticate` with a `roomCode` to
restore in-room state. Players that disconnect during a match are treated as dead
after the disconnect event fires.

### Supabase writes
All writes to `matches`, `match_players`, and `rooms` use the service role key
and are fire-and-forget with error logging. They never block game progression.
`player_stats` is maintained automatically by a Supabase trigger.

### Scaling
This server is stateful (in-memory room store). For multi-instance scaling,
replace `roomStore` / `socketToUser` / `userToSocket` with Redis and use
Socket.IO's Redis adapter (`@socket.io/redis-adapter`). The rest of the code
is already structured to support this transition.
