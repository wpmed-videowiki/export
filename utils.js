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
    const extension = fileUrl.split('.').pop().toLowerCase();
    if (IMAGE_EXTENSIONS.indexOf(extension) > -1) return 'image';
    if (VIDEOS_EXTESION.indexOf(extension) > -1) return 'video';
    if (GIF_EXTESIONS.indexOf(extension) > -1) return 'gif';
    return 'unknown';
  },

  getVideoFramerate(videoUrl, callback) {
    exec(`ffprobe -v 0 -of csv=p=0 -select_streams 0 -show_entries stream=r_frame_rate ${videoUrl}`, (err, stdout, stderr) => {
      if (err) {
        return callback(err);
      }
      if (stderr) {
        return callback(stderr);
      }
      const frameParts = stdout.split('/');
      return callback(null, Math.ceil(parseInt(frameParts[0]/parseInt(frameParts[1]))));
    })

  },

  getVideoDimentions(videoUrl, callback) {
    exec(`ffprobe -v error -show_entries stream=width,height -of csv=p=0:s=x ${videoUrl}`, (err, stdout, stderr) => {
      if (err) {
        return callback(err);
      }
      if (stderr) {
        return callback(stderr);
      }
      return callback(null, stdout.replace(/\n/g, ''));
    })

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
    }, (err, res) => {
      if (err) {
        return callback(err);
      }
      const url = `https://s3-${REGION}.amazonaws.com/${BUCKET_NAME}/${fileName}`;

      return callback(null, {url, ETag: res.ETag});
    })
  },
  generateSubtitle(text, audio, callback) {
    module.exports.getRemoteFileDuration(audio, (err, duration) => {
      const subtitleName = parseInt(Date.now() + Math.random() * 100000) + '-sub.srt';
      const subtitle = `1\n00:00:00,000 --> 00:00:${duration}\n${text}`;
      fs.writeFile(`${subtitleName}`, subtitle, (err, done) => {
        if (err) {
          return callback(err);
        }
        return callback(null, subtitleName);
      })
    })
  }
}
