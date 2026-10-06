# Herramientas de comprobación de PDF y QR para las pruebas (no forma parte del despliegue).
FROM python:3.12-slim-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils libzbar0 libcairo2 \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir pillow pyzbar cairosvg
COPY qrdecode.py /usr/local/bin/qrdecode
RUN chmod +x /usr/local/bin/qrdecode
