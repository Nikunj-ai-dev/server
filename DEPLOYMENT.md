# Deployment Guide — AWS App Runner

This guide covers deploying the e-commerce checkout backend to AWS App Runner.

---

## Prerequisites

- AWS account with appropriate IAM permissions
- Supabase project with all tables migrated
- Shopify store with API credentials
- Razorpay account
- Meta Business account with WhatsApp API configured
- Docker installed locally (for testing)
- AWS CLI configured

---

## Step 1: Prepare AWS Environment

### Create ECR Repository

```bash
# Create ECR repo for container images
aws ecr create-repository --repository-name checkout-backend --region us-east-1

# Get login token and push to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com

# Tag image
docker tag checkout:latest <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/checkout-backend:latest

# Push
docker push <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/checkout-backend:latest
```

### Create IAM Role for App Runner

```bash
# Create role for App Runner
aws iam create-role \
  --role-name AppRunnerCheckoutRole \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Principal": {
          "Service": "apprunner.amazonaws.com"
        },
        "Action": "sts:AssumeRole"
      }
    ]
  }'

# Attach ECR access
aws iam attach-role-policy \
  --role-name AppRunnerCheckoutRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly

# Attach CloudWatch logs
aws iam attach-role-policy \
  --role-name AppRunnerCheckoutRole \
  --policy-arn arn:aws:iam::aws:policy/CloudWatchLogsFullAccess
```

---

## Step 2: Create App Runner Service

### Via AWS Console

1. Go to App Runner service
2. Click "Create service"
3. Choose Container registry source: ECR
4. Select repository: `checkout-backend`
5. Image tag: `latest`
6. Configuration:
   - **Port**: 3000
   - **CPU**: 0.5 (256 MB)
   - **Memory**: 1 GB
   - **Environment variables**: (see Step 3)

7. Service name: `checkout-backend`
8. Click "Create & deploy"

### Via AWS CLI

```bash
aws apprunner create-service \
  --service-name checkout-backend \
  --source-configuration ImageRepository='{RepositoryArn=arn:aws:ecr:us-east-1:<ACCOUNT_ID>:repository/checkout-backend,ImageIdentifier=latest,ImageRepositoryType=ECR}' \
  --instance-configuration Cpu=0.5,Memory=1024,InstanceRoleArn=arn:aws:iam::<ACCOUNT_ID>:role/AppRunnerCheckoutRole \
  --network-configuration EgressConfiguration='{EgressType=DEFAULT}' \
  --region us-east-1
```

---

## Step 3: Configure Environment Variables

In App Runner console → Environment configuration, add:

```
SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
SHOPIFY_API_KEY=your_api_key
SHOPIFY_API_SECRET=your_api_secret
SHOPIFY_STOREFRONT_TOKEN=your_storefront_token
SHOPIFY_ADMIN_TOKEN=your_admin_token

RAZORPAY_KEY_ID=rzp_live_xxx
RAZORPAY_KEY_SECRET=xxx
RAZORPAY_WEBHOOK_SECRET=xxx

META_WHATSAPP_TOKEN=xxx
META_PHONE_NUMBER_ID=xxx

SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...

APP_URL=https://checkout-xxxxx.us-east-1.apprunner.amazonaws.com
PORT=3000
NODE_ENV=production
LOG_LEVEL=info
```

**IMPORTANT**: Use AWS Secrets Manager instead of plain environment variables:

```bash
# Create secret in Secrets Manager
aws secretsmanager create-secret \
  --name checkout/razorpay-key-secret \
  --secret-string "your-secret-value"

# Reference in App Runner via JSON:
# {
#   "RAZORPAY_KEY_SECRET": {
#     "arn": "arn:aws:secretsmanager:region:account:secret:checkout/razorpay-key-secret",
#     "json-key": "RAZORPAY_KEY_SECRET"
#   }
# }
```

---

## Step 4: Configure Webhooks

### Razorpay Webhook

1. Go to Razorpay Dashboard → Settings → Webhooks
2. Add webhook URL: `https://checkout-xxxxx.us-east-1.apprunner.amazonaws.com/razorpay-webhook`
3. Events: `payment.captured`, `payment.failed`
4. Active: Yes
5. Copy webhook secret → Set as `RAZORPAY_WEBHOOK_SECRET`

