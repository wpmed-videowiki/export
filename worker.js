const amqp = require('amqplib/callback_api');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const async = require('async');
const mongoose = require('mongoose');

const { imageToVideo, videoToVideo, gifToVideo ,combineVideos }  = require('./converter');
const { getFileType, getRemoteFileDuration } = require('./utils');

const Article = require('./models/Article');

const CONVERT_QUEUE = 'CONVERT_ARTICLE_QUEUE';

mongoose.connect('mongodb://localhost:27017/videowiki-test')


amqp.connect('amqp://localhost', (err, conn) => {
  conn.createChannel((err, ch) => {
    ch.prefetch(1);

    ch.assertQueue(CONVERT_QUEUE, {durable: true});
    
    ch.consume(CONVERT_QUEUE, msg => {
      const { id } = JSON.parse(msg.content.toString());


      console.log('received ', id);
      // ch.ack(msg)

      Article.findOne({_id: id}, (err, article) => {
        if (err) {
          console.log('error fetching article ', err);
        }
        console.log(article)
        convertArticle(article, (err, videoPath) => {

          ch.ack(msg);
        })
      })

    }, { noAck: false });
  })
})



function convertArticle(article, callback) {
  const convertFuncArray = [];
  article.slides.sort((a,b) => a.position - b.position).forEach((slide, index) => {
    function convert(cb) {
      const fileName = `videos/${slide.audio.split('/').pop().replace('.mp3', '.mp4')}`
      const audioUrl = 'https:' + slide.audio;
      if (!slide.media) {
        slide.media = 'https://s3.eu-central-1.amazonaws.com/vwpmedia/statics/default_image.png';
        slide.mediaType = 'image';
      }

      if (getFileType(slide.media) === 'image') {
        imageToVideo(slide.media, audioUrl, fileName, (err, result) => {
          if (err) {
            console.log('error in async ', err);
            return cb(err);
          }
          console.log(`Progress ####### ${index/article.slides.length * 100} ######`)
          return cb(null, {
            fileName,
            index
          });
        });

      } else if (getFileType(slide.media) === 'video') {
        // Handle video
        videoToVideo(slide.media, audioUrl, fileName, (err, result) => {
          if (err) {
            console.log('error in async ', err);
            return cb(err);
          }
          return cb(null, {
            fileName,
            index
          });
        });
      } else if (getFileType(slide.media) === 'gif') {
        // Handle GIF
         /**
         * First we need to check if the GIF's length is greater than the audio's length,
         * if so, we will cut the first N seconds from the GIF to match the audio's
         * otherwise, proceed normally
         */
        gifToVideo(slide.media, audioUrl, fileName, (err, result) => {
          if (err) {
            console.log('error in async ', err);
            return cb(err);
          }
          return cb(null, {
            fileName,
            index
          });
        });
      } else {
        throw new Error('Invalid file type');
      }

    }

    console.log('slide ', slide.media)
    convertFuncArray.push(convert);
  })

  async.parallelLimit(convertFuncArray, 2, (err, results) => {
    if (err) {
      return callback(err);
    }
    results = results.sort((a, b) => a.index - b.index);
    combineVideos(results, (err, videoPath) => {
      console.log(err, videoPath);
      if (err) {
        return callback(err);
      }
      return callback(null, videoPath)
    })

  })
}
