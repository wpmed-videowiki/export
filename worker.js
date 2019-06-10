require('dotenv').config({path: '.env'});
const amqp = require('amqplib/callback_api');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const async = require('async');
const mongoose = require('mongoose');
const cheerio = require('cheerio');

const { imageToSilentVideo, videoToSilentVideo, gifToSilentVideo ,combineVideos, slowVideoRate, wavToWebm, addFadeEffects, addAudioToVideo }  = require('./converter');
const utils = require('./utils');
const subtitles = require('./subtitles');
const { DEFAUL_IMAGE_URL, SLIDE_CONVERT_PER_TIME, FADE_EFFECT_DURATION } = require('./constants');

const UserModel = require('./models/User');
const ArticleModel = require('./models/Article');
const VideoModel = require('./models/Video');
const HumanVoiceModel = require('./models/HumanVoice');

const args = process.argv.slice(2);
const lang = args[0];

const DELETE_AWS_VIDEO = 'DELETE_AWS_VIDEO';
const CONVERT_QUEUE = `CONVERT_ARTICLE_QUEUE_${lang}`;
const UPDLOAD_CONVERTED_TO_COMMONS_QUEUE = `UPDLOAD_CONVERTED_TO_COMMONS_QUEUE_${lang}`;

const DB_CONNECTION = `${process.env.DB_HOST_URL}-${lang}`;
// const DB_CONNECTION = 'mongodb://localhost/videowiki-en'
console.log('connecting to database ', DB_CONNECTION);
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
  
  VideoModel
  .findById(videoId)
  .populate('humanvoice')
  .populate('user')
  .exec((err, video) => {
    if (err) {
      updateStatus(videoId, 'failed');
      console.log('error retrieving video', err);
      return convertChannel.ack(msg);
    }
    if (!video) {
      console.log('invalid video id');
      updateStatus(videoId, 'failed');          
      return convertChannel.ack(msg);
    }
    console.log('video is ', video);
    ArticleModel.findOne({title: video.title, wikiSource: video.wikiSource, published: true}, (err, article) => {
      if (err) {
        updateStatus(videoId, 'failed');
        console.log('error fetching article ', err);
        return convertChannel.ack(msg);
      }
      console.log('converting article ', article.title)

      // Update status
      updateStatus(videoId, 'progress');
      convertArticle({ article, video, videoId, withSubtitles: video.withSubtitles }, (err, convertResult) => {
        console.log('convert rsult is ', convertResult)
        if (err) {
          updateStatus(videoId, 'failed');
          console.log(err);
          return convertChannel.ack(msg);
        }
        utils.uploadVideoToS3(convertResult.videoPath, (err, uploadVideoResult) => {

          if (err) {
            console.log('error uploading file', err);
            updateStatus(videoId, 'failed');                
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
              VideoModel.findByIdAndUpdate(videoId, { $set: videoUpdate }, { new: true }, (err, result) => {
                if (err) {
                  updateStatus(videoId, 'failed');                  
                  console.log(err);
                }
                console.log('Done!', result)
                convertChannel.ack(msg);
                updateProgress(videoId, 100);
                convertChannel.sendToQueue(UPDLOAD_CONVERTED_TO_COMMONS_QUEUE, new Buffer(JSON.stringify({ videoId })), { persistent: true })
                // Cleanup
                fs.unlink(convertResult.videoPath, () => {});
                Object.keys(convertResult.subtitles).forEach(key => {
                  fs.unlink(convertResult.subtitles[key], () => {});
                })
              })
            })

          } else {

            VideoModel.findByIdAndUpdate(videoId, { $set: videoUpdate }, { new: true }, (err, result) => {
              if (err) {
                updateStatus(videoId, 'failed');                  
                console.log(err);
              }
              console.log('Done!', result);
              convertChannel.ack(msg);
              updateProgress(videoId, 100);
              convertChannel.sendToQueue(UPDLOAD_CONVERTED_TO_COMMONS_QUEUE, new Buffer(JSON.stringify({ videoId })), { persistent: true })
              // Cleanup
              fs.unlink(convertResult.videoPath, () => {});
            })
          }
        })
      })
    })
  })

}

