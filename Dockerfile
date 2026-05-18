# ./Dockerfile
FROM python:3.11-slim

# Install FFmpeg, Git, and Node.js (yt-dlp needs Node to solve YouTube's n-challenge)
RUN apt-get update && \
    apt-get install -y ffmpeg git nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Upgrade pip first
RUN pip install --upgrade pip

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir --ignore-installed -r requirements.txt

# Copy App
COPY . .

# Permissions
RUN mkdir -p uploads && chmod 777 uploads

# Expose Port
EXPOSE 5001

# Run with Gevent
CMD ["gunicorn", "--worker-class", "geventwebsocket.gunicorn.workers.GeventWebSocketWorker", "--timeout", "120", "-w", "1", "--bind", "0.0.0.0:5001", "app:app"]