const fs = require('fs');
const path = require('path');
const request = require('request');
const mp3Duration = require('mp3-duration');


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
    const filePath = './tmp/audio-' + parseInt(Date.now() + Math.random() * 1000000) + '.' + url.split('.').pop();
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
        mp3Duration(filePath, (err, duration) => {
          if (err) throw (err)
          fs.unlink(filePath)
          callback(null, duration)
        })
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