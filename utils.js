const fs = require('fs');
const path = require('path');
const request = require('request');
const mp3Duration = require('mp3-duration');
const { exec } = require('child_process');


const IMAGE_EXTENSIONS = ['jpeg', 'jpg', 'png'];
const VIDEOS_EXTESION = ['webm', 'mp4', 'ogg', 'ogv'];
const GIF_EXTESIONS = ['gif'];


module.exports = {
  getFileType(fileUrl) {
    const extension = fileUrl.split('.').pop();
    if (IMAGE_EXTENSIONS.indexOf(extension) > -1) return 'image';
    if (VIDEOS_EXTESION.indexOf(extension) > -1) return 'video';
    if (GIF_EXTESIONS.indexOf(extension) > -1) return 'gif';
    return 'unknown';
  },

  getRemoteFileDuration(url, callback) {
    exec(`ffprobe -i ${url} -show_entries format=duration -v quiet -of csv="p=0"`, (err, stdout, stderr) => {
      if (err) {
        return callback(err);
      }
      if (stderr) {
        return callback(stderr);
      }
      return callback(null, parseFloat(stdout.replace('\\n', '')))
    })

  },
  getRemoteFile(url, callback) {
    const filePath = './tmp/file-' + parseInt(Date.now() + Math.random() * 1000000) + "." + url.split('.').pop();
    request
      .get(url)
      .on('error', (err) => {
        throw (err)
      })
      .pipe(fs.createWriteStream(filePath))
      .on('error', (err) => {
        callback(err)
      })
      .on('finish', () => {
        callback(null, filePath)
      })
  }
}
