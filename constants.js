const VIDEO_HEIGHT = 720;
const VIDEO_WIDTH = 1280;
const DAR = '16/9';
const SAR = '1/1';

module.exports = {
  DAR,
  SAR,
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
  FFMPEG_SCALE: `scale=w=${VIDEO_WIDTH}:h=${VIDEO_HEIGHT},setsar=${SAR},setdar=${DAR}`,
  DEFAUL_IMAGE_URL: 'https://s3-eu-west-1.amazonaws.com/vwconverter/static/rsz_1image_2.png',
  SLIDE_CONVERT_PER_TIME: 2,
  FADE_EFFECT_DURATION: 0.75,
}