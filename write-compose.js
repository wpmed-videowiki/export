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
  converter_base_img:
    build:
      context: .
      dockerfile: Dockerfile
    command: ["echo", "Base image build done"]
${langs
  .map(
    (lang, index) => `
  videowiki_converter_${lang}:
    extends:
        service: converter_base_img
    restart: unless-stopped
    ${
      index === 0
        ? ""
        : `
    depends_on:
        - videowiki_converter_${langs[index - 1]}
    `
    }
    command: ["node", "worker.js", "${lang}"]
`
  )
  .join("")}
`;

fs.writeFileSync("docker-compose.yml", content);
