FROM hassanamin994/node_ffmpeg:6
WORKDIR /home/export
COPY . .
RUN npm install

CMD ["node", "worker.js", "--", 'en']