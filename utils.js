const fs = require('fs');
const path = require('path');
const request = require('request');
const mp3Duration = require('mp3-duration');
const { exec } = require('child_process');
const AWS = require('aws-sdk');
const wikijs = require('wikijs').default;
const cheerio = require('cheerio');

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

function normalizeTitle(title) {
  return decodeURI(title.replace(new RegExp('%2C', 'g'), ','));
}

function getOriginalCommonsUrl(thumbnailPath) {
  if (!thumbnailPath) return null

    // Check if it's a thumbnail image or not (can be a video/gif)
    if (thumbnailPath.indexOf('thumb') > -1 ) {
      const re = /(upload\.wikimedia\.org).*(commons\/thumb\/.*\/.*\/)/
      const match = thumbnailPath.match(re)
      if (match && match.length === 3) {
        const pathParts = match[2].split('/')
        // Remove trailing / character
        pathParts.pop()
        return normalizeTitle(pathParts[pathParts.length - 1]);
        // return `https://commons.wikimedia.org/wiki/File:${pathParts[pathParts.length - 1]}`;
      }
    } else {
      const re = /(upload\.wikimedia\.org).*(commons\/.*\/.*)/
      const match = thumbnailPath.match(re)
      if (match && match.length === 3) {
        const pathParts = match[2].split('/')
        return normalizeTitle(pathParts[pathParts.length - 1]);
        // return `https://commons.wikimedia.org/wiki/File:${pathParts[pathParts.length - 1]}`;
      }
    }

    return null
}

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
      ContentDisposition: 'attachement',
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
  },
  getMediaInfo(url, callback) {
    const filePageTitle = getOriginalCommonsUrl(url);
    if (!filePageTitle) {
      setTimeout(() => {
        return callback(new Error(`Invalid url ${url}`), null);
      }, 100);
    } else {

      wikijs({
        apiUrl: 'https://commons.wikimedia.org/w/api.php',
        origin: null
      })
      // .page('File:Match_Cup_Norway_2018_88.jpg')
      .page(`File:${filePageTitle}`)
      .then(page => page.html())
      .then(pageHtml => {
        if (pageHtml) {
          const $ = cheerio.load(pageHtml);
          // First we get the licence info
          let licence = $('.licensetpl').find('.licensetpl_short').first().text();
          if (licence) {
            licence = licence.trim();
          }
          // Now we get the Author
          let author = '';
          let authorWrapper = $('#fileinfotpl_aut').first().next();
          if (authorWrapper.children().length > 1) {
            author = authorWrapper.find('#creator').text();
            if (!author) {
              author = authorWrapper.text();
            }
          } else {
            author = authorWrapper.text();
          }
          if (author) {
            author = author.trim().replace('User:', '');
          }

          return callback(null, { author, licence });
        } else {
          return callback(null, null);
        }
      })
      .catch(err => callback(err));
    }
  }
}

// // console.log(wikijs)
// module.exports.getMediaInfo('https://upload.wikimedia.org/wikipedia/commons/1/1d/Black-Hole-devouring-a-neutron-star-artist-animation-2x.webm', (err, result) => {
//   console.log(err, result);
// })

// module.exports.getMediaInfo('https://upload.wikimedia.org/wikipedia/commons/a/ac/Katherine_Maher_Introduction_and_previous_work_experience_slide.webm', (err, result) => {
//   console.log(err, result);
// })


// module.exports.getMediaInfo('https://upload.wikimedia.org/wikipedia/commons/f/f4/Einstein_rings_zoom_web.gif', (err, result) => {
//   console.log(err, result);
// })

