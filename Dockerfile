# Use a slim Python image
FROM python:3.11-slim

# Install system dependencies: FFmpeg (for audio) and Git (for some pip packages)
RUN apt-get update && \
    apt-get install -y ffmpeg git && \
    apt-get clean

# Set working directory
WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Run the app using Gunicorn with Gevent (Required for Socket.IO)
CMD ["gunicorn", "-k", "gevent", "-w", "1", "-b", "0.0.0.0:5001", "app:app"]