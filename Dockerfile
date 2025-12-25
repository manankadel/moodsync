FROM python:3.11-slim

# Install FFmpeg and Git
RUN apt-get update && \
    apt-get install -y ffmpeg git && \
    apt-get clean

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy app code
COPY . .

# Ensure upload directory exists with permissions
RUN mkdir -p uploads && chmod 777 uploads

# Expose port
EXPOSE 5001

# --- THE ABSOLUTE FIX FOR SOCKETS ---
CMD ["gunicorn", "-k", "geventwebsocket.gunicorn.workers.GeventWebSocketWorker", "-w", "1", "--bind", "0.0.0.0:5001", "app:app"]