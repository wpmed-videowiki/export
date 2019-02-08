require('dotenv').config({path: '.env'});
const amqp = require('amqplib/callback_api');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const async = require('async');
const mongoose = require('mongoose');
const cheerio = require('cheerio');

const { imageToVideo, videoToVideo, gifToVideo ,combineVideos, slowVideoRate }  = require('./converter');
const { getFileType, getRemoteFileDuration, uploadVideoToS3, generateSubtitle, getMediaInfo, generateReferencesVideos, generateCreditsVideos } = require('./utils');
const { DEFAUL_IMAGE_URL } = require('./constants');

const ArticleModel = require('./models/Article');
const VideoModel = require('./models/Video');

const args = process.argv.slice(2);
const lang = args[0];

const CONVERT_QUEUE = `CONVERT_ARTICLE_QUEUE_${lang}`;
const UPDLOAD_CONVERTED_TO_COMMONS_QUEUE = `UPDLOAD_CONVERTED_TO_COMMONS_QUEUE_${lang}`;

const DB_CONNECTION = `${process.env.DB_HOST_URL}-${lang}`;
// const DB_CONNECTION = 'mongodb://localhost/videowiki-en'
console.log('connecting to database ', DB_CONNECTION);
mongoose.connect(DB_CONNECTION)
amqp.connect(process.env.RABBITMQ_HOST_URL, (err, conn) => {
  console.log('error is', err);
  conn.createChannel((err, convertChannel) => {
    convertChannel.prefetch(1);
    console.log('connection created')
    convertChannel.assertQueue(CONVERT_QUEUE, {durable: true});
    convertChannel.assertQueue(UPDLOAD_CONVERTED_TO_COMMONS_QUEUE, { durable: true });

    convertChannel.consume(CONVERT_QUEUE, msg => {
      const { videoId } = JSON.parse(msg.content.toString());

      VideoModel.findById(videoId, (err, video) => {
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

        ArticleModel.findOne({title: video.title, wikiSource: video.wikiSource, published: true}, (err, article) => {
          if (err) {
            updateStatus(videoId, 'failed');
            console.log('error fetching article ', err);
            return convertChannel.ack(msg);
          }
          console.log('converting article ', article.title)

          // Update status
          updateStatus(videoId, 'progress');
          convertArticle({ article, videoId, withSubtitles: video.withSubtitles }, (err, videoPath) => {
            if (err) {
              updateStatus(videoId, 'failed');
              console.log(err);
              return convertChannel.ack(msg);
            }
            uploadVideoToS3(videoPath, (err, result) => {
              if (err) {
                console.log('error uploading file', err);
                updateStatus(videoId, 'failed');                
                return convertChannel.ack();
              }
              const { url, ETag } = result;
              // console.log('converted at ', url)
              VideoModel.findByIdAndUpdate(videoId, { $set: {url, ETag, status: 'converted', wrapupVideoProgress: 100} }, (err, result) => {
                if (err) {
                  updateStatus(videoId, 'failed');                  
                  console.log(err);
                }
                console.log('Done!')
                convertChannel.ack(msg);
                updateProgress(videoId, 100);
                convertChannel.sendToQueue(UPDLOAD_CONVERTED_TO_COMMONS_QUEUE, new Buffer(JSON.stringify({ videoId })), { persistent: true })

              })
            })
          })
        })
      })

    }, { noAck: false });
  })
})



function convertArticle({ article, videoId, withSubtitles }, callback) {
  const convertFuncArray = [];
  let progress = 0;
  article.slidesHtml.sort((a,b) => a.position - b.position).forEach((slide, index) => {
    function convert(cb) {
      const fileName = `videos/${slide.audio.split('/').pop().replace('.mp3', '.webm')}`
      const audioUrl = 'https:' + slide.audio;
      const convertCallback = (err, result) => {
        if (err) {
          console.log('error in async ', err);
          return cb(err);
        }
        
        progress += (1 / article.slides.length) * 100;
        updateProgress(videoId, progress);

        console.log(`Progress ####### ${progress} ######`)
        return cb(null, {
          fileName,
          index
        });
      }


      if (!slide.media) {
        slide.media = DEFAUL_IMAGE_URL;
        slide.mediaType = 'image';
      }
      getMediaInfo(slide.media, (err, info) => {
        let subtitle = '';
        if (err) {
          console.log('error fetching media author and licence', err)
        } else {
          if (info.author) {
            subtitle = `Visual Content by ${info.author}, `
          }
          if (info.licence) {
            subtitle += info.licence
          }
        }
        const $ = cheerio.load(`<div>${slide.text}</div>`);
        const slideText = $.text();
        
        if (getFileType(slide.media) === 'image') {
          imageToVideo(slide.media, audioUrl, slideText, subtitle, withSubtitles, fileName, convertCallback);
        } else if (getFileType(slide.media) === 'video') {
          videoToVideo(slide.media, audioUrl, slideText, subtitle, withSubtitles, fileName, convertCallback);
        } else if (getFileType(slide.media) === 'gif') {
          gifToVideo(slide.media, audioUrl, slideText, subtitle, withSubtitles, fileName, convertCallback);
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
    generateCreditsVideos(article.title, article.wikiSource, (err, creditsVideos) => {
      if (err) {
        console.log('error creating credits videos', err);
      }

      generateReferencesVideos(article.title, article.wikiSource, article.referencesList,{
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
              console.log('error creating references videos', generateReferencesVideos);
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

            combineVideos(finalVideos,{
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

                VideoModel.findByIdAndUpdate(videoId, {$set: { combiningVideosProgress: 100 }}, (err, result) => {
                })

                slowVideoRate(videoPath,{
                  onProgress: (progress) => {
                      if (progress && progress !== 'null') {
                        VideoModel.findByIdAndUpdate(videoId, {$set: { wrapupVideoProgress: progress > 90 ? 90 : progress }}, (err, result) => {
                        }) 
                      }
                    },
                  onEnd: (err, slowVideoPath) => {
                    if (err) {
                      // If something failed at this stage, just send back the normal video
                      // That's not slowed down
                      return callback(null, videoPath);
                    }
                    return callback(null, slowVideoPath);
                  }
              })
            }
          })
        }
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

ArticleModel.count({}, (err, count) => {
  if (err) {
    console.log(err);
  } else {
    console.log(`Ready to handle a total of ${count} articles in the database!`)
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

// generateSubtitle('Despite its invisible interior, the presence of a black hole can be inferred through its interaction with other matter and with electromagnetic radiation such as visible light', 'https://dnv8xrxt73v5u.cloudfront.net/58626ba7-4423-465d-b410-62fabd501472.mp3', () => {

// })

// gifToVideo('https://upload.wikimedia.org/wikipedia/commons/f/f4/Einstein_rings_zoom_web.gif', 'https://dnv8xrxt73v5u.cloudfront.net/549754ec-5e55-472f-8715-47120efc4567.mp3', 'He received national attention in 2004 with his March primary win, his well-received July Democratic National Convention keynote address, and his landslide November election to the Senate', '', true, 'gifsub.webm', (err, outpath) => {
//   console.log(err, outpath)
// })



// GETTING CONTRIBUTORS LSIT 
//  https://en.wikipedia.org/w/api.php?action=query&format=json&prop=contributors&titles=Wikipedia:MEDSKL/Acute_vision_loss&explaintext=1&exsectionformat=wiki&redirects


// ArticleModel.findOne({title: 'Elon_Musk', published: true}, (err, article) => {
//   // generateCreditsVideos(article.title, article.wikiSource, (err, result) => {
//   //   console.log(err, result);
//   // });
  
// })