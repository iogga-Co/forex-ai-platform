FROM node:20-alpine

# Create a non-root user
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser

WORKDIR /app

# Install dependencies (separate layer for Docker cache efficiency)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy application code
COPY . .

# Build the Next.js app.
# NEXT_PUBLIC_API_URL is intentionally left empty here — all API calls in the
# codebase fall back to relative paths (e.g. /api/...) which nginx proxies
# correctly, so no build-time value is needed.
RUN npm run build

# Fix ownership of the built output before dropping privileges
RUN chown -R appuser:appgroup .next

# Switch to non-root user
USER appuser

EXPOSE 3000

CMD ["npm", "start"]
