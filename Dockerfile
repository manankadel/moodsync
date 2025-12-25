FROM python:3.11-slim

# Install FFmpeg (Required for audio) and Git
RUN apt-get update && \
    apt-get install -y ffmpeg git && \
    apt-get clean

WORKDIR /app

# Copy requirements
COPY requirements.txt .
# Force fresh install
RUN pip install --no-cache-dir --ignore-installed -r requirements.txt

# Copy App
COPY . .

# Permissions
RUN mkdir -p uploads && chmod 777 uploads

# Expose Port
EXPOSE 5001

# --- CRITICAL CONFIGURATION ---
# 1. Use 'eventlet' worker
# 2. Set timeout to 120s (prevents crash during download)
CMD ["gunicorn", "--worker-class", "eventlet", "--timeout", "120", "-w", "1", "--bind", "0.0.0.0:5001", "app:app"]