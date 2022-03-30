const VIDEO_HEIGHT = 720;
const VIDEO_WIDTH = 1280;
const DAR = '16/9';
const SAR = '1/1';
const CUSTOM_TEMPLATES = {
  PLAYALL: '{{VW Playall}}'
}

module.exports = {
  DAR,
  SAR,
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
  FFMPEG_SCALE_BOTH: `scale=w=${VIDEO_WIDTH}:h=${VIDEO_HEIGHT},setsar=${SAR},setdar=${DAR}`,
  FFMPEG_SCALE_WIDTH: `scale=w=${VIDEO_WIDTH}:h=-1,setsar=${SAR},setdar=${DAR}`,
  FFMPEG_SCALE_HEIGHT: `scale=h=${VIDEO_HEIGHT}:w=-1,setsar=${SAR},setdar=${DAR}`,
  DEFAUL_IMAGE_URL: 'https://s3-eu-west-1.amazonaws.com/vwconverter/static/rsz_1image_2.png',
  SLIDE_CONVERT_PER_TIME: 2,
  FADE_EFFECT_DURATION: 0.75,
  CUSTOM_TEMPLATES
}