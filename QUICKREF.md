# Quick Reference Guide

Fast lookup for common tasks and configurations.

---

## 🚀 Getting Started (5 minutes)

```bash
# 1. Install dependencies
npm install

# 2. Copy env template
cp .env.example .env

# 3. Fill in API keys in .env
# SHOPIFY_API_KEY=...
# RAZORPAY_KEY_ID=...
# META_WHATSAPP_TOKEN=...
# SUPABASE_URL=...
# etc.

# 4. Start development
npm run dev          # Terminal 1: HTTP server
node src/worker      # Terminal 2: Job processor
```

---

## 📋 Environment Variables Checklist

```bash
# Required (no defaults)
□ SHOPIFY_SHOP_DOMAIN
□ SHOPIFY_API_KEY
□ SHOPIFY_API_SECRET
□ SHOPIFY_STOREFRONT_TOKEN
□ SHOPIFY_ADMIN_TOKEN
□ RAZORPAY_KEY_ID
□ RAZORPAY_KEY_SECRET
□ RAZORPAY_WEBHOOK_SECRET
□ META_WHATSAPP_TOKEN
□ META_PHONE_NUMBER_ID
□ SUPABASE_URL
□ SUPABASE_SERVICE_KEY
□ APP_URL

# Optional (have defaults)
□ PORT (default: 3000)
□ NODE_ENV (default: production)
□ LOG_LEVEL (default: info)
```

---

## 🔧 Common Commands

### Development
```bash
npm install              # Install dependencies
npm run dev             # Start with auto-reload
node src/worker/index.js   # Start job worker
npm test                # Run tests (not yet implemented)
```

### Production
```bash
npm start               # Start server
NODE_ENV=production npm start
docker build -t checkout:latest .
docker run -p 3000:3000 --env-file .env checkout:latest
```

### Database
```bash
# See Supabase SQL (2).txt for schema
# Connect via Supabase dashboard or psql

# Check job queue
psql -U postgres -h <SUPABASE_HOST> -d postgres
SELECT * FROM job_queue WHERE status = 'pending';
SELECT * FROM job_queue WHERE status = 'failed';

# Clear stuck jobs (careful!)
UPDATE job_queue SET status = 'failed' 
WHERE status = 'processing' AND updated_at < now() - interval '1 hour';
```

---

## 📡 API Testing

### Send OTP
```bash
curl -X POST http://localhost:3000/send-otp \
  -H "Content-Type: application/json" \
  -d '{"phone":"9876543210"}'
```

### Verify OTP
```bash
curl -X POST http://localhost:3000/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"phone":"9876543210","otp":"123456"}'
```

### Get Cart
```bash
curl "http://localhost:3000/cart-data?cart_token=xyz123"
```

### Apply Coupon
```bash
curl -X POST http://localhost:3000/apply-coupon \
  -H "Content-Type: application/json" \
  -d '{"coupon_code":"SAVE10","subtotal":5000}'
```

### Create Razorpay Order
```bash
curl -X POST http://localhost:3000/create-razorpay-order \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 4900,
    "phone": "9876543210",
    "session_token": "abc123..."
  }'
```

### Create Order
```bash
curl -X POST http://localhost:3000/create-order \
  -H "Content-Type: application/json" \
  -d '{
    "cart_token": "xyz123",
    "phone": "9876543210",
    "address": {
      "full_name": "John Doe",
      "address_line1": "123 Street",
      "city": "Mumbai",
      "state": "MH",
      "postal_code": "400001"
    },
    "payment_method": "razorpay",
    "razorpay_data": {
      "razorpay_order_id": "order_xxx",
      "razorpay_payment_id": "pay_xxx",
      "razorpay_signature": "sig_xxx"
    },
    "session_token": "abc123...",
    "discount_amount": 100
  }'
```

### Health Check
```bash
curl http://localhost:3000/health
```

---

## 📂 Project Structure Quick Map

```
src/
├── server/app.js         ← Main HTTP server
├── worker/index.js       ← Job processor
├── config.js             ← Configuration
└── lib/
    ├── supabase.js       ← DB client
    ├── shopify.js        ← Shopify API
    ├── razorpay.js       ← Payment API
    ├── whatsapp.js       ← WhatsApp API
    ├── logger.js         ← Logging
    └── utils.js          ← Helpers

checkout.html            ← Frontend form
server.js                ← Entry point
package.json             ← Dependencies
```

