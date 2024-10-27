const constants = require('./constants');

function normalizeCommandText(text) {
  return text.replace(/\:|\'|\"/g, '');
}

function generateBackgroundBlur(inputStream) {
  return `color=color=black@.3:size=${constants.VIDEO_WIDTH}x${constants.VIDEO_HEIGHT}:d=1[dark];${inputStream}scale=w=${constants.VIDEO_WIDTH}:h=${constants.VIDEO_HEIGHT},setsar=${constants.SAR},setdar=${constants.DAR},crop=${constants.VIDEO_WIDTH}:${constants.VIDEO_HEIGHT}[blurbase];[blurbase]boxblur=lr='min(h,w)/20':lp=1:cr='min(cw,ch)/20':cp=1[blurred];[blurred][dark]overlay[darkened];[darkened]setsar=${constants.SAR},setdar=${constants.DAR}`
}

function generateScale(scale) {
  switch (scale) {
    case 'width':
      return constants.FFMPEG_SCALE_WIDTH;
    case 'height':
      return constants.FFMPEG_SCALE_HEIGHT;
    case 'both':
      return constants.FFMPEG_SCALE_BOTH;
    default:
      return '';
  }
}

function generateSubtext(subtext) {
  return `format=yuv444p[outv];[outv]drawbox=y=0:color=black@0.8:width=iw:height=30:t=fill[outv];[outv]drawtext=fontfile=FreeSerif.ttf:text='${normalizeCommandText(subtext)}':fontcolor=white:fontsize=16:x=10:y=10`
}

module.exports = {
  generateImageToVideoCommand({ imagePath, audio, shouldOverlayWhiteBackground, dimentions, scale, subtext, audioTrim, outputPath, silent, duration }) {
    let command = `ffmpeg -y -thread_queue_size 512 -framerate 25 -loop 1 -i ${imagePath}`;
    if (shouldOverlayWhiteBackground) {
      command += ` -f lavfi -i color=c=white:s=${dimentions}`;
    }
    if (silent) {
      command += ` -t ${duration} -pix_fmt yuv420p -filter_complex "`
    } else {
      command += ` -i ${audio} -c:v libvpx-vp9 -c:a libvorbis -filter_complex "`;
    }
    if (shouldOverlayWhiteBackground) {
      command += `[1:v][0:v]overlay=1,format=yuv444p `;
    }
    if (scale) {
      command += `[outv];[outv]${generateScale(scale)}`;
      command += `[outv];${generateBackgroundBlur('[0:v]')}[bg];[bg][outv]overlay=(W-w)/2:(H-h)/2`
    } else {
    // TODO check if the dimentions is different from target video dimentions
      command += `[outv];${generateBackgroundBlur('[0:v]')}[bg];[bg][outv]overlay=(W-w)/2:(H-h)/2`
    }
    if (subtext) {
      command += `[outv];[outv]${generateSubtext(subtext)}[outv];[outv]format=yuv420p`
    }
    if (silent) {
      command += `[outv]" -map "[outv]" ${outputPath}`;
    } else {
      command += `" -shortest ${audioTrim} ${outputPath}`;
    }
    console.log(command)
    return command;
  },
  generateVideoToVideoCommand({ videoPath, audio, audioDuration, videoDuration, subtext, outputPath, videoDimentions, frameRate, silent, duration, scale }) {
    let command;
    if (silent) {
      command = `ffmpeg -y -t ${duration} -i ${videoPath} -c:v libvpx-vp9 -pix_fmt yuv420p  -filter_complex "`;
      if (scale) {
        command += `[0:v]${generateScale(scale)}`;
        command += `[outv];${generateBackgroundBlur('[0:v]')}[bg];[bg][outv]overlay=(W-w)/2:(H-h)/2`;
      } else {
        command += `${generateBackgroundBlur('[0:v]')}[bg];[bg][0:v]overlay=(W-w)/2:(H-h)/2`;
      }
      if (subtext) {
        command += `[outv];[outv]${generateSubtext(subtext)}[outv];[outv]format=yuv420p`
      }
      command += `[outv]" -map "[outv]" ${outputPath}`
    } else if (audioDuration <= videoDuration) {
      command = `ffmpeg -y -t ${audioDuration} -i ${videoPath} -i ${audio} -c:v libvpx-vp9 -c:a libvorbis -map 0:v:0 -map 1:a:0 -filter_complex "${constants.FFMPEG_SCALE_BOTH}`;
      if (subtext) {
        command += `[outv];[outv]${generateSubtext(audioDuration, subtext)}[outv];[outv]format=yuv420p`
      }
      command += `" -shortest ${outputPath}`;
    } else {
      command = `ffmpeg -y -f lavfi -i color=s=${videoDimentions}:d=${audioDuration}:r=${frameRate}:c=0xFFE4C4@0.0 -i ${videoPath} -i ${audio} -c:v libvpx-vp9 -c:a libvorbis -filter_complex "[0:v][1:v]overlay[outv];[outv]scale=w=800:h=600,setsar=${constants.SAR},setdar=${constants.DAR},pad=800:600:(ow-iw)/2:(oh-ih)/2[outv]`
      if (subtext) {
        command += `;[outv]${generateSubtext(audioDuration, subtext)}[outv];[outv]format=yuv420p[outv]`;
      }
      command += `" -map "[outv]" -map 2:a -shortest ${outputPath}`;
    }
    console.log(command)
    return command;
  },
  generateGifToVideoCommand({ gifPath, audioDuration, audio, subtext, outputPath, silent, duration, scale }) {
    let command = '';
    if (silent) {
      command = `ffmpeg -y -ignore_loop 0 -t ${duration} -i ${gifPath} -t ${duration} -c:v libvpx-vp9 -filter_complex "`;
      if (scale) {
        command += `[0:v]${generateScale(scale)}`;
        command += `[outv];${generateBackgroundBlur('[0:v]')}[bg];[bg][outv]overlay=(W-w)/2:(H-h)/2`;
      } else {
        command += `${generateBackgroundBlur('[0:v]')}[bg];[bg][0:v]overlay=(W-w)/2:(H-h)/2`;
      }
  
    } else {
      command = `ffmpeg -y -ignore_loop 0 -t ${audioDuration} -i ${gifPath} -i ${audio} -filter_complex "${constants.FFMPEG_SCALE_BOTH}`;
    }
    if (subtext) {
      command += ` [outv];[outv]${generateSubtext(subtext)}[outv];[outv]format=yuv420p`
    }
    if (silent) {
      command += `[outv]" -map "[outv]" -strict -2 -c:v libvpx-vp9 -threads 4 -pix_fmt yuv420p ${outputPath}`;
    } else {
      command += `" -strict -2 -c:v libvpx-vp9 -shortest ${outputPath}`
    }
    console.log(command)
    return command;
  },
}

// generateGifToVideoCommand({ gifPath, audioDuration, audio, subtext, outputPath, silent, duration }) {
//   let command = '';
//   if (silent) {
//     command = `ffmpeg -y -ignore_loop 0 -t ${duration} -i ${gifPath} -crf 12 -b:v 500K -filter_complex "`;
//     command += `${generateBackgroundBlur('[0:v]')}[bg];[bg][0:v]overlay=(W-w)/2:(H-h)/2`;

//   } else {
//     command = `ffmpeg -y -ignore_loop 0 -t ${audioDuration} -i ${gifPath} -i ${audio} -filter_complex "${constants.FFMPEG_SCALE_BOTH}`;
//   }
//   if (subtext) {
//     command += ` [outv];[outv]format=yuv444p[outv];[outv]drawbox=y=0:color=black@0.8:width=iw:height=30:t=max[outv];[outv]drawtext=text='${normalizeCommandText(subtext)}':fontcolor=white:fontsize=12:x=10:y=10[outv];[outv]format=yuv420p`
//   }
//   if (!silent) {
//     command += `" -strict -2 -c:v libvpx-vp9 -shortest ${outputPath}`
//   } else {
//     command += `" -shortest -strict -2 -c:v libvpx-vp9 -threads 4 -pix_fmt yuv420p -shortest ${outputPath}`;
//   }
//   return command;
// },