const fs = require('fs');

const APP_DIRS = ['./tmp', './videos', './final'];

// Create necessary file dirs 
APP_DIRS.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
})

