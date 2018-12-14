const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const async = require('async');

const { imageToVideo, videoToVideo, gifToVideo ,combineVideos }  = require('./converter');
const { getFileType, getRemoteFileDuration } = require('./utils');

const APP_DIRS = ['./tmp', './videos', './final'];

// Create necessary file dirs 
APP_DIRS.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
})

const article = require('./blackhole');

function convertArticle(article) {
  const convertFuncArray = [];
  article.slides.sort((a,b) => a.position - b.position).forEach((slide, index) => {
    function convert(cb) {
      const fileName = `videos/${slide.audio.split('/').pop().replace('.mp3', '.mp4')}`
      const audioUrl = 'https:' + slide.audio;
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

  async.parallelLimit(convertFuncArray, 5, (err, results) => {
    console.log('error', err, 'result', results, 'Finished converting');
    results = results.sort((a, b) => a.index - b.index);
    combineVideos(results, (err, videoPath) => {
      console.log(err, videoPath);
    })

  })
}

// convertArticle(article)