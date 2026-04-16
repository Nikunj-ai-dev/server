# DEPRECATED FILES - DO NOT USE IN PRODUCTION

The following files are legacy implementations and should NOT be used:
- jobQueue.js (old job queue implementation)
- queueWorker.js (old worker implementation)
- apprunner.yaml (outdated AWS config)

These files are NOT referenced by the main application and are kept only for reference.
The production code uses:
- src/server/app.js (HTTP server)
- src/worker/index.js (async job processor)
- Dockerfile (AWS App Runner container definition)
- server.js (entry point)
- .env (environment configuration)

TO DEPLOY TO PRODUCTION:
1. Build Docker image: docker build -t checkout:latest .
2. Push to ECR: docker push <ECR_URI>/checkout:latest
3. Deploy to AWS App Runner with environment variables from .env.example
4. Start worker as separate service: node src/worker/index.js

See DEPLOYMENT.md for complete deployment instructions.
