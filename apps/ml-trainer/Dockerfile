# The ML trainer (ML brief v1 §3, ADR 0086): a batch job, no inbound HTTP.
# Built from the repository root: docker build -f apps/ml-trainer/Dockerfile .
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY apps/ml-trainer/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/ml-trainer/trainer ./trainer
COPY apps/ml-trainer/miner ./miner

RUN useradd --system --uid 10001 --no-create-home trainer
USER 10001

CMD ["python", "-m", "trainer"]
