FROM python:3.12-slim

# Create a non-root user — never run application code as root
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser

WORKDIR /app

# Install dependencies first (separate layer for Docker cache efficiency)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Switch to non-root user
USER appuser

EXPOSE 8000

# --reload enables hot-reloading when ./backend is volume-mounted in dev.
# In production, the volume mount is removed and code is baked into the image.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
