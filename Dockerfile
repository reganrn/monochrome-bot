FROM node:22-slim

ARG BGUTIL_PLUGIN_URL=https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/latest/download/bgutil-ytdlp-pot-provider.zip

# Install ffmpeg and yt-dlp for direct YouTube URL playback
RUN apt-get update && apt-get install -y ffmpeg curl ca-certificates --no-install-recommends \
    && mkdir -p /opt/yt-dlp-plugins \
    && curl -fL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
    && curl -fL ${BGUTIL_PLUGIN_URL} -o /opt/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --ignore-scripts

# Copy source
COPY . .

CMD ["node", "index.js"]
