FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
# Persistent storage: mount a Railway Volume at /data (no Docker VOLUME here; Railway rejects it).
EXPOSE 3000
CMD ["npm", "start"]