function deleteAWSVideoCallback(msg) {
  const { videoId } = JSON.parse(msg.content.toString());

  VideoModel.findById(videoId, (err, video) => {
    if (err) {
      console.log('error fetching video ', err, videoId);
      return;
    }
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
        VideoModel.findByIdAndUpdate(videoId, { $unset: { url: true }}, (err, result) => {
          console.log(err, result);
        })
      })
    }
  })
}


function convertArticle({ article, video, videoId, withSubtitles }, callback) {
  const convertFuncArray = [];
  let progress = 0;
  const slidesHtml = article.slidesHtml.slice();
  const verifySlidesMediaFuncArray = [];

  if (video.humanvoice && video.humanvoice.audios && video.humanvoice.audios.length === slidesHtml.length) {
    console.log('custom human voice')
    video.humanvoice.audios.forEach((audio) => {
      if (audio.position < slidesHtml.length) {
        // Set human voice audio and duration on normal slides
        const matchingSlide = slidesHtml[audio.position];
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
          if (matchingSlide.duration > totalMediaDuration) {
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
      }
    })
  }
  slidesHtml.forEach(slide => {
    if (!slide.media || slide.media.length === 0) {
      slide.media = [{
        url: DEFAUL_IMAGE_URL,
        type: 'image',
        time: slide.duration,
      }];
    } else {
      slide.media.forEach((mitem) => {
        function verifyMedia(cb) {
          if (!mitem.url) {
            mitem.url = DEFAUL_IMAGE_URL;
            mitem.type = 'image';
            mitem.time = slide.duration;
            return cb();
          }
          let slideMediaUrl = mitem.origianlUrl || mitem.url;
          const tmpMediaName = path.join(__dirname, 'tmp', `downTmpMedia-${Date.now()}-${parseInt(Math.random() * 10000)}.${slideMediaUrl.split('.').pop()}`);
          console.log('veirying', slideMediaUrl)

          if (slideMediaUrl.indexOf('400px-') !== -1) {
            slideMediaUrl = slideMediaUrl.replace('400px-', '800px-');
          }
          // Svg files are rendered as pngs
          if (mitem.origianlUrl && mitem.origianlUrl.split('.').pop().toLowerCase() === 'svg') {
            slideMediaUrl = mitem.url;
          }
          utils.downloadMediaFile(slideMediaUrl, tmpMediaName, (err) => {
            if (err) {
              console.log(err);
              mitem.url = DEFAUL_IMAGE_URL;
              mitem.type = 'image';
              mitem.time = slide.duration;
              return cb();
            }
            mitem.tmpUrl = tmpMediaName;
            return cb();
          })
        }
        // verifySlidesMediaFuncArray.push(verifyMedia);
      })
    }
  })
  console.log('verifying media');
  async.parallelLimit(async.reflectAll(verifySlidesMediaFuncArray), 2, (err, result) => {
    if (err) {
      console.log('error verifying slides media');
    }
    // Download media and audio for local use
    const downAudioFuncArray = [];

    slidesHtml.forEach((slide) => {
      function downAudioFunc(cb) {
        const tempAudioFile = path.join(__dirname, 'tmp', `downTmpAudio-${Date.now()}-${slide.audio.split('/').pop()}`);
        const audioUrl = slide.audio.indexOf('http') === -1 ? `https:${slide.audio}` : slide.audio;
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
      downAudioFuncArray.push(downAudioFunc);
    })
    console.log('downloading audios');

    async.parallelLimit(async.reflectAll(downAudioFuncArray), 2, (err, value) => {
      console.log('start time', new Date())
        if (err) {
        console.log('error fetching tmp medias', err);
      }

      let videoDerivatives = [];

      slidesHtml.sort((a,b) => a.position - b.position).forEach((slide, index) => {
        function convert(cb) {
          const audioUrl = slide.tmpAudio || `https:${slide.audio}`;
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
              if (!err && Math.floor(duration) > 2) {
                finalizeSlideFunc.push((finalizeSlideCB) => {
                  addFadeEffects(videoPath, FADE_EFFECT_DURATION, (err, fadedVideo) => {
                    if (err) {
                      console.log('error adding fade effects', err);
                      slide.video = videoPath;
                    } else if (fadedVideo && fs.existsSync(fadedVideo)) {
                      fs.unlinkSync(videoPath);
                      slide.video = fadedVideo;
                    }
                    finalizeSlideCB();
                  })
                })
              }
              finalizeSlideFunc.push((finalizeSlideCB) => {
                progress += (1 / article.slides.length) * 100;
                updateProgress(videoId, progress);
                
                console.log(`Progress ####### ${progress} ######`);
                finalizeSlideCB();
                return cb(null, {
                  fileName: slide.video,
                  index
                });
                // slowVideoRate(slide.video, {
                //   onEnd: (err, slowedVideoPath) => {
                //     console.log('slow done')
                //     const oldPath = slide.video;
                //     if (err || !fs.existsSync(slowedVideoPath)) {
                //       // slide.video = videoPath;
                //     } else {
                //       fs.unlinkSync(oldPath);
                //       slide.video = slowedVideoPath;
                //     }
                  
                //     progress += (1 / article.slides.length) * 100;
                //     updateProgress(videoId, progress);
                    
                //     console.log(`Progress ####### ${progress} ######`);
                //     finalizeSlideCB();
                //     return cb(null, {
                //       fileName: slide.video,
                //       index
                //     });
                //   }
                // })
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
          convertMedias(slide.media, audioUrl, slide.position, convertCallback);
        }
        
        convertFuncArray.push(convert);
      })
      
      async.parallelLimit(convertFuncArray, SLIDE_CONVERT_PER_TIME, (err, results) => {
        if (err) {
          VideoModel.findByIdAndUpdate(videoId, {$set: { status: 'failed' }}, (err, result) => {
          })
          return callback(err);
        }
        updateProgress(videoId, 100);

        // Set video derivatives to be put in the licence info
        VideoModel.findByIdAndUpdate(videoId, { $set: { derivatives: videoDerivatives } }, (err) => {
          if (err) {
            console.log('error saving video derivatives');
          }
        })

        results = results.sort((a, b) => a.index - b.index);
        // Generate the user credits slides
        utils.generateCreditsVideos(article, video, (err, creditsVideos) => {
          if (err) {
            console.log('error creating credits videos', err);
          }
          // Generate the article references slides
          utils.generateReferencesVideos(article.title, article.wikiSource, article.referencesList,{
            onProgress: (progress) => {
              if (progress && progress !== 'null') {
                VideoModel.findByIdAndUpdate(videoId, {$set: { textReferencesProgress: progress }}, (err, result) => {
                })
              }
            },
            
            onEnd: (err, referencesVideos) => {
              // Considere progress done
              VideoModel.findByIdAndUpdate(videoId, {$set: { textReferencesProgress: 100 }}, (err, result) => {
              })

              if (err) {
                console.log('error creating references videos', err);
              }

              let finalVideos = [];
              if (results) {
                finalVideos = finalVideos.concat(results);
              }
              // Add Share video
              finalVideos.push({ fileName: 'cc_share.webm', });
              if (creditsVideos && creditsVideos.length > 0) {
                finalVideos = finalVideos.concat(creditsVideos);
              }
              if (referencesVideos && referencesVideos.length > 0) {
                finalVideos = finalVideos.concat(referencesVideos);
              }
              
              combineVideos(finalVideos, false, {
                onProgress: (progress) => {
                  if (progress && progress !== 'null') {
                    VideoModel.findByIdAndUpdate(videoId, {$set: { combiningVideosProgress: progress }}, (err, result) => {
                    })
                  }
                },
                
                onEnd: (err, videoPath) => {
                  if (err) {
                    console.log(err);
                    VideoModel.findByIdAndUpdate(videoId, {$set: { status: 'failed' }}, (err, result) => {
                    })
                    return callback(err);
                  }
                  
                  VideoModel.findByIdAndUpdate(videoId, {$set: { combiningVideosProgress: 100, wrapupVideoProgress: 20 }}, (err, result) => {
                  })
                  
                  const subtitledSlides = JSON.parse(JSON.stringify(slidesHtml));
                  // If we have human voice, use the user's translation as the subtitles
                  if (video.humanvoice && video.humanvoice.translatedSlides && video.lang !== article.lang) {
                    video.humanvoice.translatedSlides.forEach((slide) => {
                      subtitledSlides[slide.position].text = slide.text;
                    });
                  }
                  subtitles.generateSrtSubtitles(subtitledSlides, 1, (err, subs) => {
                    const cbResult = { videoPath };
                    if (err) {
                      console.log('error generating subtitles file', err);
                    }

                    if (subs) {
                      cbResult.subtitles = subs;
                    }
                    
                    VideoModel.findByIdAndUpdate(videoId, {$set: { wrapupVideoProgress: 70 }}, (err, result) => {
                    })
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
}

function convertMedias(medias, audio, slidePosition, callback = () => {}) {
  const convertMediaFuncArray = [];
  let videoDerivative = [];
  medias.forEach((mitem, index) => {
    convertMediaFuncArray.push((singleCB) => {
      const fileName = `videos/video-${parseInt(Date.now() + Math.random() * 100000)}.webm`;
      utils.getMediaInfo(mitem.url, (err, info) => {
        let subtext = '';
        if (err) {
          console.log('error fetching media author and licence', err)
        } else if (info){
          if (info.author) {
            subtext = `Visual Content by ${info.author}${info.licence ? ', ' : '.'}`
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
       
        if (mitem.origianlUrl && mitem.origianlUrl.split('.').pop().toLowerCase() === 'svg') {
          slideMediaUrl = mitem.url;
        }
        console.log('converting submedia', slideMediaUrl, subtext)
        if (utils.getFileType(mitem.url) === 'image') {
          imageToSilentVideo({ image: slideMediaUrl, subtext, duration: mitem.time / 1000, outputPath: fileName }, (err, fileName) => {
            if (err) return singleCB(err);
            return singleCB(null, { fileName, index })
          });
        } else if (utils.getFileType(mitem.url) === 'video') {
          videoToSilentVideo({ video: slideMediaUrl, subtext, duration: mitem.time / 1000, outputPath: fileName },  (err, fileName) => {
            if (err) return singleCB(err);
            return singleCB(null, { fileName, index })
          });
        } else if (utils.getFileType(mitem.url) === 'gif') {
          gifToSilentVideo({ gif: slideMediaUrl, subtext, duration: mitem.time / 1000, outputPath: fileName},  (err, fileName) => {
            if (err) return singleCB(err);
            return singleCB(null, { fileName, index })
          });
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
    const finalSlideVidPath = path.join(__dirname, 'videos', `slide_with_audio-${Date.now()}-${parseInt(Math.random() * 100000)}.webm`)
    if (medias.length > 1) {
      combineVideos(slideVideos, true, {
        onEnd: (err, videoPath) => {
          if (err) return callback(err);
          return addAudioToVideo(videoPath, audio, finalSlideVidPath, (err, videoPath) => {
            if (err) return callback(err);
            return callback(null, { videoPath: finalSlideVidPath, videoDerivative });
          });
        },
      })
    } else {
      addAudioToVideo(slideVideos[0].fileName, audio, finalSlideVidPath, (err, videoPath) => {
        if (err) return callback(err);
        return callback(null, { videoPath: finalSlideVidPath, videoDerivative });
      });
    }
  })
}


function updateProgress(videoId, conversionProgress) {
  VideoModel.findByIdAndUpdate(videoId, {$set: { conversionProgress }}, (err, result) => {
    if (err) {
      console.log('error updating progress', err);
    }
  })
}

function updateStatus(videoId, status) {
  VideoModel.findByIdAndUpdate(videoId, {$set: { status }}, (err, result) => {
    if (err) {
      console.log('error updating progress', err);
    }
  })
}

ArticleModel.count({ published: true }, (err, count) => {
  if (err) {
    console.log(err);
  } else {
    console.log(`Ready to handle a total of ${count} published articles in the database!`)
  }
})
