require('dotenv').config({path: '.env'});

const args = process.argv.slice(2);
const lang = args[0];
console.log('lang is', lang)
const amqp = require('amqplib/callback_api');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const async = require('async');
const mongoose = require('mongoose');
const cheerio = require('cheerio');

// Check if the necessary directories exist
const APP_DIRS = ['./tmp', './videos', './final'];

// Create necessary file dirs
APP_DIRS.forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
});

fs.readdirSync(path.join(__dirname, 'tmp')).forEach((entry) => {
  if (entry.startsWith(`export-${lang}-`)) {
    console.log('removing leftover export workspace', entry);
    fs.rmSync(path.join(__dirname, 'tmp', entry), { recursive: true, force: true });
  }
});

const {
  imageToSilentVideo,
  videoToSilentVideo,
  gifToSilentVideo,
  combineVideos,
  slowVideoRate,
  wavToWebm,
  addFadeEffects,
  addFadeInEffect,
  addFadeOutEffect,
  addAudioToVideo,
  extractAudioFromVideo,
  generateSilentAudio,
  combineAudios,
}  = require('./converter');
const utils = require('./utils');
const subtitles = require('./subtitles');
const { DEFAUL_IMAGE_URL, SLIDE_CONVERT_PER_TIME, FADE_EFFECT_DURATION, VIDEO_WIDTH, CUSTOM_TEMPLATES } = require('./constants');

const UserModel = require('./models/User');
const ArticleModel = require('./models/Article');
const VideoModel = require('./models/Video');
const HumanVoiceModel = require('./models/HumanVoice');


const DELETE_AWS_VIDEO = 'DELETE_AWS_VIDEO';
const CONVERT_QUEUE = `CONVERT_ARTICLE_QUEUE_${lang}`;
const UPDLOAD_CONVERTED_TO_COMMONS_QUEUE = `UPDLOAD_CONVERTED_TO_COMMONS_QUEUE_${lang}`;


const dbConnectionParts = process.env.DB_HOST_URL.split('?');
const DB_CONNECTION = `${dbConnectionParts[0]}-${lang}?${dbConnectionParts[1] || ''}`;

// const DB_CONNECTION = 'mongodb://localhost/videowiki-en'
mongoose.connect(DB_CONNECTION)
let convertChannel;
amqp.connect(process.env.RABBITMQ_HOST_URL, (err, conn) => {
  console.log('error is', err);
  conn.createChannel((err, ch) => {
    convertChannel = ch;
    convertChannel.prefetch(1);
    console.log('connection created')
    convertChannel.assertQueue(CONVERT_QUEUE, {durable: true}, (err, ok) => {
      console.log('queue assert', err, ok)
    })
    convertChannel.assertQueue(UPDLOAD_CONVERTED_TO_COMMONS_QUEUE, { durable: true });
    convertChannel.assertQueue(DELETE_AWS_VIDEO, { durable: true });

    convertChannel.consume(DELETE_AWS_VIDEO, deleteAWSVideoCallback);
    convertChannel.consume(CONVERT_QUEUE, convertQueueCallback, { noAck: false });
  })
})

