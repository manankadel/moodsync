FROM python:3.11-slim

# Install FFmpeg and Git
RUN apt-get update && \
    apt-get install -y ffmpeg git && \
    apt-get clean

WORKDIR /app

# Upgrade pip first (Critical fix for package finding)
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

# Run with Eventlet
CMD ["gunicorn", "--worker-class", "eventlet", "--timeout", "120", "-w", "1", "--bind", "0.0.0.0:5001", "app:app"]