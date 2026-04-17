FROM node:22-slim

# Install ffmpeg
RUN apt-get update && apt-get install -y ffmpeg --no-install-recommends \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --ignore-scripts

# Copy source
COPY . .

CMD ["node", "index.js"]