function convertQueueCallback(msg) {
  const { videoId } = JSON.parse(msg.content.toString());
  // All temp files of this export (downloads, intermediates, final video) live
  // in one workspace dir, removed as a whole on every terminal path
  const exportDir = path.join(__dirname, 'tmp', `export-${lang}-${videoId}-${Date.now()}`);
  fs.mkdirSync(exportDir, { recursive: true });
  const removeExportDir = () => fs.rm(exportDir, { recursive: true, force: true }, () => {});

  VideoModel
  .findById(videoId)
  .populate('humanvoice')
  .populate('user')
  .exec().then((video) => {
    if (!video) {
      console.log('invalid video id');
      updateStatus(videoId, 'failed');
      removeExportDir();
      return convertChannel.ack(msg);
    }
    console.log('video is ', video);
    ArticleModel.findOne({title: video.title, wikiSource: video.wikiSource, published: true}).then((article) => {
      console.log('converting article ', article.title)

      // Update status
      updateStatus(videoId, 'progress');
      convertArticle({ article, video, videoId, withSubtitles: video.withSubtitles, exportDir }, (err, convertResult) => {
        console.log('convert rsult is ', convertResult)
        if (err) {
          updateStatus(videoId, 'failed');
          console.log(err);
          removeExportDir();
          return convertChannel.ack(msg);
        }
        utils.uploadVideoToS3(convertResult.videoPath, (err, uploadVideoResult) => {

          if (err) {
            console.log('error uploading file', err);
            updateStatus(videoId, 'failed');
            removeExportDir();
            return convertChannel.ack(msg);
          }
          const { url, ETag } = uploadVideoResult;
          let videoUpdate = {
            url,
            ETag,
            status: 'converted',
            wrapupVideoProgress: 100,
          }
          // console.log('converted at ', url)
          if (convertResult.subtitles) {
            // Upload generated subtitles to s3
            utils.uploadSubtitlesToS3(convertResult.subtitles, (err, uploadSubtitlesResult) => {
              if (err) {
                console.log('error uploading subtitles to s3', err);
              } else if (uploadSubtitlesResult && Object.keys(uploadSubtitlesResult).length > 0) {
                videoUpdate.commonsSubtitles = uploadSubtitlesResult.url;
                videoUpdate = {
                  ...videoUpdate,
                  ...uploadSubtitlesResult
                }
              }
              VideoModel.findByIdAndUpdate(videoId, { $set: videoUpdate }, { new: true }).then((result) => {
                console.log('Done!', result)
              })
              .catch(err => {
                if (err) {
                  updateStatus(videoId, 'failed');                  
                  console.log(err);
                }
              })
              .finally(() => {
                convertChannel.ack(msg);
                updateProgress(videoId, 100);
                convertChannel.sendToQueue(UPDLOAD_CONVERTED_TO_COMMONS_QUEUE, new Buffer(JSON.stringify({ videoId })), { persistent: true })
                // Cleanup
                removeExportDir();
              })
            })

          } else {

            VideoModel.findByIdAndUpdate(videoId, { $set: videoUpdate }, { new: true }).then((result) => {
              console.log('Done!', result);
            })
            .catch(err => {
              if (err) {
                updateStatus(videoId, 'failed');                  
                console.log(err);
              }
            })
            .finally(() => {
              convertChannel.ack(msg);
              updateProgress(videoId, 100);
              convertChannel.sendToQueue(UPDLOAD_CONVERTED_TO_COMMONS_QUEUE, new Buffer(JSON.stringify({ videoId })), { persistent: true })
              // Cleanup
              removeExportDir();
            })
          }
        })
      })
    })
    .catch(err => {
      updateStatus(videoId, 'failed');
      console.log('error fetching article ', err);
      removeExportDir();
      return convertChannel.ack(msg);
    })
  })
  .catch(err => {
    updateStatus(videoId, 'failed');
    console.log('error retrieving video', err);
    removeExportDir();
    return convertChannel.ack(msg);
  })

}

