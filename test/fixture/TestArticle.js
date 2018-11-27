import { Document } from 'substance'

export default class TestArticle extends Document {
  constructor (schema) {
    super(schema)
    this.create({
      type: '@container',
      id: 'body',
      nodes: []
    })
  }
}