---

## Step 5: Configure Custom Domain (Optional)

1. App Runner console → Custom domains
2. Click "Associate custom domain"
3. Enter domain: `checkout.yourdomain.com`
4. Validate DNS ownership
5. Add CNAME record pointing to App Runner endpoint

---

## Step 6: Update Frontend CORS Origins

In Shopify checkout.html or frontend app, update CORS origins list:

```javascript
const API_BASE = 'https://checkout-xxxxx.us-east-1.apprunner.amazonaws.com';
```

Also update `APP_URL` environment variable to match custom domain.

---

## Deployment Workflow

### Local Testing

```bash
# Build image
docker build -t checkout:latest .

# Run locally
docker run -p 3000:3000 --env-file .env checkout:latest

# Test health
curl http://localhost:3000/health
```

### Deploy to App Runner

```bash
# 1. Build and push to ECR
docker build -t checkout:latest .
docker tag checkout:latest <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/checkout-backend:latest
docker push <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/checkout-backend:latest

# 2. Trigger App Runner to pull latest image
aws apprunner update-service \
  --service-arn arn:aws:apprunner:us-east-1:<ACCOUNT_ID>:service/checkout-backend/xxxxx \
  --source-configuration ImageRepository='{RepositoryArn=arn:aws:ecr:us-east-1:<ACCOUNT_ID>:repository/checkout-backend,ImageIdentifier=latest,ImageRepositoryType=ECR}'

# 3. Wait for deployment
aws apprunner wait service-created --service-arn <SERVICE_ARN>

# 4. Test
curl https://checkout-xxxxx.us-east-1.apprunner.amazonaws.com/health
```

---

## Worker Process Deployment

The async job worker can be deployed in two ways:

### Option A: Separate App Runner Service

1. Create second service from same image
2. Override start command: `node src/worker/index.js`
3. Set environment variables (same as main service)
4. CPU/Memory: 0.25 / 512 MB (lighter load)

### Option B: AWS ECS Task

```bash
# Create task definition
aws ecs register-task-definition \
  --family checkout-worker \
  --container-definitions '[
    {
      "name": "checkout-worker",
      "image": "<ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/checkout-backend:latest",
      "cpu": 256,
      "memory": 512,
      "essential": true,
      "command": ["node", "src/worker/index.js"],
      "environment": [
        {"name": "SUPABASE_URL", "value": "..."},
        ...
      ]
    }
  ]'

# Run task
aws ecs run-task \
  --cluster default \
  --task-definition checkout-worker
```

### Option C: AWS Lambda (Periodic)

Use EventBridge to trigger a Lambda function every 30 seconds that processes batch jobs. Not recommended for high volume.

---

## Monitoring & Logging

### CloudWatch Logs

View logs in AWS Console → CloudWatch → Log Groups → `/aws/apprunner/checkout-backend`

```bash
# Or via CLI
aws logs tail /aws/apprunner/checkout-backend --follow
```

### Metrics

- Request count
- Error rate
- Request latency
- CPU utilization
- Memory utilization

Configure CloudWatch alarms:

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name checkout-error-rate \
  --alarm-description "Alert if error rate > 5%" \
  --metric-name ErrorCount \
  --namespace AWS/AppRunner \
  --statistic Sum \
  --period 300 \
  --threshold 50 \
  --comparison-operator GreaterThanThreshold
```

---

## Health Checks & Auto-Recovery

App Runner automatically replaces unhealthy instances. Health check configured:

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => { if (r.statusCode !== 200) throw new Error(r.statusCode); })"
```

---

## Scaling

### Horizontal Scaling

Auto-scale based on concurrency:

```bash
aws apprunner create-auto-scaling-configuration \
  --auto-scaling-configuration-name checkout-autoscale \
  --max-concurrency 100 \
  --max-size 5 \
  --min-size 1
```

Attach to service:

```bash
aws apprunner update-service \
  --service-arn <SERVICE_ARN> \
  --auto-scaling-configuration-arn arn:aws:apprunner:region:account:autoscalingconfiguration/checkout-autoscale
```

