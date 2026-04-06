FROM node:20-alpine

# Install FFmpeg
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Create a REAL disk directory for temp files (not tmpfs /tmp)
RUN mkdir -p /app/data

COPY package*.json ./
RUN npm install

COPY server.js ./

EXPOSE 3001

CMD ["node", "--max-old-space-size=256", "server.js"]
