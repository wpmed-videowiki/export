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

const IMAGE_EXTENSIONS = ['jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp', 'jif', 'jfif', 'jp2','jpx','j2k', 'j2c', 'fpx', 'pcd'];
const VIDEOS_EXTESION = ['webm', 'mp4', 'ogg', 'ogv'];
const GIF_EXTESIONS = ['gif'];
const constants = require('./constants');
const commandBuilder = require('./commandBuilder');

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

function getFileDimentions(videoUrl, callback) {
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

function getVideoNumberOfFrames(url, callback) {
  getRemoteFileDuration(url, (err, duration) => {
    if (err) return callback(err);
    getVideoFramerate(url, (err, frameRate) => {
      if (err) return callback(err);
      return callback(null, { frames: Math.ceil(duration * frameRate), frameRate, duration });
    })
  })
}

function downloadMediaFile(url, destination, callback = () => {}) {
  exec(`curl ${url} --output ${destination}`, (err, stdout, stderr) => {
    if (err) {
      return callback(err);
    }
    // ffmpeg emits warn messages on stderr, omit it and check if the file exists
    if (!fs.existsSync(destination)) {
      return callback(new Error('Failed to download file'));
    }
    return callback(null, destination);
  })
}

function shouldMediaFileScale(file, callback) {
  getFileDimentions(file, (err, dimentions) => {
    if (err && !dimentions) {
      return callback(null, false);
    }
    try {
      const [width, height] = dimentions.split('x');
      if (parseInt(width) > constants.VIDEO_WIDTH && parseInt(height) > constants.VIDEO_HEIGHT) {
        return callback(null, 'both');
      } else if (parseInt(width) > constants.VIDEO_WIDTH) {
       return callback(null, 'width'); 
      } else if (parseInt(height) > constants.VIDEO_HEIGHT) {
        return callback(null, 'height');
      } else {
        return callback(null, false);
      }
    } catch (error) {
      return callback(error);
    }
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

function uploadSubtitlesToS3(subtitles, callback) {
  const uploadSubtitlesFuncArray = [];
  Object.keys(subtitles).forEach(key => {
    function uploadSubtitle(cb) {
      const fileName = subtitles[key].split('/').pop();
     
      s3.putObject({
        Bucket: BUCKET_NAME,
        Key: fileName,
        Body: fs.createReadStream(subtitles[key]),
        ContentType: 'text/plain',
        ContentDisposition: 'attachement',
      }, (err, res) => {
        if (err) {
          return cb(err);
        }
        const url = `https://s3-${REGION}.amazonaws.com/${BUCKET_NAME}/${fileName}`;
        return cb(null, { [key]: url });
      })
    }
    uploadSubtitlesFuncArray.push(uploadSubtitle);
  })

  async.parallel(async.reflectAll(uploadSubtitlesFuncArray), (err, result) => {
    if (err) {
      return callback(err);
    }
    const subs = result.map(item => item.value).reduce((acc, item) => {
      acc[Object.keys(item)[0]] = item[Object.keys(item)[0]]
      return acc;
    }, {})
    return callback(null, subs);
  })
}

function deleteVideoFromS3(key, callback = () => {}) {
  s3.deleteObject({
    Key: key,
    Bucket: BUCKET_NAME,
  }, (err, result) => {
    if (err) return callback(err);
    return callback(null, result);
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
          author = author.trim().replace('User:', '').replace(/\:/g, '').replace(/\n/g, ', ');
        }

        getMediaLicenseCode(url, (err, licenseCode) => {
          if (err) {
            console.log('error getting licence code');
          }

          return callback(null, { author, licence, licenseCode, fileName: getFileNameFromThumb(url) });
        })
      } else {
        return callback(null, null);
      }
    })
    .catch(err => callback(err));
  }
}



function getMediaLicenseCode(url, callback) {
  const filePageTitle = getOriginalCommonsUrl(url);
  if (!filePageTitle) {
    setTimeout(() => {
      return callback(new Error(`Invalid url ${url}`), null);
    }, 100);
  } else {
    const infoUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=File:${encodeURIComponent(filePageTitle)}&redirects&prop=cirrusdoc&format=json&formatversion=2`;
    request.get(infoUrl, (err, res) => {
      if (err) return callback(err);
      let licence = '';
      const body = JSON.parse(res.body);
      try {
        if (body.query && body.query.pages && body.query.pages.length > 0 ) {
          const { cirrusdoc } = body.query.pages[0];
          const { source_text } = cirrusdoc[0].source;
          if (source_text) {
            let licencePart = source_text.split(/==(\s)*{{int:license-header}}(\s)*==/i);
            if (licencePart.length > 1) {
              licencePart = licencePart.pop().trim().match(/{{(.+)}}/);
              if (licencePart.length >= 2) {
                licence = licencePart[1];
              }
            } else {
              licence = '';
            } 
          } else {
            return callback(new Error('No info available'));
          }
        }
      } catch(e) {
        return callback(e);
      }
      return callback(null, licence);
    })
  }
}


function getReferencesImage(title, wikiSource, references, translationText, callback) {
  if (!references) {
    setTimeout(() => {
      return callback(null, []);
    });
  } else {
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
        // Dont include self referencing links within Wikimedia
        if (link.attr('href').indexOf(`/wiki/`) === -1) {
          item.links.push(link.attr('href'));
        }
      })
    })
    let refChunks = lodash.chunk(refArray, 5);
    let start = 1;
    let renderRefsFuncArray = []
    refChunks.forEach((chunk, index) => {
      function renderRefs(cb) {
        ejs.renderFile(path.join(__dirname, 'templates', 'references.ejs'),
          { references: chunk, start, referencesText: translationText && translationText.references ? translationText.references : 'References' }, 
          { escape: (item) => item }, 
          (err, html) => {
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
      if (err) return callback(err);
      return callback(null, result);
    })
  
  }
}

function getCreditsImages({ title, wikiSource, wikiRevisionId }, extraUsers = [], translationText = {}, callback = () => {}) {
  // console.log(`${wikiSource}/w/api.php?action=query&format=json&prop=contributors&titles=${title}&redirects`)
  request.get(`${wikiSource}/w/api.php?action=query&format=json&prop=contributors&titles=${encodeURIComponent(title)}&redirects`, (err, data) => {
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
      
      contributors = contributors.map((con) => con.name);
      contributors = contributors.concat(extraUsers)

      if (contributors.length == 0) return callback(null, []);
      
      let renderContribFuncArray = [];
      let start = 1;
      const contributorsChunks = lodash.chunk(contributors, 16);
      const usersRef = wikiRevisionId ? `${wikiSource}/w/index.php?title=${title}&oldid=${wikiRevisionId}` : `${wikiSource}/wiki/${title}`;
      contributorsChunks.forEach((chunk, index) => {
        function renderContrib(cb) {
          ejs.renderFile(path.join(__dirname, 'templates', 'users_credits.ejs'),
            { usersChunk: lodash.chunk(chunk, 8), start, usersRef, textCredits: translationText && translationText.text_credits ? translationText.text_credits : 'Text Credits' }, 
            { escape: (item) => item },
            (err, html) => {
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

function generateReferencesVideos(title, wikiSource, references, translationText, { onProgress, onEnd }) {
  getReferencesImage(title, wikiSource, references, translationText, (err, images) => {
    if (err) return onEnd(err);
    if (!images || images.length === 0) return onEnd(null, []);

    const refFuncArray = [];
    let doneCount = 0;
    images.forEach((image, index) => {
      function refVid(cb) {
        const videoName = `videos/refvid-${index}-${Date.now()}${parseInt(Math.random() * 10000)}.webm`;
        convertImageToSilentVideo(image.image, 2, false, videoName, (err) => {
          fs.unlink(image.image, () => {});
          doneCount ++;
          onProgress(doneCount / images.length * 100);
          cb(null, { fileName: videoName, index, silent: true });
        })
      }
      refFuncArray.push(refVid);
    })

    async.parallelLimit(refFuncArray, 2, (err, result) => {
      console.log(err);
      if (err) {
        return onEnd(err);
      }
      return onEnd(null, result);
    })
  })
}


function generateCreditsVideos(article, { extraUsers, humanvoice, user, translationText }, callback) {
  getCreditsImages(article, extraUsers, translationText, (err, images) => {
    if (err) return callback(err);
    const refFuncArray = [];

    refFuncArray.push(function(cb) {
      generateCCShareImage({translationText}, (err, imageInfo) => {
        if (err) {
          return cb(null)
        }

        const videoName = path.join(__dirname, 'tmp' , `video-cc-share-${Date.now()}${parseInt(Math.random() * 10000)}.webm`);
        convertImageToSilentVideo(imageInfo.image, 2, false, videoName, (err) => {
          fs.unlink(imageInfo.image, () => {});
          if (err) {
            return cb(err);
          }
          return cb(null, { fileName: videoName, index: 0, silent: true })
        })
      });
    })

    if (images || images.length !== 0) {
      images.forEach((image, index) => {
        function refVid(cb) {
          const videoName = `videos/refvid-${index}-${Date.now()}${parseInt(Math.random() * 10000)}.webm`;
          convertImageToSilentVideo(image.image, 2, false, videoName, (err) => {
            fs.unlink(image.image, () => {})
            if (err) {
              return cb(err);
            }
            return cb(null, { fileName: videoName, index, silent: true });
          })
        }
        refFuncArray.push(refVid);
      })      
    }

    // Add audio by if it has human voice
    if (humanvoice && user) {
      refFuncArray.push(function(cb) {
        generateAudioByImage({username: user.username, voiceBy: translationText && translationText.voice_by ?translationText.voice_by : 'Voice by:'}, (err, imageInfo) => {
          if (err) {
            return cb(err)
          }
          const videoName = path.join(__dirname, 'tmp' , `video-audio-by-${Date.now()}${parseInt(Math.random() * 10000)}.webm`);
          convertImageToSilentVideo(imageInfo.image, 2, false, videoName, (err) => {
            fs.unlink(imageInfo.image, () => {});
            if (err) {
              return cb(err);
            }
            return cb(null, { fileName: videoName, index: images && images.length > 0 ? images.length : 1, silent: true })
          })
        })
      });
    }
    async.series(refFuncArray, (err, result) => {
      console.log(err);
      if (err) {
        return callback(err);
      }
      return callback(null, result);
    })
  })
}

function checkMediaFileExists(fileUrl, callback = () => {}) {
  request.get(fileUrl, (err, res) => {
    if (err) return callback(err);
    if (res && res.statusCode !== 200) return callback(new Error('Invalid file'));
    return callback(null, true);
  })
}

function generateCCShareImage({ translationText }, callback) {
  ejs.renderFile(path.join(__dirname, 'templates', 'licence.ejs'),
    { licence: translationText && translationText.licence ? translationText.licence : "You're free to share + adapt this video under CC-BY-SA 4.0" , }, 
    { escape: (item) => item },
    (err, html) => {
      const imageName = path.join(__dirname, 'tmp' , `cc-share-${Date.now()}${parseInt(Math.random() * 10000)}.jpeg`);
      webshot(html, imageName, { siteType: 'html', defaultWhiteBackground: true, shotSize: { width: 'all', height: 'all'},  windowSize: { width: 1311
        , height: 620 } }, function(err) {
          if (err) {
            return callback(err);
          }
          return callback(null, { image: imageName })
      });
  });
}

function generateAudioByImage({ username, voiceBy }, callback) {
  ejs.renderFile(path.join(__dirname, 'templates', 'audio_by.ejs'),
    { username, voiceBy }, 
    { escape: (item) => item },
    (err, html) => {
      const imageName = path.join(__dirname, 'tmp' , `image-audio-by-${Date.now()}${parseInt(Math.random() * 10000)}.jpeg`);
      webshot(html, imageName, { siteType: 'html', defaultWhiteBackground: true, shotSize: { width: 'all', height: 'all'},  windowSize: { width: 1311
        , height: 620 } }, function(err) {
          if (err) {
            return callback(err);
          }
          return callback(null, { image: imageName })
      });
  });
}

function convertImageToSilentVideo(image, duration, shouldOverlayWhiteBackground, outputPath, callback = () => {}) {
  shouldMediaFileScale(image, (err, scale) => {
    if (err) {
      console.log('error in should scale', err);
      scale = false;
    }
    getFileDimentions(image, (err, dimentions) => {
      if (err) {
        console.log('error getting dimentions', err);
        dimentions = `${constants.VIDEO_WIDTH}x${constants.VIDEO_HEIGHT}`;
      }
      const command = commandBuilder.generateImageToVideoCommand({ imagePath: image, silent: true, scale: 'both', shouldOverlayWhiteBackground: true, dimentions, outputPath, duration })
      exec(command, (err, stdout, stderr) => {
        if (err) {
          return callback(err);
        }
        if (!fs.existsSync(outputPath)) {
          return callback(new Error('Something went wrong'));
        }
        return callback(null, outputPath);
      })
    })
  })
}

function getFileNameFromThumb (thumbnailPath) {

  if (!thumbnailPath) return null

  // Check if it's a thumbnail image or not (can be a video/gif)
  if (thumbnailPath.indexOf('thumb') > -1 ) {
    const re = /(upload\.wikimedia\.org).*(commons\/thumb\/.*\/.*\/)/
    const match = thumbnailPath.match(re)
    if (match && match.length === 3) {
      const pathParts = match[2].split('/')
      // Remove trailing / character
      pathParts.pop()
      return pathParts[pathParts.length - 1];
    }
  } else {
    const re = /(upload\.wikimedia\.org).*(commons\/.*\/.*)/
    const match = thumbnailPath.match(re)
    if (match && match.length === 3) {
      const pathParts = match[2].split('/')
      return pathParts[pathParts.length - 1];
    }
  }

  return null
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
  getFileDimentions,
  getVideoFramerate,
  getFileType,
  downloadMediaFile,
  getReferencesImage,
  getOriginalCommonsUrl,
  generateReferencesVideos,
  generateCreditsVideos,
  checkMediaFileExists,
  uploadSubtitlesToS3,
  deleteVideoFromS3,
  getVideoNumberOfFrames,
  shouldMediaFileScale,
}

// // console.log(wikijs)
// module.exports.getMediaInfo('https://upload.wikimedia.org/wikipedia/commons/thumb/1/12/Salmonella_typhi_typhoid_fever_PHIL_2215_lores.jpg/400px-Salmonella_typhi_typhoid_fever_PHIL_2215_lores.jpg', (err, result) => {
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
