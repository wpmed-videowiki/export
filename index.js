const fs = require('fs');
const async = require('async');

const {
  exec
} = require('child_process');

const path = require('path');
const article = require('./article');
const { getFileType } = require('./utils');

function convertArticle(article) {
  const convertFuncArray = [];

  article.slides.forEach((slide, index) => {
    function convert(cb) {
      const fileName = `videos/${slide.audio.split('/').pop().replace('.mp3', '.mp4')}`
      if (getFileType(slide.media) === 'image') {
        imagetoVideo(slide.media, 'https:' + slide.audio, fileName, (err, result) => {
          if (err) {
            console.log('error in async ', err);
            return cb(err);
          }
          return cb(null, {
            fileName,
            index
          });
        });

      } else if (getFileType(slide.media) === 'video') {
        // Handle video

      } else if (getFileType(slide.media) === 'gif') {
        // Handle GIF

      } else {
        throw new Error('Invalid file type');
      }

    }

    convertFuncArray.push(convert);
  })

  async.parallelLimit(convertFuncArray, 5, (err, results) => {
    console.log('error', err, 'result', results, 'Finished converting', images.length);
    results = results.sort((a, b) => a.index - b.index);
    combineVideos(results, (err, videoPath) => {
      console.log(err, videoPath);
    })

  })
}