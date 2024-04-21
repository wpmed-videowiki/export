require("dotenv").config();

const fs = require("fs");

const langs = [
  "en",
  "hi",
  "es",
  "ar",
  "ja",
  "uk",
  "fr",
  "or",
  "te",
  "gu",
  "bn",
  "pa",
  "sat",
  "sv",
  "it",
  "in",
  "kn",
  "ml",
  "ta",
  "eu",
];

const content = `
version: '3'
services:
  rabbitmq:
    image: rabbitmq:3-management
    environment:
      - RABBITMQ_DEFAULT_USER=\${RABBITMQ_USERNAME}
      - RABBITMQ_DEFAULT_PASS=\${RABBITMQ_PASSWORD}
    ports:
      - "5672:5672"
      - "15672:15672"

${langs
  .map(
    (lang) => `
  videowiki_converter_${lang}:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    depends_on:
      - rabbitmq
    command: ["node", "worker.js", "${lang}"]
`
  )
  .join("")}
`;

fs.writeFileSync("docker-compose.yml", content);
