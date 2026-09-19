# Ride91 backend — portable container (Render / Railway / Fly / Cloud Run).
# No Emergent base image, no bundled Mongo: the database is external
# (MongoDB Atlas), passed in via MONGO_URL.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install deps first for layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App code.
COPY . .

# The platform sets $PORT (Render/Railway/Cloud Run). Default 8000 locally.
ENV PORT=8000
EXPOSE 8000

# Shell form so $PORT expands. One worker: the app holds per-process state
# (in-memory nothing critical, but Mongo is the source of truth) — scale by
# running more instances behind the platform's load balancer, not more workers.
CMD uvicorn server:app --host 0.0.0.0 --port ${PORT}
