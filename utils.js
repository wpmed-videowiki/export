const fs = require('fs');
const path = require('path');
const request = require('request');
const mp3Duration = require('mp3-duration');
const { exec } = require('child_process');
const AWS = require('aws-sdk');


const BUCKET_NAME = 'vwconverter'
const REGION = 'eu-west-1';

const IMAGE_EXTENSIONS = ['jpeg', 'jpg', 'png'];
const VIDEOS_EXTESION = ['webm', 'mp4', 'ogg', 'ogv'];
const GIF_EXTESIONS = ['gif'];

const s3 = new AWS.S3({
  signatureVersion: 'v4',
  region: REGION,
  accessKeyId: process.env.S3_ACCESS_KEY, 
  secretAccessKey: process.env.S3_ACCESS_SECRET
})


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
  },
  uploadVideoToS3(filePath, callback) {
    const fileName = filePath.split('/').pop(); 
    s3.putObject({
      Bucket: BUCKET_NAME,
      Key: fileName,
      Body: fs.createReadStream(filePath),
      ContentType: 'video/mp4',
    }, (err, {ETag}) => {
      if (err) {
        return callback(err);
      }
      const url = `https://s3-${REGION}.amazonaws.com/${BUCKET_NAME}/${fileName}`;

      return callback(null, {url, ETag});
    })
  }
}
