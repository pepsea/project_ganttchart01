FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    TZ=Asia/Tokyo

WORKDIR /app

# どのコミットから作ったかを画面のバージョン表示に出す（update.sh が渡す。無くても動く）
ARG GIT_COMMIT=""
ARG BUILD_DATE=""
ENV APP_COMMIT=$GIT_COMMIT \
    APP_BUILT=$BUILD_DATE

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./
COPY VERSION CHANGELOG.md ./
COPY static ./static

RUN useradd --create-home appuser && mkdir -p /data && chown appuser /data
USER appuser
VOLUME ["/data"]

EXPOSE 5005
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5005"]
