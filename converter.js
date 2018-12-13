const fs = require('fs');
const { exec } = require('child_process');
const { getRemoteFile } = require('./utils')

const FFMPEG_SCALE = '"scale=w=1280:h=720,setsar=1:1,setdar=16:9,pad=1280:720:(ow-iw)/2:(oh-ih)/2"';

module.exports = {
  imageToVideo(image, audio, path, callback = () => {}) {

    getRemoteFile(image, (err, image) => {
      exec(`ffmpeg -framerate 25 -loop 1 -i ${image} -i ${audio} -c:v libx264 -c:a copy -b:a 192k -vf ${FFMPEG_SCALE} -shortest ${path}`, (err, stdout, stderr) => {
        fs.unlink(image);
        if (err) {
          return callback(err);
        }
        return callback(null, path)
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