function deleteAWSVideoCallback(msg) {
  const { videoId } = JSON.parse(msg.content.toString());

  VideoModel.findById(videoId).then((video) => {
    if (!video) {
      console.log('invalid video id ', videoId);
      return;
    }

    if (video && video.url) {
      const fileName = video.url.split('/').pop();
      console.log('file name is ', fileName)
      utils.deleteVideoFromS3(fileName, (err, result) => {
        if (err) {
          console.log('Error deleting video from s3', err);
          return;
        }
        console.log('successfully delete video from s3', result);
        VideoModel.findByIdAndUpdate(videoId, { $unset: { url: true }}).then((result) => {
          console.log(result);
        })
        .catch(err => {
          console.log(err);
        })
      })
    }
  })
  .catch(err => {
    if (err) {
      console.log('error fetching video ', err, videoId);
      return;
    }
  })
}
const verifyMedia = (slide, mitem, exportDir) => (cb) => {
  console.log("Verify start", mitem)
  if (!mitem.url && !mitem.origianlUrl) {
    mitem.url = DEFAUL_IMAGE_URL;
    mitem.type = 'image';
    mitem.time = slide.duration;
    return cb();
  }
  let slideMediaUrl = mitem.origianlUrl || mitem.url;
  const tmpMediaName = path.join(exportDir, `downTmpMedia-${Date.now()}-${parseInt(Math.random() * 10000)}.${utils.getFileExtension(slideMediaUrl)}`);
  console.log('veirying', slideMediaUrl)

  if (slideMediaUrl.indexOf('400px-') !== -1) {
    slideMediaUrl = slideMediaUrl.replace('400px-', '800px-');
  }
  console.log('new slidemediaurl', slideMediaUrl)
  // Svg files are rendered as pngs
  // if (mitem.origianlUrl && mitem.origianlUrl.split('.').pop().toLowerCase() === 'svg') {
  //   slideMediaUrl = mitem.thumburl || mitem.url;
  // }
  utils.downloadMediaFile(slideMediaUrl, tmpMediaName, (err) => {
    if (err) {
      console.log(err);
      mitem.url = DEFAUL_IMAGE_URL;
      mitem.type = 'image';
      mitem.time = slide.duration;
      return cb();
    }
    mitem.tmpUrl = tmpMediaName;
    if (utils.getFileType(tmpMediaName) === 'image') {
      utils.getFileDimentions(tmpMediaName, (err, dimentions) => {
            if (err && !dimentions) {
              console.log('error getting dimentions', err);
            }
            // If the width is larger than the default video width get a thumbnail image instead
            const imageWidth = utils.resolveImageWidth(dimentions, mitem.width);
            if ((imageWidth > VIDEO_WIDTH && mitem.thumburl) || utils.getFileExtension(tmpMediaName) === 'svg') {
              const tmpThumbName = path.join(exportDir, `downTmpThumb-${Date.now()}-${parseInt(Math.random() * 10000)}.${utils.getFileExtension(mitem.thumburl)}`);
              utils.downloadMediaFile(mitem.thumburl, tmpThumbName, (err) => {
                if (err) {
                  return cb();
                }
                mitem.tmpUrl = tmpThumbName;
                return cb();
              })

            } else {
              return cb();
            }
      })
      
    } else {
      return cb();
    }
  })
}

const downloadSlideAudio = (slide, exportDir) => (cb) => {
  const tempAudioFile = path.join(exportDir, `downTmpAudio-${Date.now()}-${slide.audio.split('/').pop()}`);
  const audioUrl = slide.audio.indexOf('http') === -1 ? `https:${slide.audio}` : slide.audio;
  console.log('downloading', slide.audio)
  utils.downloadMediaFile(audioUrl, tempAudioFile, (err) => {
    if (!err) {
      slide.tmpAudio = tempAudioFile;
      const audioExt = tempAudioFile.split('.').pop();
      // If the file extension is wav, convert it to webm for consistent encoding
      if (audioExt !== 'wav') return cb();
      wavToWebm(slide.tmpAudio, `${slide.tmpAudio}.webm`, (err, newTmpPath) => {
        if (newTmpPath) {
          slide.tmpAudio = newTmpPath;
        }
        return cb();
      })
    } else {
      console.log('error downloading tmp audio', err);
      return cb();
    }
  })
}

const generateSlideAudioFromMedia = (slide, exportDir) => cb => {
  console.log('=========================== generateSlideAudioFromMedia ==============================')
  // loop over slide's media
  // if the media item is video, extract it's audio
  // if the media item is gif or image, generate silence audio with it's duration
  // concat all audios
  // cleanup tmp media audios
  // assign to slide.tmpAudio and cb()
  const generateMediaFuncArray = [];
  const mediaAudiosPaths = [];

  slide.media.forEach(mitem => {
    generateMediaFuncArray.push((cb) => {
      if (utils.getFileType(mitem.url) === 'video') {
        extractAudioFromVideo(mitem.url, exportDir, (err, audioPath) => {
          console.log(err)
          if (err) return cb(err);
          mediaAudiosPaths.push(audioPath);
          utils.getRemoteFileDuration(mitem.url, (err, duration) => {
            console.log(err)
            if (err) return cb(err);
            mitem.time = duration * 1000;
            cb()
          })
        })
      } else if (['image', 'gif'].indexOf(utils.getFileType(mitem.url))) {
        generateSilentAudio(5000, exportDir, (err, audioPath) => {
          console.log(err)
          if (err) return cb(err);
          mediaAudiosPaths.push(audioPath);
          mitem.time = 5000;
          cb();
        })
      } else {
        console.log('Invalid media type')
        return cb(new Error('Invalid media type' + mitem.url))
      }
    })
  })

  async.parallelLimit(generateMediaFuncArray, 1, (err) => {
    console.log(err)
    if (err) return cb(err);
    console.log('================= combining audios ============================')
    combineAudios(mediaAudiosPaths, exportDir, (err, audioPath) => {
     console.log(err) 
      if (err) return cb(err);
      mediaAudiosPaths.forEach(p => {
        fs.unlink(p, (err) => {
          if (err) {
            console.log(err);
          }
        })
      })
      slide.tmpAudio = audioPath;
      console.log('COMBINED AUDIO', audioPath, slide)
      return cb()
    })
  })
}

