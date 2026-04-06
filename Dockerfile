FROM node:20-slim

# Install FFmpeg (Debian version - much better codec support than Alpine)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Real disk directory for temp files
RUN mkdir -p /app/data

COPY package*.json ./
RUN npm install --production

COPY server.js ./

EXPOSE 3001

CMD ["node", "--max-old-space-size=128", "server.js"]
