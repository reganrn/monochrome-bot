FROM node:22-slim

# Install ffmpeg and yt-dlp for direct YouTube URL playback
RUN apt-get update && apt-get install -y ffmpeg curl ca-certificates --no-install-recommends \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --ignore-scripts

# Copy source
COPY . .

CMD ["node", "index.js"]