---

## 🐛 Debugging

### Check Logs
```bash
# Local
tail -f logs/error.log

# Production (AWS CloudWatch)
aws logs tail /aws/apprunner/checkout-backend --follow

# Supabase logs
supabase logs list
```

### Enable Debug Mode
```bash
LOG_LEVEL=debug npm run dev
```

### Common Issues

**OTP not received**
- Check `job_queue` table for `send_otp` jobs
- Verify WhatsApp token in Supabase
- Check phone number format: should be 10 digits

**Orders not in Shopify**
- Check `job_queue` for `shopify_sync` failures
- Verify Shopify admin token has permissions
- Check order payload in `job_queue`

**Payment verification fails**
- Verify `RAZORPAY_KEY_SECRET` matches exactly
- Check signature generation in `lib/razorpay.js`
- Ensure webhook secret is correct

---

## 🔐 Security Quick Checks

```bash
# ✓ No secrets in code
grep -r "razorpay_key_secret\|whatsapp_token" src/

# ✓ All env vars used
grep -r "process.env\." src/ | grep -v "NODE_ENV\|LOG_LEVEL\|PORT"

# ✓ Input validation in place
grep -r "validatePhone\|validateEmail\|sanitizeText" src/

# ✓ Rate limiting enabled
grep -r "checkRateLimit\|rate_limit" src/

# ✓ Signature verification
grep -r "verifySignature\|verify.*signature" src/
```

---

## 📊 Monitoring Checklist

**Daily**:
- [ ] Check error rate in CloudWatch
- [ ] Review job queue depth
- [ ] Monitor OTP delivery success rate

**Weekly**:
- [ ] Analyze API latency
- [ ] Review fraud detection blocks
- [ ] Check database performance

**Monthly**:
- [ ] Verify all integrations working
- [ ] Test database backup/restore
- [ ] Review and rotate API keys
- [ ] Audit CloudWatch logs

---

## 🚨 Emergency Procedures

### Clear Stuck Jobs
```bash
-- Be careful with this!
UPDATE job_queue 
SET status = 'failed',
    completed_at = now()
WHERE status = 'processing' 
AND updated_at < now() - interval '1 hour';
```

### Disable Fraud Detection (last resort)
```javascript
// In src/config.js, set:
enable_fraud_detection: false
```

### Restart Server (AWS App Runner)
```bash
# Force new deployment
aws apprunner update-service \
  --service-arn arn:aws:apprunner:... \
  --source-configuration ImageRepository='{...}'
```

### Rollback Deployment
```bash
# Re-deploy previous image tag
docker tag checkout:v1.0.0-stable checkout:latest
docker push <ECR>/checkout-backend:latest
```

---

## 📖 Documentation Links

| Topic | File |
|-------|------|
| Full Architecture | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Deployment | [DEPLOYMENT.md](DEPLOYMENT.md) |
| API Reference | [README.md](README.md) |
| Implementation Details | [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) |
| Database Schema | [Supabase SQL (2).txt](Supabase%20SQL%20(2).txt) |

---

## 💡 Pro Tips

1. **Use request IDs for debugging** — Every response includes `requestId`, visible in logs
2. **Check job_queue before assuming failure** — Async jobs may still be processing
3. **Test locally with realistic data** — Use real Shopify test orders
4. **Monitor Razorpay dashboard** — See payment status there if unsure of local state
5. **Keep worker process running** — Without it, jobs won't process
6. **Set APP_URL to actual domain** — Used in email links and CORS validation
7. **Rate limits are per-identifier** — Phone numbers have separate limits from IPs
8. **Snapshots are immutable** — Order email/address never changes, good for audit
9. **Webhook idempotency is automatic** — Razorpay can fire same event twice safely
10. **Test fraud detection locally** — Create multiple COD orders to trigger blocking

---

## 🆘 Getting Help

1. **Check CloudWatch logs** — Most answers are there
2. **Read ARCHITECTURE.md** — System design explained
3. **Review DEPLOYMENT.md** — Deployment-specific issues
4. **Check database directly** — Supabase dashboard SQL editor
5. **Contact engineering team** — For escalation

---

**Last Updated**: January 2025  
**Quick Ref Version**: 1.0
