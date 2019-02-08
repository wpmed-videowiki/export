const fs = require('fs');
const path = require('path');
const request = require('request');
const mp3Duration = require('mp3-duration');
const { exec } = require('child_process');
const AWS = require('aws-sdk');
const wikijs = require('wikijs').default;
const cheerio = require('cheerio');
const ejs = require('ejs');
const webshot = require('webshot');
const lodash = require('lodash');
const async = require('async');

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

function getFileType(fileUrl) {
  const extension = fileUrl.split('.').pop().toLowerCase();
  if (IMAGE_EXTENSIONS.indexOf(extension) > -1) return 'image';
  if (VIDEOS_EXTESION.indexOf(extension) > -1) return 'video';
  if (GIF_EXTESIONS.indexOf(extension) > -1) return 'gif';
  return 'unknown';
}

function getVideoFramerate(videoUrl, callback) {
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

}

function getVideoDimentions(videoUrl, callback) {
  exec(`ffprobe -v error -show_entries stream=width,height -of csv=p=0:s=x ${videoUrl}`, (err, stdout, stderr) => {
    if (err) {
      return callback(err);
    }
    if (stderr) {
      return callback(stderr);
    }
    return callback(null, stdout.replace(/\n/g, ''));
  })

}

function getRemoteFileDuration(url, callback) {
  exec(`ffprobe -i ${url} -show_entries format=duration -v quiet -of csv="p=0"`, (err, stdout, stderr) => {
    if (err) {
      return callback(err);
    }
    if (stderr) {
      return callback(stderr);
    }
    return callback(null, parseFloat(stdout.replace('\\n', '')))
  })

}

function getFilesDuration(urls, callback) {
  const getFilesDurationFuncArray = [];
  urls.forEach(url => {
    function getFileDuration(cb) {
      getRemoteFileDuration(url, (err, duration) => {
        if (err) {
          console.log(err);
          return cb();
        }
        return cb(null, duration);
      });
    }

    getFilesDurationFuncArray.push(getFileDuration);
  })

  async.parallelLimit(getFilesDurationFuncArray, 3, (err, results) => {
    if (err) {
      return callback(err);
    }
    if (!results || results.length === 0) return callback(null, 0);

    const duration = results.reduce((acc, d) => acc + parseFloat(d), 0);
    return callback(null, duration);
  })
}

