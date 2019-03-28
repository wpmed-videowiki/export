require('dotenv').config({path: '.env'});
const amqp = require('amqplib/callback_api');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const async = require('async');
const mongoose = require('mongoose');
const cheerio = require('cheerio');

const { imageToVideo, videoToVideo, gifToVideo ,combineVideos, slowVideoRate }  = require('./converter');
const utils = require('./utils');
const subtitles = require('./subtitles');
const { DEFAUL_IMAGE_URL } = require('./constants');

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
    convertChannel.assertQueue(CONVERT_QUEUE, {durable: true});
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
        slidesHtml[audio.position].audio = audio.audioURL;
      }
    })
  }
  slidesHtml.forEach(slide => {
    function verifyMedia(cb) {
      if (!slide.media) {
        slide.media = DEFAUL_IMAGE_URL;
        slide.mediaType = 'image';
        return cb();
      }

      utils.checkMediaFileExists(slide.media, (err, valid) => {
        if (err || !valid) {
          slide.media = DEFAUL_IMAGE_URL;
          slide.mediaType = 'image';
        }
        return cb();
      })
    }
    verifySlidesMediaFuncArray.push(verifyMedia);
  })

  async.parallelLimit(async.reflectAll(verifySlidesMediaFuncArray), 2, (err, result) => {
    if (err) {
      console.log('error verifying slides media');
    }
    // Download media and audio for local use
    const downAudioFuncArray = [];

    slidesHtml.forEach((slide) => {
      function downAudioFunc(cb) {
        const tempAudioFile = path.join(__dirname, 'tmp', `downTmpAudio-${Date.now()}-${slide.audio.split('/').pop()}`);
        utils.downloadMediaFile(`https:${slide.audio}`, tempAudioFile, (err) => {
          if (!err) {
            slide.tmpAudio = tempAudioFile;
          } else {
            console.log('error downloading tmp audio', err);
          }
          return cb();
        })
      }
      downAudioFuncArray.push(downAudioFunc);
    })
    
    async.parallelLimit(async.reflectAll(downAudioFuncArray), 2, (err, value) => {
      if (err) {
        console.log('error fetching tmp medias', err);
      }

      slidesHtml.sort((a,b) => a.position - b.position).forEach((slide, index) => {
        function convert(cb) {
          const fileName = `videos/${slide.audio.split('/').pop().replace('.mp3', '.webm')}`
          const audioUrl = slide.tmpAudio || `https:${slide.audio}`;
          const convertCallback = (err, videoPath) => {
            if (err) {
              console.log('error in async ', err);
              return cb(err);
            }
            // Clear tmp media and audio if exists
            if (slide.tmpAudio) {
              fs.unlink(slide.tmpAudio, () => {});
            }

            slowVideoRate(videoPath, {
              onEnd: (err, slowedVideoPath) => {
                if (err || !fs.existsSync(slowedVideoPath)) {
                  slide.video = videoPath;
                } else {
                  slide.video = slowedVideoPath;
                  fs.unlink(videoPath, () => {});
                }
                progress += (1 / article.slides.length) * 100;
                updateProgress(videoId, progress);
                
                console.log(`Progress ####### ${progress} ######`)
                return cb(null, {
                  fileName: slide.video,
                  index
                });
              }
            })
          }
          // End convert callback
          
          if (!slide.media) {
            slide.media = DEFAUL_IMAGE_URL;
            slide.mediaType = 'image';
          }

          utils.getMediaInfo(slide.media, (err, info) => {
            let subText = '';
            if (err) {
              console.log('error fetching media author and licence', err)
            } else {
              if (info.author) {
                subText = `Visual Content by ${info.author}, `
              }
              if (info.licence) {
                subText += info.licence
              }
            }
            const $ = cheerio.load(`<div>${slide.text}</div>`);
            const slideText = $.text();
            
            const slideMediaUrl = slide.media;
            console.log('working on media', slideMediaUrl)
            if (utils.getFileType(slide.media) === 'image') {
              imageToVideo(slideMediaUrl, audioUrl, slideText, subText, false, fileName, convertCallback);
            } else if (utils.getFileType(slide.media) === 'video') {
              videoToVideo(slideMediaUrl, audioUrl, slideText, subText, false, fileName, convertCallback);
            } else if (utils.getFileType(slide.media) === 'gif') {
              gifToVideo(slideMediaUrl, audioUrl, slideText, subText, false, fileName, convertCallback);
            } else {
              return cb(new Error('Invalid file type'));
            }
          })
        }
        
        convertFuncArray.push(convert);
      })
      
      async.parallelLimit(convertFuncArray, 2, (err, results) => {
        if (err) {
          VideoModel.findByIdAndUpdate(videoId, {$set: { status: 'failed' }}, (err, result) => {
          })
          return callback(err);
        }
        updateProgress(videoId, 100);    
        results = results.sort((a, b) => a.index - b.index);
        // Generate the user credits slides
        utils.generateCreditsVideos(article.title, article.wikiSource, video, (err, creditsVideos) => {
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
              
              combineVideos(finalVideos, {
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
                  if (video.humanvoice && video.humanvoice.translatedSlides) {
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

// videoToVideo("Introduction_Slide_to_Acute_Visual_Loss.webm", "111b26bb-0d30-4f26-85ab-cee051fbbd40.mp3", 'temp1.webm', (err, path) => {
//   console.log(err, path)
// })

// videoToVideo('https://upload.wikimedia.org/wikipedia/commons/0/08/Black_Hole_animation.webm', 'http://dnv8xrxt73v5u.cloudfront.net/47d21ab0-b65e-4a51-8491-f24e2b7df801.mp3', 'On 11 February 2016, the LIGO collaboration announced the first direct detection of gravitational waves, which also represented the first observation of a black hole merger. As of April 2018, six gravitational wave events have been observed that originated from merging black holes.', '', true, './vidsub.webm', (err, videoPath) => {
//   console.log(err, videoPath);
// })

// imageToVideo('https://upload.wikimedia.org/wikipedia/commons/thumb/6/61/Obama_and_Hilary_face_off_in_DNC_2008_primaries.png/400px-Obama_and_Hilary_face_off_in_DNC_2008_primaries.png', 
// 'https://dnv8xrxt73v5u.cloudfront.net/549754ec-5e55-472f-8715-47120efc4567.mp3', 
// cheerio.load('He received <a href="">hello im a link</a> national attention in 2004 with his March primary win, his well-received July Democratic National Convention keynote address, and his landslide November election to the Senate').text(), '', true, './withsub.webm', (err, filePath) => {
//   console.log(err, filePath)
// })

// utils.generateSubtitle('Despite its invisible interior, the presence of a black hole can be inferred through its interaction with other matter and with electromagnetic radiation such as visible light', 'https://dnv8xrxt73v5u.cloudfront.net/58626ba7-4423-465d-b410-62fabd501472.mp3', () => {

// })

// gifToVideo('https://upload.wikimedia.org/wikipedia/commons/f/f4/Einstein_rings_zoom_web.gif', 'https://dnv8xrxt73v5u.cloudfront.net/549754ec-5e55-472f-8715-47120efc4567.mp3', 'He received national attention in 2004 with his March primary win, his well-received July Democratic National Convention keynote address, and his landslide November election to the Senate', '', true, 'gifsub.webm', (err, outpath) => {
//   console.log(err, outpath)
// })



// GETTING CONTRIBUTORS LSIT 
//  https://en.wikipedia.org/w/api.php?action=query&format=json&prop=contributors&titles=Wikipedia:MEDSKL/Acute_vision_loss&explaintext=1&exsectionformat=wiki&redirects


// ArticleModel.findOne({title: 'Elon_Musk', published: true}, (err, article) => {
//   // utils.generateCreditsVideos(article.title, article.wikiSource, (err, result) => {
//   //   console.log(err, result);
//   // });
  
// })
