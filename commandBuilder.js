const { FFMPEG_SCALE } = require('./constants');

module.exports = {
  generateImageToVideoCommand({ imagePath, audio, shouldOverlayWhiteBackground, subtext, audioTrim, outputPath, silent, duration }) {
    let command = `ffmpeg -y -thread_queue_size 512 -framerate 25 -loop 1 -i ${imagePath}`;
    if (shouldOverlayWhiteBackground) {
      command += ` -f lavfi -i color=c=white:s=800x600`;
    }
    if (silent) {
      command += ` -t ${duration} -f lavfi -i anullsrc=channel_layout=5.1:sample_rate=48000 -t ${duration} -pix_fmt yuv420p -filter_complex "${FFMPEG_SCALE}`
    } else {
      command += ` -i ${audio} -c:v libvpx-vp9 -c:a libvorbis -filter_complex "${FFMPEG_SCALE}`;
    }
    if (shouldOverlayWhiteBackground) {
      command += `[outv];[1:v][outv]overlay=1,format=yuv444p[outv];[outv]setsar=1:1,setdar=16:9 `;
    }
    if (subtext) {
      command += `[outv];[outv]format=yuv444p[outv];[outv]drawbox=y=0:color=black@0.8:width=iw:height=30:t=max[outv];[outv]drawtext=text='${normalizeCommandText(subtext)}':fontcolor=white:fontsize=12:x=10:y=10[outv];[outv]format=yuv420p`
    }
    if (silent) {
      command += `" ${outputPath}`;
    } else {
      command += `" -shortest ${audioTrim} ${outputPath}`;
    }
    return command;
  },
  generateVideoToVideoCommand({ videoPath, audio, audioDuration, videoDuration, subtext, outputPath, videoDimentions, frameRate, silent, duration }) {
    let command;
    if (silent) {
      command = `ffmpeg -y -t ${duration} -i ${videoPath} -c:v libvpx-vp9 -pix_fmt yuv420p  -filter_complex "${FFMPEG_SCALE}" ${outputPath}`;
    } else if (audioDuration <= videoDuration) {
      command = `ffmpeg -y -t ${audioDuration} -i ${videoPath} -i ${audio} -c:v libvpx-vp9 -c:a libvorbis -map 0:v:0 -map 1:a:0 -filter_complex "${FFMPEG_SCALE}`;
      if (subtext) {
        command += `[outv];[outv]format=yuv444p[outv];[outv]drawbox=y=0:color=black@0.8:width=iw:height=30:t=max[outv];[outv]drawtext=text='${normalizeCommandText(subtext)}':fontcolor=white:fontsize=12:x=10:y=10[outv];[outv]format=yuv420p`
      }
      command += `" -shortest ${outputPath}`;
    } else {
      command = `ffmpeg -y -f lavfi -i color=s=${videoDimentions}:d=${audioDuration}:r=${frameRate}:c=0xFFE4C4@0.0 -i ${videoPath} -i ${audio} -c:v libvpx-vp9 -c:a libvorbis -filter_complex "[0:v][1:v]overlay[outv];[outv]scale=w=800:h=600,setsar=1:1,setdar=16:9,pad=800:600:(ow-iw)/2:(oh-ih)/2[outv]`
      if (subtext) {
        command += `;[outv]format=yuv444p[outv];[outv]drawbox=y=0:color=black@0.8:width=iw:height=30:t=max[outv];[outv]drawtext=text='${normalizeCommandText(subtext)}':fontcolor=white:fontsize=12:x=10:y=10[outv];[outv]format=yuv420p[outv]`;
      }
      command += `" -map "[outv]" -map 2:a -shortest ${outputPath}`;
    }
    return command;
  },
  generateGifToVideoCommand({ gifPath, audioDuration, audio, subtext, outputPath, silent, duration }) {
    let command = '';
    if (silent) {
      command = `ffmpeg -y -ignore_loop 0 -t ${duration} -i ${gifPath} -f lavfi -i anullsrc=channel_layout=5.1:sample_rate=48000 -t ${duration} -c:v libvpx -crf 12 -b:v 500K -filter_complex "${FFMPEG_SCALE}`;
    } else {
     command = `ffmpeg -y -ignore_loop 0 -t ${audioDuration} -i ${gifPath} -i ${audio} -filter_complex "${FFMPEG_SCALE}`;
    }
    if (subtext) {
      command += ` [outv];[outv]format=yuv444p[outv];[outv]drawbox=y=0:color=black@0.8:width=iw:height=30:t=max[outv];[outv]drawtext=text='${normalizeCommandText(subtext)}':fontcolor=white:fontsize=12:x=10:y=10[outv];[outv]format=yuv420p`
    }
    if (!silent) {
      command += `" -strict -2 -c:v libvpx-vp9 -shortest ${outputPath}`
    } else {
      command += `" -shortest -strict -2 -c:v libvpx-vp9 -c:a libvorbis -threads 4 -pix_fmt yuv420p -shortest ${outputPath}`;
    }
    return command;
  },
}

function normalizeCommandText(text) {
  return text.replace(/\:|\'|\"/g, '');
}