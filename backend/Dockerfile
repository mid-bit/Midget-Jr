# Dockerfile for Midget jr. backend — works on Koyeb, Fly, Render, anywhere.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# System deps (lxml needs these for the ddgs web search)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libxml2-dev libxslt1-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps first (better layer caching)
COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

# App code
COPY . .

# Koyeb / most PaaS pass the public port via $PORT
ENV PORT=8000
EXPOSE 8000

# Single uvicorn worker — APScheduler must not run in multiple workers
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
