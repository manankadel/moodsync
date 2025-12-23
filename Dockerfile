FROM python:3.10-slim

# Install FFmpeg (Crucial for Audio Conversion) and Git
RUN apt-get update && \
    apt-get install -y ffmpeg git && \
    apt-get clean

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Run with Gunicorn + Gevent
CMD ["gunicorn", "-k", "gevent", "-w", "1", "-b", "0.0.0.0:5001", "app:app"]