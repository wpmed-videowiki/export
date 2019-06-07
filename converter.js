const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const async = require('async');
const { getRemoteFile, getRemoteFileDuration, getFilesDuration, getVideoFramerate, getFileDimentions, getVideoNumberOfFrames, getFileType, trimVideo, silent } = require('./utils')
const { generateSubtitle } = require('./subtitles');
const commandBuilder = require('./commandBuilder');
const constants = require('./constants');

module.exports = {

  wavToWebm(filePath, targetPath, callback = () => {}) {
    exec(`ffmpeg -i ${filePath} -vn ${targetPath}`, (err, stdout, stderr) => {
      if (err) return callback(err);
      if (!fs.existsSync(filePath)) {
        return callback(new Error('Something went wrong'))
      }
      return callback(null, targetPath);
    })
  },
  imageToSilentVideo({ image, subtext, duration, outputPath }, callback = () => {}) {
    getFileDimentions(image, (err, dimentions) => {
      if (err && !dimentions) {
        console.log('error getting dimentions', err);
        dimentions = `${constants.VIDEO_WIDTH}x${constants.VIDEO_HEIGHT}`;
      }
      let command = commandBuilder.generateImageToVideoCommand({ imagePath: image, subtext, silent: true, shouldOverlayWhiteBackground: true, dimentions, outputPath, duration });
      exec(command, (err, stdout, stderr) => {
        if (err) return callback(err);
        return callback(null, outputPath);
      })
    })
  },
  imageToVideo(image, audio, text, subtext, withSubtitles, outputPath, callback = () => {}) {
    getRemoteFile(image, (err, image) => {
      if (err) return callback(err);
      getRemoteFileDuration(audio, (err, audioDuration) => {
        let audioTrim = '';
        if (err || !audioDuration) {
          console.log('error getting audio duration', err);
        } else {
          audioTrim = `-t ${audioDuration}`;
        }
        generateSubtitle(text, audio, (err, subtitlePath) => {
          if (err) return callback(err);
          const shouldOverlayWhiteBackground = true;
          const command = commandBuilder.generateImageToVideoCommand({ imagePath: image, audio, audioDuration, shouldOverlayWhiteBackground, subtext, audioTrim, outputPath });
          exec(command, (err, stdout, stderr) => {
            fs.unlink(image, () => {});
            fs.unlink(subtitlePath, () => {});
            if (err) {
              return callback(err);
            }
            return callback(null, outputPath)
          })
        })
      })
    })
  },
  videoToSilentVideo({ video, duration, subtext, outputPath }, callback = () => {}) {
    if (video.split('.').pop().toLowerCase() === 'ogv') {
      const tmpVidPath = path.join(__dirname, 'tmp', `tmpOgvVideo_${Date.now()}.webm`);
      exec(`ffmpeg -i ${video} ${tmpVidPath}`, (err, stdout, stderr) => {
        if (err) return cb(null, video);
        let command = commandBuilder.generateVideoToVideoCommand({ videoPath: tmpVidPath, subtext, silent: true, duration, outputPath });

        exec(command, (err, stdout, stderr) => {
          if (err) return callback(err);
          fs.unlink(tmpVidPath, () => {});
          return callback(null, outputPath);
        })
      })
    } else {
      let command = commandBuilder.generateVideoToVideoCommand({ videoPath: video, subtext, silent: true, duration, outputPath });
      exec(command, (err, stdout, stderr) => {
        if (err) return callback(err);
        return callback(null, outputPath);
      })
    }
  },
  videoToVideo(video, audio, text, subtext, withSubtitles, outputPath, callback = () => {}) {
    /**
     * First we need to check if the video's length is greater than the audio's length,
     * if so, we will cut the first N seconds from the video to match the audio's
     * otherwise, proceed normally
    */
   generateSubtitle(text, audio, (err, subtitlePath) => {
     if (err) return callback(err);

    getRemoteFileDuration(audio, (err, audioDuration) => {
      if (err) {
        return callback(err);
      }

      getRemoteFileDuration(video, (err, videoDuration) => {
        if (err) return callback(err);
        let updateFuncArray = [];
        let command;
        // OGV files have issue while getting their framrate, so we convert it to webm first
        updateFuncArray.push((cb) => {
          if (video.split('.').pop().toLowerCase() === 'ogv') {
            const tmpVidPath = path.join(__dirname, 'tmp', `tmpOgvVideo_${Date.now()}.webm`);
            exec(`ffmpeg -i ${video} ${tmpVidPath}`, (err, stdout, stderr) => {
              if (err) return cb(null, video);
              return cb(null, tmpVidPath);
            })
          } else {
            setTimeout(() => {
              return cb(null, video);
            });
          }
        })

        // If the audio duration is smaller than the audio duration, we take only the first amount of seconds from the video to match the audio
        if (audioDuration <= videoDuration) {
          updateFuncArray.push((videoPath, cb) => {
            command = commandBuilder.generateVideoToVideoCommand({ videoPath, audio, audioDuration, videoDuration, subtext, outputPath });
       
            exec(command, {shell: '/bin/bash'}, (err, stdout, stderr) => {
              fs.unlink(subtitlePath, () => {});            
              if (err) {
                return cb(err)
              };
              return cb(null, outputPath)
            })
          })
        } else {
          updateFuncArray = updateFuncArray.concat([
            (videoPath, cb) => {
              getVideoFramerate(videoPath, (err, frameRate) => {
                if (err) return cb(err);
                return cb(null, videoPath, frameRate);
              })
            },
            (videoPath, frameRate, cb) => {
              getFileDimentions(videoPath, (err, videoDimentions) => {
                if (err) return cb(err);
                return cb(null, videoPath, frameRate, videoDimentions);
              })
            },
            (videoPath, frameRate, videoDimentions, cb) => {
              command = commandBuilder.generateVideoToVideoCommand({ videoPath, audio, audioDuration, videoDuration, subtext, outputPath, videoDimentions, frameRate });
              exec(command, {shell: '/bin/bash'}, (err, stdout, stderr) => {
                fs.unlink(subtitlePath, () => {});
                if (err) {
                  console.log(err)
                  return cb(err)
                };
                return cb()
              })
            }
          ])
        }

        async.waterfall(updateFuncArray, (err) => {
          if (err) return callback(err);
          return callback(null, outputPath)
        })
      })
    })
   })
    
  },

  gifToSilentVideo({ gif, duration, subtext, outputPath }, callback = () => {}) {
    let command = commandBuilder.generateGifToVideoCommand({ gifPath: gif, subtext, silent: true, duration, outputPath });
    exec(command, (err) => {
      if (err) return callback(err);
      return callback(null, outputPath);
    })
  },
  gifToVideo(gif, audio, text, subtext, withSubtitles, outputPath, callback = () => {}) {
    getRemoteFileDuration(audio, (err, audioDuration) => {
      if (err) {
        return callback(err);
      }
      generateSubtitle(text, audio, (err, subtitlePath) => {
        if (err) return callback(err);

        const command = commandBuilder.generateGifToVideoCommand({ gifPath: gif, audio, audioDuration, subtext, outputPath });
        exec(command, (err, stdout, stderr) => {
          fs.unlink(subtitlePath, () => {});
          if (err) {
            return callback(err)
          };
          return callback(null, outputPath)
        })
      })
      
    })
  },

  addFadeEffects(video, fadeDuration = 0.5, callback = () => {}) {
    // Fade duration is in seconds
    const fadedPath = path.join(__dirname, 'tmp', `faded-${ parseInt(Date.now() + Math.random() * 100000)}-fade.webm`);
    getVideoNumberOfFrames(video, (err, framesInfo) => {
      if (err) return callback(err);
      if (!framesInfo) return callback(new Error('Something went wrong getting number of frames'));
      const command = `ffmpeg -i ${video} -vf 'fade=in:0:${Math.ceil(framesInfo.frameRate * fadeDuration)},fade=out:${Math.floor(framesInfo.frames - parseInt(framesInfo.frameRate * fadeDuration))}:${(Math.ceil(framesInfo.frameRate * fadeDuration))}' ${fadedPath}`;
      // const command = `ffmpeg -y -i ${video} -vf 'fade=out:${Math.floor(framesInfo.frames - parseInt(framesInfo.frameRate * fadeDuration))}:${(Math.ceil(framesInfo.frameRate * fadeDuration))}' ${fadedPath}`;
      exec(command, (err) => {
        if (err) return callback(err);
        return callback(null, fadedPath);
      })
    })
  },

  // convertMedia(medias, audio, text, subtext, withSubtitles, outputPath, callback = () => {}) {
  //   /*
  //     Convert steps:
  //     1- convert single images/videos into silent videos
  //     2- combine them together
  //     3- add audio layer
  //   */
  //  const convertFuncArray = [];
  //   medias.forEach((media, index) => {
  //     const fileType = utils.getFileType(media.url);
  //     const videoName = `videos/submedia-${index}-${Date.now()}${parseInt(Math.random() * 10000)}.webm`;
  //     switch (fileType) {
  //       case 'video':
  //         convertFuncArray.push(function(cb) {
  //           trimVideo(media.url, media.time, videoName, (err, outputPath) => {
  //             if (err) return cb(err);
  //             return cb(null, { video: outputPath, index });
  //           });
  //         });
  //         break;
  //       default:
  //         convertFuncArray.push(function(cb) {
  //           convertImageToSilentVideo(media.url, media.time, true, videoName, (err, outputPath) => {
  //             if (err) return cb(err);
  //             return cb(null, { video: outputPath, index });
  //           });
  //         });
  //         break;
  //     }
  //   })

  //   async.parallelLimit(convertFuncArray, 5, (err, results) => {
  //     if (err) return callback(err);
  //     console.log(results);
  //     const videos = results.sort((a, b) => a.index - b.index).map(v => ({ ...v, fileName: v.video }));
  //     this.combineVideos(videos, {
  //       onEnd(err, videoPath) {
  //         // Cleanup
  //         videos.forEach((v) => fs.unlink(v.fileName, () => {}));
  //         if (err) return callback(err);
  //         // Add audio layer
  //         this.videoToVideo(videoPath, audio, text, subtext, withSubtitles, outputPath, (err, outputPath) => {
  //           fs.unlink(videoPath, () => {});
  //           if (err) return callback(err);
  //           return callback(null, outputPath);
  //         })
  //       }
  //     })
  //   })
  // },

  addAudioToVideo(video, audio, outputPath, callback = () => {}) {
    getRemoteFileDuration(audio, (err, duration) => {
      let audioTrim = '';
      if (err || !duration) {
        console.log('error getting audio duration', err);
      } else {
        audioTrim = ` -t ${duration} `;
      }
      const command = `ffmpeg -y -i ${video} -i ${audio} -map 0:v:0 -map 1:a:0 ${audioTrim} ${outputPath}`;
      console.log('command', command);
      exec(command, (err, stdout, stderr) => {
        if (err) return callback(err);
        if (!fs.existsSync(outputPath)) return callback(new Error('Something went wrong'));
        return callback(null, outputPath);
      })
    })
  },

  combineVideos(videos, silent, { onProgress = () => {}, onEnd = () => {} }) {
    const listName = parseInt(Date.now() + Math.random() * 100000);
    const videoPath = `videos/${listName}.webm`;
    fs.writeFile(`./${listName}.txt`, videos.map((video, index) => `file '${video.fileName}'`).join('\n'), (err, content) => {
      if (err) {
        videos.forEach(video => {
          // fs.unlink(video.fileName, () => {});
        })
        return onEnd(err)
      }

      const fileNames = `-i ${videos.map(item => item.fileName).join(' -i ')}`;
      const filterComplex = videos.map((item, index) => `[${index}:v:0]${!silent ? `[${index}:a:0]` : ''}`).join("");

      
      getFilesDuration(videos.map(v => v.fileName), (err, totalDuration) => {
        if (err) {
          totalDuration = 0;
        }
        exec(`ffmpeg ${fileNames} \
        -filter_complex "${filterComplex}concat=n=${videos.length}:v=1${!silent ? `:a=1` : ''}[outv]${!silent ? `[outa]` : ''}" \
        -map "[outv]" ${!silent ? `-map "[outa]"` : ''} -crf 23 ${videoPath}`, (err, stdout, stderr) => {
          if (err) {
            onEnd(err);
          } else {
            onEnd(null, `${videoPath}`);
          }
          // clean up
          fs.unlink(`./${listName}.txt`, () => {});
          videos.forEach(video => {
            // fs.unlink(video.fileName, () => {});
          })
        })
        .stderr.on('data', (c) => {
          getProgressFromStdout(totalDuration, c, onProgress);
        })
      })
    });
  },

  slowVideoRate(videoPath, { onProgress = () => {}, onEnd = () => {}}) {
    const slowVideoPath = path.join(__dirname, 'tmp', `${ parseInt(Date.now() + Math.random() * 100000)}-slow.webm`);
    getRemoteFileDuration(videoPath, (err, totalDuration) => {
      if (err) {
        totalDuration = 0;
      }
      // The slowed version is 0.1 more in duration, adjusting the progress accordingly
      totalDuration = totalDuration * 1.1;
      exec(`ffmpeg -i ${videoPath} -filter_complex "[0:v]setpts=1.1*PTS[v];[0:a]atempo=0.9[a]" -map "[v]" -map "[a]" ${slowVideoPath}`, (err, stdout, stderr) => {
        if (err) {
          console.log('erro slowing down video', err, stderr);
          return onEnd(err);
        }
        return onEnd(null, slowVideoPath);
      })
      .stderr.on('data', c => {
        getProgressFromStdout(totalDuration, c, onProgress);
      })
    })
  }


}

