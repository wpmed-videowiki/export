const VIDEO_HEIGHT = 720;
const VIDEO_WIDTH = 1280;
const DAR = '16/9';
const SAR = '1/1';
const CUSTOM_TEMPLATES = {
  PLAYALL: '{{VW Playall}}'
}

// Wikimedia rejects requests sent with a default or generic library user-agent
// (https://w.wiki/4wJS), so this has to name the tool and a contact address
const USER_AGENT = process.env.VIDEOWIKI_USER_AGENT;
if (!USER_AGENT) {
  console.log('WARNING: VIDEOWIKI_USER_AGENT is not set, commons downloads and licence lookups will be rejected');
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
  USER_AGENT,
  SLIDE_CONVERT_PER_TIME: 2,
  FADE_EFFECT_DURATION: 0.75,
  CUSTOM_TEMPLATES
}