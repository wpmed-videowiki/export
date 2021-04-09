const fs = require('fs');
const { exec } = require('child_process');
const langs = [
  'en',
  'hi',
  'es',
  'ar',
  'ja',
  'uk',
  'fr',
  'or',
  'te',
  'gu',
  'bn',
  'pa',
  'sat',
  'sv',
  'it',
  'in',
  'kn',
  'ml',
  'ta',
];
const APP_DIRS = ['./tmp', './videos', './final'];

// Create necessary file dirs
APP_DIRS.forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
});

langs.forEach(function (lang, index) {
  const command = `node_modules/pm2/bin/pm2 start worker.js -i 1 --name=videowiki_converter_${lang} -- ${lang}`;
  setTimeout(() => {
    console.log(command);
    exec(command, (err) => {
      if (err) {
        console.log('error initializing ', lang, ports[index], err);
      }
    });
  }, index * 1500);
});
