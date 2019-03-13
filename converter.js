const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { getRemoteFile, getRemoteFileDuration, getFilesDuration, getVideoFramerate, getVideoDimentions } = require('./utils')
const { generateSubtitle } = require('./subtitles');

const FFMPEG_SCALE = '[0:v]scale=w=800:h=600,setsar=1:1,setdar=16:9,pad=800:600:(ow-iw)/2:(oh-ih)/2';

module.exports = {
  imageToVideo(image, audio, text, subtext, withSubtitles, outputPath, callback = () => {}) {
    console.log('image to video')
    getRemoteFile(image, (err, image) => {
      console.log('got file')
      if (err) return callback(err);
      generateSubtitle(text, audio, (err, subtitlePath) => {
        console.log('got subtitles')
        if (err) return callback(err);
        exec(`ffmpeg -y -thread_queue_size 10000 -framerate 25 -loop 1 -i ${image} -i ${audio} -c:v libvpx-vp9 -c:a libvorbis -filter_complex "${FFMPEG_SCALE}${!withSubtitles ? "" : `[outv];[outv]subtitles=${subtitlePath}:force_style='${subtext ? "MarginV=45'" : "'"}` }${!subtext ? "" : `[outv];[outv]format=yuv444p[outv];[outv]drawbox=y=0:color=black@0.8:width=iw:height=30:t=max[outv];[outv]drawtext=text='${subtext}':fontcolor=white:fontsize=12:x=10:y=10[outv];[outv]format=yuv420p`}" -shortest ${outputPath}`, (err, stdout, stderr) => {
          fs.unlink(image, () => {});
          fs.unlink(subtitlePath, () => {});
          if (err) {
            return callback(err);
          }
          return callback(null, outputPath)
        })
      })
      
    })
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
        let command;
        if (audioDuration <= videoDuration) {
          command = `ffmpeg -y -t ${audioDuration} -i ${video} -i ${audio} -c:v libvpx-vp9 -c:a libvorbis -map 0:v:0 -map 1:a:0 -filter_complex "${FFMPEG_SCALE}${!withSubtitles ? '' : `[outv];[outv]subtitles=${subtitlePath}:force_style='${subtext ? "MarginV=45'" : "'"}` }${!subtext ? "" : `[outv];[outv]format=yuv444p[outv];[outv]drawbox=y=0:color=black@0.8:width=iw:height=30:t=max[outv];[outv]drawtext=text='${subtext}':fontcolor=white:fontsize=12:x=10:y=10[outv];[outv]format=yuv420p`}" -shortest ${outputPath}`;
          exec(command, {shell: '/bin/bash'}, (err, stdout, stderr) => {
            fs.unlink(subtitlePath, () => {});            
            if (err) {
              return callback(err)
            };
            return callback(null, outputPath)
          })
        } else {
          getVideoFramerate(video, (err, frameRate) => {
            if (err) {
              return callback(err);
            }
            getVideoDimentions(video, (err, videoDimentions) => {
              // ${subtext ? "MarginV=45'" : "'"}` }${!subtext ? "" : `[outv];[outv]format=yuv444p[outv];[outv]drawbox=y=(ih-30):color=black@0.8:width=iw:height=30:t=max[outv];[outv]drawtext=text='${subtext}':fontcolor=white:fontsize=12:x=10:y=10[outv];[outv]format=yuv420p`}"
              // 
              command = `ffmpeg -y -f lavfi -i color=s=${videoDimentions}:d=${audioDuration}:r=${frameRate}:c=0xFFE4C4@0.0 -i ${video} -i ${audio} -c:v libvpx-vp9 -c:a libvorbis -filter_complex "[0:v][1:v]overlay[outv];[outv]scale=w=800:h=600,setsar=1:1,setdar=16:9,pad=800:600:(ow-iw)/2:(oh-ih)/2[outv]${!withSubtitles ? '' : `;[outv]subtitles=${subtitlePath}:force_style='${subtext ? "MarginV=45'" : "'[outv]"}` }${!subtext ? "" : `${withSubtitles ? '[outv]': '' };[outv]format=yuv444p[outv];[outv]drawbox=y=0:color=black@0.8:width=iw:height=30:t=max[outv];[outv]drawtext=text='${subtext}':fontcolor=white:fontsize=12:x=10:y=10[outv];[outv]format=yuv420p[outv]`}" -map "[outv]" -map 2:a -shortest ${outputPath}`;
              exec(command, {shell: '/bin/bash'}, (err, stdout, stderr) => {
                fs.unlink(subtitlePath, () => {});
                if (err) {
                  console.log(err)
                  return callback(err)
                };
                return callback(null, outputPath)
              })
            })
          })
        }
      })
    })
   })
    
  },

  gifToVideo(gif, audio, text, subtext, withSubtitles, outputPath, callback = () => {}) {
    getRemoteFileDuration(audio, (err, duration) => {
      if (err) {
        return callback(err);
      }
      generateSubtitle(text, audio, (err, subtitlePath) => {
        if (err) return callback(err);

        const command = `ffmpeg -y -ignore_loop 0 -t ${duration} -i ${gif} -i ${audio} -filter_complex "${FFMPEG_SCALE}${!withSubtitles ? '' : `[outv];[outv]subtitles=${subtitlePath}:force_style='${subtext ? "MarginV=45'" : "'"}` }${!subtext ? "" : `[outv];[outv]format=yuv444p[outv];[outv]drawbox=y=0:color=black@0.8:width=iw:height=30:t=max[outv];[outv]drawtext=text='${subtext}':fontcolor=white:fontsize=12:x=10:y=10[outv];[outv]format=yuv420p`}" -shortest -strict -2 -c:v libvpx-vp9 -c:a libvorbis -threads 4 -pix_fmt yuv420p -shortest ${outputPath}`;
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

  combineVideos(videos, { onProgress, onEnd }) {
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
      const filterComplex = videos.map((item, index) => `[${index}:v:0][${index}:a:0]`).join("");

      
      getFilesDuration(videos.map(v => v.fileName), (err, totalDuration) => {
        if (err) {
          totalDuration = 0;
        }
        exec(`ffmpeg ${fileNames} \
        -filter_complex "${filterComplex}concat=n=${videos.length}:v=1:a=1[outv][outa]" \
        -map "[outv]" -map "[outa]" ${videoPath}`, (err, stdout, stderr) => {
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