function getProgressFromStdout(totalDuration, chunk, onProgress) {
  const re = /time=([0-9]+):([0-9]+):([0-9]+)/;
  const match = chunk.toString().match(re);
  if (chunk && totalDuration && match && match.length > 3) {
    const hours = parseInt(match[1]);
    const minutes = parseInt(match[2]);
    const seconds = parseInt(match[3]);
    const total = seconds + minutes * 60 + hours * 60 * 60;
    onProgress(Math.floor(total / totalDuration * 100));
  }
}


function normalizeCommandText(text) {
  return text.replace(/\:|\'|\"/g, '');
}

// getRemoteFileDuration('https://dnv8xrxt73v5u.cloudfront.net/bbedc689-1971-40d6-959d-95757c7d319e.mp3', (err, duration) => {
//   console.log(err, duration)
// })
// module.exports.imageToSilentVideo({
//   image: 'testimg.jpg',
//   subtext: 'Subtesxt test',
//   duration: 5,
//   outputPath: 'test2.webm'
// }, (err, out) => {
//   console.log(err, out)
// })

module.exports.videoToSilentVideo ({
  duration: 5,
  video: 'vid.webm',
  subtext: 'test subtext',
  outputPath: 'vidtovid.webm'
}, (err, out) => {
  console.log(err, out)
})