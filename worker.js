const amqp = require('amqplib/callback_api');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const async = require('async');
const mongoose = require('mongoose');

const { imageToVideo, videoToVideo, gifToVideo ,combineVideos }  = require('./converter');
const { getFileType, getRemoteFileDuration, uploadVideoToS3 } = require('./utils');

const ArticleModel = require('./models/Article');
const VideoModel = require('./models/Video');


const CONVERT_QUEUE = 'CONVERT_ARTICLE_QUEUE';
const UPDLOAD_CONVERTED_TO_COMMONS_QUEUE = 'UPDLOAD_CONVERTED_TO_COMMONS_QUEUE';


require('dotenv').config({path: '.env'});

mongoose.connect('mongodb://localhost:27017/videowiki-test')
amqp.connect('amqp://localhost', (err, conn) => {
  conn.createChannel((err, convertChannel) => {
    convertChannel.prefetch(1);

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

          // Update status
          updateStatus(videoId, 'progress');
          convertArticle({article, videoId}, (err, videoPath) => {
            if (err) {
              updateStatus(videoId, 'failed');
              console.log(err);
              return convertChannel.ack(msg);
            }
            uploadVideoToS3(videoPath, (err, {url, ETag}) => {
              if (err) {
                console.log('error uploading file', err);
                updateStatus(videoId, 'failed');                
                return convertChannel.ack();
              }
              VideoModel.findByIdAndUpdate(videoId, { $set: {url, ETag, status: 'converted'} }, (err, result) => {
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



function convertArticle({article, videoId}, callback) {
  const convertFuncArray = [];
  let progress = 0;
  
  article.slides.sort((a,b) => a.position - b.position).forEach((slide, index) => {
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
        slide.media = 'https://s3.eu-central-1.amazonaws.com/vwpmedia/statics/default_image.png';
        slide.mediaType = 'image';
      }

      if (getFileType(slide.media) === 'image') {
        imageToVideo(slide.media, audioUrl, fileName, convertCallback);
      } else if (getFileType(slide.media) === 'video') {
        videoToVideo(slide.media, audioUrl, fileName, convertCallback);
      } else if (getFileType(slide.media) === 'gif') {
        gifToVideo(slide.media, audioUrl, fileName, convertCallback);
      } else {
        return cb(new Error('Invalid file type'));
      }

    }

    convertFuncArray.push(convert);
  })

  async.parallelLimit(convertFuncArray, 2, (err, results) => {
    if (err) {
      VideoModel.findByIdAndUpdate(videoId, {$set: { status: 'failed' }}, (err, result) => {
      })
      return callback(err);
    }
    results = results.sort((a, b) => a.index - b.index);
    combineVideos(results, (err, videoPath) => {
      if (err) {
        console.log(err);
        VideoModel.findByIdAndUpdate(videoId, {$set: { status: 'failed' }}, (err, result) => {
        })
        return callback(err);
      }

      return callback(null, videoPath)
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


// videoToVideo("Introduction_Slide_to_Acute_Visual_Loss.webm", "111b26bb-0d30-4f26-85ab-cee051fbbd40.mp3", 'temp1.webm', (err, path) => {
//   console.log(err, path)
// })