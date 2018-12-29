const mongoose = require('mongoose')
require('mongoose-long')(mongoose)
const Schema = mongoose.Schema
const SchemaTypes = mongoose.Schema.Types

const VideoSchema = new Schema({
  title: { type: String, required: true },
  wikiSource: { type: String, required: true },
  user: String,
  version: String,
  status: { type: String, enum: ['queued', 'progress', 'converted', 'uploaded', 'failed'], default: 'queued' },
  conversionProgress: {
    type: Number,
    default: 0,
  },
  url: String,
  ETag: String, // s3 tag id 
  error: String, 
  withSubtitles: { type: Boolean, default: false },
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
