FROM jrottenberg/ffmpeg:6.1-ubuntu AS ffmpeg

FROM node:20-slim
COPY --from=ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /usr/local/bin/ffprobe /usr/local/bin/ffprobe
COPY --from=ffmpeg /usr/local/lib /usr/local/lib
ENV LD_LIBRARY_PATH=/usr/local/lib

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
