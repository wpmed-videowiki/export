const mongoose = require('mongoose')
require('mongoose-long')(mongoose)
const Schema = mongoose.Schema
const SchemaTypes = mongoose.Schema.Types

const DerivativeSchema = new Schema({
  fileName: { type: String, required: true },
  author: { type: String, required: true },
  licence: { type: String, required: true },
  position: Number,
})

const VideoSchema = new Schema({
  title: { type: String, required: true },
  wikiSource: { type: String, required: true },
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  humanvoice: { type: Schema.Types.ObjectId, ref: 'HumanVoice' },
  extraUsers: [String],
  version: String,
  status: { type: String, enum: ['queued', 'progress', 'converted', 'uploaded', 'failed'], default: 'queued' },
  conversionProgress: {
    type: Number,
    default: 0,
  },
  textReferencesProgress: { type: Number, default: 0 },
  combiningVideosProgress: { type: Number, default: 0 },
  wrapupVideoProgress: { type: Number, default: 0 },
  url: String,
  ETag: String, // s3 tag id 
  lang: String,
  error: String, 

  withSubtitles: { type: Boolean, default: false },
  commonsSubtitles: { type: String },
  vlcSubtitles: { type: String },
  vttSubtitles: { type: String },

  derivatives: [DerivativeSchema],

  created_at: { type: Date, default: Date.now, index: true },
  updated_at: { type: Date, default: Date.now },
})

VideoSchema.pre('save', function (next) {
  const now = new Date()
  this.updated_at = now
  if (!this.created_at) {
    this.created_at = now
  }
  next()
})

VideoSchema.statics.isObjectId = (id) =>
  mongoose.Types.ObjectId.isValid(id)

VideoSchema.statics.getObjectId = (id) =>
  mongoose.Types.ObjectId(id)

module.exports = mongoose.model('Video', VideoSchema)
