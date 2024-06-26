FROM node:20.12.2
WORKDIR /home/export
RUN apt update -y  
RUN apt install ffmpeg -y
COPY . .
RUN npm install

CMD ["node", "worker.js", "--", 'en']
