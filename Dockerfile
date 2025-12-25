FROM python:3.11-slim

# Install FFmpeg (Required for audio processing) and Git
RUN apt-get update && \
    apt-get install -y ffmpeg git && \
    apt-get clean

WORKDIR /app

# Copy requirements and force install
COPY requirements.txt .
RUN pip install --no-cache-dir --ignore-installed -r requirements.txt

# Copy App Code
COPY . .

# Create uploads folder with write permissions
RUN mkdir -p uploads && chmod 777 uploads

# Expose Port
EXPOSE 5001

# Start Server using Eventlet (Fixes socket crashes)
CMD ["gunicorn", "--worker-class", "eventlet", "--timeout", "120", "-w", "1", "--bind", "0.0.0.0:5001", "app:app"]