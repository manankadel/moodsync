FROM python:3.11-slim

# Install FFmpeg (Crucial for Audio) and Git
RUN apt-get update && \
    apt-get install -y ffmpeg git && \
    apt-get clean

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy app code
COPY . .

# Expose port
EXPOSE 5001

# --- THE FIX IS HERE ---
# Changed "-k gevent" to "-k geventwebsocket.gunicorn.workers.GeventWebSocketWorker"
CMD ["gunicorn", "-k", "geventwebsocket.gunicorn.workers.GeventWebSocketWorker", "-w", "1", "-b", "0.0.0.0:5001", "app:app"]