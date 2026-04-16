FROM node:20-alpine

# ─────────────────────────────────────────────────────────────
# E-Commerce Checkout Backend Container
# 
# Usage:
#   docker build -t checkout:latest .
#   docker run -p 3000:3000 --env-file .env checkout:latest
# ─────────────────────────────────────────────────────────────

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy application code
COPY . .

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => { if (r.statusCode !== 200) throw new Error(r.statusCode); })"

# Run app
CMD ["npm", "start"]

# Expose ports
EXPOSE 3000