function convertArticle({ article, video, videoId, withSubtitles, exportDir }, callback) {
  const convertFuncArray = [];
  let progress = 0;
  // const slidesHtml = article.slidesHtml.slice().filter(slide => slide.text && slide.audio);
  const slidesHtml = article.slidesHtml.slice();
  const verifySlidesMediaFuncArray = [];

  const humanvoiceFuncArray = [];
  if (video.humanvoice && video.humanvoice.audios && video.humanvoice.audios.length > 0) {
    video.humanvoice.audios.forEach((audio) => {
      if (audio.position < slidesHtml.length) {
        humanvoiceFuncArray.push((cb) => {
          utils.getRemoteFileDuration(`https:${audio.audioURL}`, (err, duration) => {
            console.log('audio duration', audio)
            if (err) {
              console.log('error egtting duration', err);
            } else {
              audio.duration = duration * 1000;
            }
            // Set human voice audio and duration on normal slides
            const matchingSlide = slidesHtml.find(s => s.position === audio.position);
            matchingSlide.audio = audio.audioURL;
            matchingSlide.duration = audio.duration;
            // Set media timing
            if (!matchingSlide.media || matchingSlide.media.length === 0) {
              matchingSlide.media = [{
                url: DEFAUL_IMAGE_URL,
                type: 'image',
                time: audio.duration,
              }]
            } else if (matchingSlide.media.length === 1) {
              matchingSlide.media[0].time = audio.duration;
            } else {
              /*  we have two cases here
                  1- the medias are smaller than human voice audios
                    - in this case, we add the extra time to the last media item
                  2- the medias are longer than human voice audios
                    - in this case, we see the difference and remove it from 
                      the last media item if possible. if not, we set the timings
                      equally between all media items 
              */
              const totalMediaDuration = matchingSlide.media.reduce((acc, m) => m.time + acc, 0);
              const durationDifference = Math.abs(matchingSlide.duration - totalMediaDuration);
              if (matchingSlide.duration >= totalMediaDuration) {
                const durationDifference = matchingSlide.duration - totalMediaDuration;
                matchingSlide.media[matchingSlide.media.length - 1].time = matchingSlide.media[matchingSlide.media.length - 1].time + durationDifference;
              } else if (totalMediaDuration > matchingSlide.duration) {
                // check the last media item, if its duration - duration difference is more than 2 seconds,
                // just remove trim the duration to match the audio duration
                // otherwise, reset duration on all media items
                const lastMediaItem = matchingSlide.media[matchingSlide.media.length - 1];
                if ((lastMediaItem.time - durationDifference) >= 2000) {
                  lastMediaItem.time = lastMediaItem.time - durationDifference;
                } else {
                  matchingSlide.media.forEach((mitem) => {
                    mitem.time = matchingSlide.duration / matchingSlide.media.length;
                  })
                }
              }
            }
            return cb();
          })
        })
      }
    })
  }
  async.parallelLimit(humanvoiceFuncArray, 2, () => {

    slidesHtml.forEach(slide => {
      if (!slide.media || slide.media.length === 0) {
        slide.media = [{
          url: DEFAUL_IMAGE_URL,
          type: 'image',
          time: slide.duration,
        }];
      } else {
        slide.media.forEach((mitem) => {
          // if (process.env.NODE_ENV !== 'production') {
            verifySlidesMediaFuncArray.push(verifyMedia(slide, mitem, exportDir));
          // }
        })
      }
    })
    console.log('verifying media');
    async.parallelLimit(async.reflectAll(verifySlidesMediaFuncArray), 1, (err, result) => {
      if (err) {
        console.log('error verifying slides media');
      }
      // Download media and audio for local use
      const downAudioFuncArray = [];

      slidesHtml.forEach((slide) => {
        if (slide.audio) {
          downAudioFuncArray.push(downloadSlideAudio(slide, exportDir));
        } else {
          console.log('doesnt have audio, generating audio from media instead')
          downAudioFuncArray.push(generateSlideAudioFromMedia(slide, exportDir))
        }
      })
      console.log('downloading audios', slidesHtml.length, slidesHtml);

      async.parallelLimit(async.reflectAll(downAudioFuncArray), 2, (err, value) => {
        console.log('start time', new Date())
          if (err) {
          console.log('error fetching tmp medias', err);
        }

        let videoDerivatives = [];

        slidesHtml.sort((a,b) => a.position - b.position).forEach((slide, index) => {
          function convert(cb) {
            console.log('converting', slide.position)
            const audioUrl = slide.tmpAudio ? slide.tmpAudio : (slide.audio ? `https:${slide.audio}` : '');
            const convertCallback = (err, result) => {
              if (err) {
                console.log('error in async ', err);
                return cb(err);
              }
              // Clear tmp media and audio if exists
              if (slide.tmpAudio) {
                fs.unlink(slide.tmpAudio, () => {});
              }
              let { videoPath, videoDerivative } = result;
              if (videoDerivative) {
                videoDerivatives = videoDerivatives.concat(videoDerivative)
              }
              const finalizeSlideFunc = [];
              slide.video = videoPath;
              utils.getRemoteFileDuration(videoPath, (err, duration) => {
                // Add fade effect only to slides having at least 2 seconds of content
                // if (!err && Math.floor(duration) > 2) {
                //   finalizeSlideFunc.push((finalizeSlideCB) => {
                //     addFadeEffects(videoPath, FADE_EFFECT_DURATION, (err, fadedVideo) => {
                //       if (err) {
                //         console.log('error adding fade effects', err);
                //         slide.video = videoPath;
                //       } else if (fadedVideo && fs.existsSync(fadedVideo)) {
                //         fs.unlinkSync(videoPath);
                //         slide.video = fadedVideo;
                //       }
                //       finalizeSlideCB();
                //     })
                //   })
                // }
                finalizeSlideFunc.push((finalizeSlideCB) => {
                  progress += (1 / article.slides.length) * 100;
                  updateProgress(videoId, progress);
                  
                  console.log(`Progress ####### ${progress} ######`);
                  finalizeSlideCB();
                  return cb(null, {
                    fileName: slide.video,
                    index
                  });
                })
                async.series(finalizeSlideFunc, () => {});
              })
            }
            // End convert callback
            
            if (!slide.media) {
              slide.media = [{
                url: DEFAUL_IMAGE_URL,
                type: 'image',
              }];
            }
            convertMedias(slide.media, slide.templates, audioUrl, slide.position, video.translationText, exportDir, convertCallback);
          }
          
          convertFuncArray.push(convert);
        })
        
        async.parallelLimit(convertFuncArray, SLIDE_CONVERT_PER_TIME, (err, results) => {
          if (err) {
            VideoModel.findByIdAndUpdate(videoId, {$set: { status: 'failed' }}).then(() => {
            })
            .catch(err => {})
            return callback(err);
          }
          updateProgress(videoId, 100);

          // Set video derivatives to be put in the licence info
          VideoModel.findByIdAndUpdate(videoId, { $set: { derivatives: videoDerivatives } }).then(() => {
          })
          .catch(err => {
            if (err) {
              console.log('error saving video derivatives');
            }
          })

          results = results.sort((a, b) => a.index - b.index);
          // Generate the user credits slides
          utils.generateCreditsVideos(article, video, exportDir, (err, creditsVideos) => {
            if (err) {
              console.log('error creating credits videos', err);
            }
            // Generate the article references slides
            utils.generateReferencesVideos(article.title, article.wikiSource, article.referencesList, video.translationText, exportDir, {
              onProgress: (progress) => {
                if (progress && progress !== 'null') {
                  VideoModel.findByIdAndUpdate(videoId, {$set: { textReferencesProgress: progress }}).then((result) => {
                  })
                  .catch(err => {
                  })
                }
              },
              
              onEnd: (err, referencesVideos) => {
                // Considere progress done
                VideoModel.findByIdAndUpdate(videoId, {$set: { textReferencesProgress: 100 }}).then((result) => {
                }).catch(err => {})

                if (err) {
                  console.log('error creating references videos', err);
                }

                let finalVideos = [];
                if (results) {
                  finalVideos = finalVideos.concat(results);
                }
                // Add Share video (static shared asset, lives outside the export dir)
                finalVideos.push({ fileName: path.join(__dirname, 'cc_share.webm'), });
                if (creditsVideos && creditsVideos.length > 0) {
                  finalVideos = finalVideos.concat(creditsVideos);
                }
                if (referencesVideos && referencesVideos.length > 0) {
                  finalVideos = finalVideos.concat(referencesVideos);
                }
                
                combineVideos(finalVideos, false, {
                  dir: exportDir,
                  onProgress: (progress) => {
                    if (progress && progress !== 'null') {
                      VideoModel.findByIdAndUpdate(videoId, {$set: { combiningVideosProgress: progress }}).then(() => {
                      }).catch(err => {})
                    }
                  },
                  
                  onEnd: (err, videoPath) => {
                    if (err) {
                      console.log(err);
                      VideoModel.findByIdAndUpdate(videoId, {$set: { status: 'failed' }}).then(() => {
                      }).catch(err => {})
                      return callback(err);
                    }
                    
                    VideoModel.findByIdAndUpdate(videoId, {$set: { combiningVideosProgress: 100, wrapupVideoProgress: 20 }}).then(() => {
                    }).catch(err => {})
                    
                    const subtitledSlides = JSON.parse(JSON.stringify(slidesHtml));
                    // If we have human voice, use the user's translation as the subtitles
                    if (video.humanvoice && video.humanvoice.translatedSlides && video.lang !== article.lang) {
                      video.humanvoice.translatedSlides.forEach((slide) => {
                        if (subtitledSlides[slide.position]) {
                          subtitledSlides[slide.position].text = slide.text;
                        }
                      });
                    }
                    subtitles.generateSrtSubtitles(subtitledSlides, 1, exportDir, (err, subs) => {
                      const cbResult = { videoPath };
                      if (err) {
                        console.log('error generating subtitles file', err);
                      }

                      if (subs) {
                        cbResult.subtitles = subs;
                      }
                      
                      VideoModel.findByIdAndUpdate(videoId, {$set: { wrapupVideoProgress: 70 }}).then(() => {
                      }).catch(err => {});
                      // Cleanup
                      slidesHtml.forEach(slide => {
                        if (slide.video && fs.existsSync(slide.video)) {
                          fs.unlink(slide.video, () => {});
                        }
                      })
                      
                      if (referencesVideos) {
                        referencesVideos.forEach(video => fs.existsSync(video.fileName) && fs.unlink(video.fileName, () => {}));
                      }
                      
                      if (creditsVideos) {
                        creditsVideos.forEach(video => fs.existsSync(video.fileName) && fs.unlink(video.fileName, () => {}));
                      }
                      console.log('end time', new Date())
                      return callback(null, cbResult);
                    })
                  }
                })
              }
            })
          })
        })
      })

    })
  })
}

