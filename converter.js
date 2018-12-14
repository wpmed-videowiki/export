const fs = require('fs');
const { exec } = require('child_process');
const { getRemoteFile, getRemoteFileDuration } = require('./utils')

const FFMPEG_SCALE = '"scale=w=1280:h=720,setsar=1:1,setdar=16:9,pad=1280:720:(ow-iw)/2:(oh-ih)/2"';

module.exports = {
  imageToVideo(image, audio, outputPath, callback = () => {}) {

    getRemoteFile(image, (err, image) => {
      exec(`ffmpeg -y -framerate 25 -loop 1 -i ${image} -i ${audio} -c:v libx264 -c:a copy -b:a 192k -vf ${FFMPEG_SCALE} -shortest ${outputPath}`, (err, stdout, stderr) => {
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
   console.log('before get duration')
    getRemoteFileDuration(audio, (err, duration) => {
      console.log('duration is',err, duration)
      if (err) {
        return callback(err);
      }
      const command = `ffmpeg -y -t ${duration} -i ${video} -i ${audio} -c:v libx264 -c:a copy -b:a 192k -map 0:v:0 -map 1:a:0 -vf ${FFMPEG_SCALE} -shortest ${outputPath}`;
      exec(command, (err, stdout, stderr) => {
        console.log('conveted ', err)
        if (err) {
          return callback(err)
        };
        return callback(null, outputPath)
      })
    })
  },

  combineVideos(videos, callback = () => {}) {
    const listName = parseInt(Date.now() + Math.random() * 100000);
    const videoPath = `final/${listName}.mp4`;
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
        console.log(err, stdout, stderr)
        if (err) {
          callback(err);
        } else {
          callback(null, `${videoPath}`);
        }
        // clean up
        fs.unlink(`./${listName}.txt`);
        videos.forEach(video => {
          fs.unlink(video.fileName);
        })
      })
  
    });
  }


}