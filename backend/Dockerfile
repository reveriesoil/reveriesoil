FROM python:3.11-slim

WORKDIR /app

# libgomp1 是 onnxruntime（rembg 依赖）的运行时依赖，缺失会导致 import 失败
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 预下载 rembg U2Net 模型权重（~175 MB），避免容器首次抠图时联网卡顿
ENV U2NET_HOME=/root/.u2net
RUN python -c "from rembg import new_session; new_session('u2net')" || \
    echo "[warn] rembg 模型预下载失败，运行时会再次尝试"

COPY app ./app

ENV PYTHONUNBUFFERED=1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
