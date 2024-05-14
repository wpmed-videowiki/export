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
  "ha"
];

const content = `
version: '3'
services:
${langs
  .map(
    (lang, index) => `
  videowiki_converter_${lang}:
    image: videowiki/export:latest
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
