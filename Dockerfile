FROM python:3.11-slim

# Install FFmpeg and Git
RUN apt-get update && \
    apt-get install -y ffmpeg git && \
    apt-get clean

WORKDIR /app

# Install dependencies
COPY requirements.txt .
# Force reinstall to ensure eventlet is grabbed
RUN pip install --no-cache-dir --ignore-installed -r requirements.txt

# Copy app code
COPY . .

# Ensure upload directory exists
RUN mkdir -p uploads && chmod 777 uploads

# Expose port
EXPOSE 5001

# --- FIX: USE EVENTLET WORKER ---
CMD ["gunicorn", "--worker-class", "eventlet", "-w", "1", "--bind", "0.0.0.0:5001", "app:app"]