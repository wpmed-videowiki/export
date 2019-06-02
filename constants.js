module.exports = {
  FFMPEG_SCALE: '[0:v]scale=w=800:h=600,setsar=1:1,setdar=16:9,pad=800:600:(ow-iw)/2:(oh-ih)/2',
  DEFAUL_IMAGE_URL: 'https://s3-eu-west-1.amazonaws.com/vwconverter/static/rsz_1image_2.png',
  SLIDE_CONVERT_PER_TIME: 1,
  FADE_EFFECT_DURATION: 0.75,
}