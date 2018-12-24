const fs = require('fs');
const { exec } = require('child_process');
const { getRemoteFile, getRemoteFileDuration, getVideoFramerate, getVideoDimentions } = require('./utils')

const FFMPEG_SCALE = '"scale=w=800:h=600,setsar=1:1,setdar=16:9,pad=800:600:(ow-iw)/2:(oh-ih)/2"';

module.exports = {
  imageToVideo(image, audio, outputPath, callback = () => {}) {

    getRemoteFile(image, (err, image) => {
      exec(`ffmpeg -y -thread_queue_size 10000 -framerate 25 -loop 1 -i ${image} -i ${audio} -c:v libvpx-vp9 -c:a libvorbis -vf ${FFMPEG_SCALE} -shortest ${outputPath}`, (err, stdout, stderr) => {
        fs.unlink(image);
        if (err) {
          return callback(err);
        }
        return callback(null, outputPath)
      })
    })
  },
  videoToVideo(video, audio, outputPath, callback = () => {}) {
    /**
     * First we need to check if the video's length is greater than the audio's length,
     * if so, we will cut the first N seconds from the video to match the audio's
     * otherwise, proceed normally
    */
    getRemoteFileDuration(audio, (err, audioDuration) => {
      if (err) {
        return callback(err);
      }

      getRemoteFileDuration(video, (err, videoDuration) => {
        if (err) return callback(err);
        let command;
        if (audioDuration <= videoDuration) {
          command = `ffmpeg -y -t ${audioDuration} -i ${video} -i ${audio} -c:v libvpx-vp9 -c:a libvorbis -map 0:v:0 -map 1:a:0 -vf ${FFMPEG_SCALE} -shortest ${outputPath}`;
          exec(command, {shell: '/bin/bash'}, (err, stdout, stderr) => {
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
            console.log('frame rate is ', frameRate)
            getVideoDimentions(video, (err, videoDimentions) => {
              console.log('dimentions is', videoDimentions)
              command = `ffmpeg -y -f lavfi -i color=s=${videoDimentions}:d=${audioDuration}:r=${frameRate}:c=0xFFE4C4@0.0 -i ${video} -i ${audio} -c:v libvpx-vp9 -c:a libvorbis -filter_complex "[0:v][1:v]overlay[video];[video]scale=w=800:h=600,setsar=1:1,setdar=16:9,pad=800:600:(ow-iw)/2:(oh-ih)/2[video]" -map "[video]" -map 2:a -shortest ${outputPath}`; 
              exec(command, {shell: '/bin/bash'}, (err, stdout, stderr) => {
                if (err) {
                  return callback(err)
                };
                return callback(null, outputPath)
              })
            })
          })
        }
      })
    })
  },

  gifToVideo(gif, audio, outputPath, callback = () => {}) {
    getRemoteFileDuration(audio, (err, duration) => {
      if (err) {
        return callback(err);
      }
      const command = `ffmpeg -y -i ${audio} -ignore_loop 0 -t ${duration} -i ${gif} -vf ${FFMPEG_SCALE} -shortest -strict -2 -c:v libvpx-vp9 -c:a libvorbis -threads 4 -pix_fmt yuv420p -shortest ${outputPath}`;
      exec(command, (err, stdout, stderr) => {
        console.log('converted ', err)
        if (err) {
          return callback(err)
        };
        return callback(null, outputPath)
      })
    })
  },

  combineVideos(videos, callback = () => {}) {
    const listName = parseInt(Date.now() + Math.random() * 100000);
    const videoPath = `final/${listName}.webm`;
    fs.writeFile(`./${listName}.txt`, videos.map((video, index) => `file '${video.fileName}'`).join('\n'), (err, content) => {
      if (err) {
        videos.forEach(video => {
          fs.unlink(video.fileName);
        })
        return callback(err)
      }

      const fileNames = `-i ${videos.map(item => item.fileName).join(' -i ')}`;
      const filterComplex = videos.map((item, index) => `[${index}:v:0][${index}:a:0]`).join("");
  
      exec(`ffmpeg ${fileNames} \
      -filter_complex "${filterComplex}concat=n=${videos.length}:v=1:a=1[outv][outa]" \
      -map "[outv]" -map "[outa]" ${videoPath}`, (err, stdout, stderr) => {
        if (err) {
          callback(err);
        } else {
          callback(null, `${videoPath}`);
        }
        // clean up
        fs.unlink(`./${listName}.txt`);
        videos.forEach(video => {
          // fs.unlink(video.fileName);
        })
      })
  
    });
  }


}