### Database Scaling (Supabase)

- Supabase auto-scales PostgreSQL connections
- Monitor connection pool via Supabase dashboard
- Upgrade to higher tier if hitting limits

---

## Cost Optimization

1. **Use lowest CPU/Memory tier** (0.5 vCPU / 1 GB) for typical checkout load
2. **Consolidate worker** into main service to reduce compute costs
3. **Monitor CloudWatch** for cost anomalies
4. **Use S3** for file storage (not supported natively by App Runner)
5. **Timezone**: Schedule cost reports for regular review

---

## Disaster Recovery

### Database Backup

Supabase provides automatic backups. Configure:

```bash
# In Supabase dashboard:
# Database → Backups → Weekly backups (enabled by default)
```

### Secrets Backup

Store secrets safely:

```bash
# Export all secrets
aws secretsmanager describe-secret --secret-id checkout/* | jq .
```

### Infrastructure as Code (IaC)

Use CloudFormation or Terraform:

```yaml
# Example using SAM (Serverless Application Model)
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  CheckoutService:
    Type: AWS::AppRunner::Service
    Properties:
      ServiceName: checkout-backend
      ImageRepository:
        ImageRepositoryType: ECR
        ImageIdentifier: !Sub '${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/checkout-backend:latest'
      InstanceRoleArn: !GetAtt AppRunnerRole.Arn
```

---

## Troubleshooting

### Deployment Failed

```bash
# Check deployment logs
aws apprunner describe-service --service-arn <SERVICE_ARN> | jq '.Service.ServiceStatus'

# Check container logs
aws logs get-log-events --log-group-name /aws/apprunner/checkout-backend --log-stream-name <STREAM>
```

### Health Check Failing

1. Test locally: `curl http://localhost:3000/health`
2. Check environment variables are set
3. Verify database connectivity
4. Check CloudWatch logs for errors

### High Latency

1. Check Supabase query performance
2. Monitor Shopify API rate limits
3. Review CloudWatch metrics for P99 latency
4. Consider caching cart data

### Job Queue Backlog

1. Check worker process is running
2. Scale to more worker instances
3. Review job error messages
4. Optimize job processing time

---

## Security Checklist

- [ ] All secrets in AWS Secrets Manager (not env vars)
- [ ] HTTPS/TLS enabled (default in App Runner)
- [ ] CORS restricted to known origins
- [ ] API keys rotated regularly (every 90 days)
- [ ] CloudTrail logging enabled
- [ ] VPC endpoint for Supabase (if required)
- [ ] WAF attached for DDoS protection
- [ ] SSL/TLS certificate monitoring
- [ ] Database backups tested
- [ ] Disaster recovery plan documented

---

## Post-Deployment Validation

```bash
# 1. Health check
curl https://checkout-xxxxx.us-east-1.apprunner.amazonaws.com/health
# Expected: {"status":"ok","timestamp":"2025-01-15T..."}

# 2. Checkout form
curl https://checkout-xxxxx.us-east-1.apprunner.amazonaws.com/checkout
# Expected: HTML form

# 3. Rate limiting
for i in {1..100}; do curl -X POST https://checkout-xxxxx.us-east-1.apprunner.amazonaws.com/send-otp -H "Content-Type: application/json" -d '{"phone":"9876543210"}'; done
# Expected: 429 Too Many Requests after ~10 requests

# 4. Webhook
curl -X POST https://checkout-xxxxx.us-east-1.apprunner.amazonaws.com/razorpay-webhook \
  -H "Content-Type: application/json" \
  -H "X-Razorpay-Signature: test" \
  -d '{"event":"payment.captured"}'
# Expected: 200 OK
```

---

## Support & Escalation

- **Issues**: Check CloudWatch logs → CloudWatch alarms → AWS Support
- **Performance**: AWS Support → Performance Optimization
- **Cost**: AWS Cost Explorer → Cost Anomaly Detection
- **Security**: AWS Security Hub → Compliance checks

---

**Last Updated**: January 2025  
**Version**: 1.0.0