function convertMedias(medias, templates, audio, slidePosition, translationText, exportDir, callback = () => {}) {
  const convertMediaFuncArray = [];
  let videoDerivative = [];
  const trimVideo = !(templates && templates.some(template => template.toLowerCase() === CUSTOM_TEMPLATES.PLAYALL.toLowerCase()));

  medias.forEach((mitem, index) => {
    convertMediaFuncArray.push((singleCB) => {
      const fileName = path.join(exportDir, `video-${parseInt(Date.now() + Math.random() * 100000)}.webm`);
      // mitem.url is swapped for the placeholder image when a download fails,
      // so credit has to be looked up against the source url we started from
      utils.getMediaInfo(mitem.origianlUrl || mitem.url, (err, info) => {
        let subtext = '';
        if (err) {
          console.log('error fetching media author and licence', err, medias);
        } else if (info){
          if (info.author) {
            subtext = `${translationText && translationText.visual_content_by ? translationText.visual_content_by : 'Visual Content by'} ${info.author}${info.licence ? ', ' : '.'}`
          }
          if (info.licence) {
            subtext += info.licence
          }
        }

        // Collect derivatives info
        if (info && info.author && info.licenseCode && info.fileName) {
          videoDerivative.push({
            fileName: info.fileName,
            author: info.author,
            licence: info.licenseCode,
            position: slidePosition,
          })
        }
        
        let slideMediaUrl = mitem.tmpUrl || mitem.origianlUrl || mitem.url;
        if (utils.getFileExtension(slideMediaUrl) === 'svg') {
          slideMediaUrl = mitem.thumburl || mitem.url;
          console.log("FOund SVG file", slideMediaUrl)
        }
        const convertSingleCallback = function convertSingleCallback(err, fileName) {
            console.log('After convert to silent', fileName)
            if (err) return singleCB(err);
            // Dont add extra fade effect for a single media item
            if (medias.length === 1) {
              return singleCB(null, { fileName, index });
            }
            return singleCB(null, { fileName, index })
            // Disbale fading for now
            // let fadeFunc
            // // Add fade in effect only to last media item
            // if (index === medias.length - 1) {
            //   fadeFunc = addFadeInEffect
            // } else if (index === 0) {
            //   // Add fade out effect only to first media item
            //   fadeFunc = addFadeOutEffect
            // } else {
            //   // In middle media's, add both fades
            //   fadeFunc = addFadeEffects
            // }
            // fadeFunc(fileName, FADE_EFFECT_DURATION, (err, fadedVideo) => {
            //   if (err) {
            //     return singleCB(null, { fileName, index })
            //   }
            //   return singleCB(null, { fileName: fadedVideo, index });
            // })
        }
        console.log('converting submedia', slideMediaUrl, subtext)
        if (utils.getFileType(mitem.url) === 'image') {
          utils.getFileDimentions(slideMediaUrl, (err, dimentions) => {
            if (err && !dimentions) {
              console.log('error getting dimentions', err);
            }
            // If the width is larger than the default video width
            // get a thumbnail image instead. slideMediaUrl may already be a
            // downscaled thumbnail here, so mitem.width does not apply
            const imageWidth = utils.resolveImageWidth(dimentions);
            if (imageWidth > VIDEO_WIDTH && mitem.thumburl) {
              slideMediaUrl = mitem.thumburl;
            }
            imageToSilentVideo({ image: slideMediaUrl, subtext, duration: mitem.time / 1000, outputPath: fileName }, convertSingleCallback);
          })
        } else if (utils.getFileType(mitem.url) === 'video') {
          let videoDuration = mitem.time / 1000
          if (!trimVideo) {
            videoDuration = mitem.duration
          }
          videoToSilentVideo({ video: slideMediaUrl, subtext, duration: videoDuration, outputPath: fileName }, convertSingleCallback);
        } else if (utils.getFileType(mitem.url) === 'gif') {
          gifToSilentVideo({ gif: slideMediaUrl, subtext, duration: mitem.time / 1000, outputPath: fileName}, convertSingleCallback);
        } else {
          return singleCB(new Error('Invalid file type'));
        }
      })
    })
  })

  async.parallelLimit(convertMediaFuncArray, SLIDE_CONVERT_PER_TIME, (err, outputInfo) => {
    if (err) return callback(err);
    const slideVideos = outputInfo.sort((a, b) => a.index - b.index);
    console.log('combining videos of submedia');
    const finalSlideVidPath = path.join(exportDir, `slide_with_audio-${Date.now()}-${parseInt(Math.random() * 100000)}.webm`)
    if (medias.length > 1) {
      combineVideos(slideVideos, true, {
        dir: exportDir,
        onEnd: (err, videoPath) => {
          if (err) return callback(err);
          return addAudioToVideo(videoPath, audio, finalSlideVidPath, { trimVideo }, (err, videoPath) => {
            if (err) return callback(err);
            return callback(null, { videoPath: finalSlideVidPath, videoDerivative });
          });
        },
      })
    } else {
      addAudioToVideo(slideVideos[0].fileName, audio, finalSlideVidPath, { trimVideo }, (err, videoPath) => {
        if (err) return callback(err);
        return callback(null, { videoPath: finalSlideVidPath, videoDerivative });
      });
    }
  })
}


function updateProgress(videoId, conversionProgress) {
  VideoModel.findByIdAndUpdate(videoId, {$set: { conversionProgress }}).then((result) => {
  })
  .catch(err => {
    if (err) {
      console.log('error updating progress', err);
    }
  })
}

function updateStatus(videoId, status) {
  VideoModel.findByIdAndUpdate(videoId, {$set: { status }}).then((result) => {
  })
  .catch(err => {
    if (err) {
      console.log('error updating progress', err);
    }
  })
}

ArticleModel.countDocuments({ published: true }).then((count) => {
    console.log(`Ready to handle a total of ${count} published articles in the database!`)
})
.catch(err => {
  console.log(err);
})
