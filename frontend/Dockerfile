FROM node:20-alpine

# Create a non-root user
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser

WORKDIR /app

# Install dependencies first (separate layer for Docker cache efficiency)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy application code
COPY . .

# Ensure .next is writable by appuser — the Docker anonymous volume for /app/.next
# inherits ownership from the image, so this must be set before USER switches.
RUN mkdir -p .next && chown -R appuser:appgroup .next

# Switch to non-root user
USER appuser

EXPOSE 3000

# Dev: hot-reload via volume mount.
# Production: override CMD to: npm run build && npm start
CMD ["npm", "run", "dev"]