function getRemoteFile(url, callback) {
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

function uploadVideoToS3(filePath, callback) {
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
}

function generateSubtitle(text, audio, callback) {
  getRemoteFileDuration(audio, (err, duration) => {
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

function getMediaInfo(url, callback) {
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



function getReferencesImage(title, wikiSource, references, callback) {
  const refArray = Object.keys(references).sort((a, b) => parseInt(a)-parseInt(b)).map(ref => ({ referenceNumber: ref, html: references[ref], links: [] }) );

  if (refArray.length === 0) return callback(null, []);

  refArray.forEach(item => {
    $ = cheerio.load(`<div>${item.html}</div>`);
    
    $('a').each(function(index, el) {
      const link = $(this);
      link.attr('target', '_blank');
      if (link.attr('href') && (link.attr('href').indexOf('https') === -1 && link.attr('href').indexOf('http') === -1 )) {
        if (link.attr('href').indexOf('#') === 0) {
          link.attr('href', `${wikiSource}/wiki/${title}${link.attr('href')}`);
        } else {
          link.attr('href', `${wikiSource}${link.attr('href')}`);
        }
      }
      // Dont include self referencing links
      if (link.attr('href').indexOf(`${wikiSource}/wiki/${title}`) === -1) {
        item.links.push(link.attr('href'));
      }
    })
  })
  let refChunks = lodash.chunk(refArray, 5);
  let start = 1;
  let renderRefsFuncArray = []
  refChunks.forEach((chunk, index) => {
    function renderRefs(cb) {
      ejs.renderFile(path.join(__dirname, 'templates', 'references.ejs'), { references: chunk, start }, {escape: (item) => item }, (err, html) => {
        if (err) return cb(err);
        const imageName = path.join(__dirname, 'tmp' , `image-${index}-${Date.now()}${parseInt(Math.random() * 10000)}.jpeg`);
        webshot(html, imageName, { siteType: 'html', defaultWhiteBackground: true, shotSize: { width: 'window', height: 'all'} }, function(err) {
          if (err) return cb(err);
          start += chunk.length;
          cb(null, { image: imageName, index })
        });
      });
    }
    renderRefsFuncArray.push(renderRefs);
  })

  async.series(renderRefsFuncArray, (err, result) => {
    console.log('done', err, result);
    if (err) return callback(err);
    return callback(null, result);
  })
}

function getCreditsImages(title, wikiSource, callback = () => {}) {
  // console.log(`${wikiSource}/w/api.php?action=query&format=json&prop=contributors&titles=${title}&redirects`)
  request.get(`${wikiSource}/w/api.php?action=query&format=json&prop=contributors&titles=${title}&redirects`, (err, data) => {
    if (err) {
      console.log(err);
      return callback(err);
    }
    try {
      const body = JSON.parse(data.body);
      let contributors = [];
      Object.keys(body.query.pages).forEach(pageId => {
        contributors = contributors.concat(body.query.pages[pageId].contributors);
      })

      if (contributors.length == 0) return callback(null, []);
      contributors = contributors.map((con) => con.name);

      let renderContribFuncArray = [];
      let start = 1;
      const contributorsChunks = lodash.chunk(contributors, 16);
      contributorsChunks.forEach((chunk, index) => {
        function renderContrib(cb) {
          ejs.renderFile(path.join(__dirname, 'templates', 'users_credits.ejs'), { usersChunk: lodash.chunk(chunk, 8), start }, {escape: (item) => item }, (err, html) => {
            const imageName = path.join(__dirname, 'tmp' , `image-${index}-${Date.now()}${parseInt(Math.random() * 10000)}.jpeg`);
            webshot(html, imageName, { siteType: 'html', defaultWhiteBackground: true, shotSize: { width: 'all', height: 'all'},  windowSize: { width: 1311
              , height: 620 } }, function(err) {
              start += chunk.length;
              cb(null, { image: imageName, index })
            });
          });
        }
        renderContribFuncArray.push(renderContrib);
      })

      async.series(renderContribFuncArray, (err, result) => {
        return callback(null, result);
      })
    } catch(e) {
      console.log(e);
      return callback(e);
    }
  })
}

function generateReferencesVideos(title, wikiSource, references, { onProgress, onEnd }) {
  getReferencesImage(title, wikiSource, references, (err, images) => {
    if (err) return onEnd(err);
    if (!images || images.length === 0) return onEnd(null, []);

    const refFuncArray = [];
    let doneCount = 0;
    images.forEach((image, index) => {
      function refVid(cb) {
        const videoName = `videos/refvid-${index}-${Date.now()}${parseInt(Math.random() * 10000)}.webm`;
        exec(`ffmpeg -loop 1 -i ${image.image} -c:v libvpx-vp9 -t 2 -f lavfi -i anullsrc=channel_layout=5.1:sample_rate=48000 -t 2 -pix_fmt yuv420p  -filter_complex "[0:v]scale=w=800:h=600,setsar=1:1,setdar=16:9,pad=800:600:(ow-iw)/2:(oh-ih)/2" ${videoName}`, (err, stdout, stderr) => {
          console.log(err, stdout, stderr);
          fs.unlink(image.image, () => {});
          doneCount ++;
          onProgress(doneCount / images.length * 100);
          cb(null, { fileName: videoName, index, silent: true });
        })
      }
      refFuncArray.push(refVid);
    })

    async.parallelLimit(refFuncArray, 2, (err, result) => {
      console.log(err, result);
      if (err) {
        return onEnd(err);
      }
      return onEnd(null, result);
    })
  })
}


function generateCreditsVideos(title, wikiSource, callback) {
  getCreditsImages(title, wikiSource, (err, images) => {
    if (err) return callback(err);
    if (!images || images.length === 0) return callback(null, []);

    const refFuncArray = [];
    images.forEach((image, index) => {
      function refVid(cb) {
        const videoName = `videos/refvid-${index}-${Date.now()}${parseInt(Math.random() * 10000)}.webm`;
        exec(`ffmpeg -loop 1 -i ${image.image} -c:v libvpx-vp9 -t 2 -f lavfi -i anullsrc=channel_layout=5.1:sample_rate=48000 -t 2 -pix_fmt yuv420p  -filter_complex "[0:v]scale=w=800:h=600,setsar=1:1,setdar=16:9,pad=800:600:(ow-iw)/2:(oh-ih)/2" ${videoName}`, (err, stdout, stderr) => {
          console.log(err, stdout, stderr);
          fs.unlink(image.image, () => {})
          cb(null, { fileName: videoName, index, silent: true });
        })
      }
      refFuncArray.push(refVid);
    })

    async.series(refFuncArray, (err, result) => {
      console.log(err, result);
      if (err) {
        return callback(err);
      }
      return callback(null, result);
    })
  })
}

// function generateShareVideo(callback) {
//   const videoName = `videos/refvid-${Date.now()}${parseInt(Math.random() * 10000)}.webm`;
//   exec(`ffmpeg -loop 1 -i cc_video_share.png -c:v libvpx-vp9 -t 2 -f lavfi -i anullsrc=channel_layout=5.1:sample_rate=48000 -t 2 -pix_fmt yuv420p  -filter_complex "[0:v]scale=w=800:h=600,setsar=1:1,setdar=16:9,pad=800:600:(ow-iw)/2:(oh-ih)/2" ${videoName}`, (err, stdout, stderr) => {
//     console.log(err, stdout, stderr);
//     fs.unlink(image.image, () => {})
//     cb(null, { fileName: videoName, index, silent: true });
//   })
// }

// getCreditsImages('Elon_Musk', 'https://en.wikipedia.org', (err, images) => {
//   console.log(err, images)
// })

module.exports = {
  getMediaInfo,
  generateSubtitle,
  uploadVideoToS3,
  getRemoteFile,
  getFilesDuration,
  getRemoteFileDuration,
  getVideoDimentions,
  getVideoFramerate,
  getFileType,
  getReferencesImage,
  getOriginalCommonsUrl,
  generateReferencesVideos,
  generateCreditsVideos,
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


// webshot('<html><body>Hello World</body></html>', 'hello_world.png', {siteType:'html'}, function(err) {
//   // screenshot now saved to hello_world.png
// });