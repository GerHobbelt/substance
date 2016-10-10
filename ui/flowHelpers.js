import FlowSource from './FlowSource'

class DocumentSessionFlowAdapter extends FlowSource {

  constructor(flow, documentSession) {
    super(flow, documentSession)

    this.documentSession = documentSession
    this.documentSession.on('update', this._onSessionUpdate, this)

    // HACK: reuse the flow source id for the document
    // so that it is possible to use the document as source directly
    const doc = documentSession.getDocument()
    doc[this.flow.id] = this.id
  }

  dispose() {
    super.dispose()
    const documentSession = this.documentSession
    const doc = documentSession.getDocument()

    documentSession.off(this)
    delete doc[this.flow.id]
  }

  _onSessionUpdate(update, info) {
    const change = update.change
    const selection = update.selection
    const collaborators = update.collaborators
    const doc = this.documentSession.getDocument()
    this.extendInfo(info)
    if (change) {
      this.set('change', change)
      Object.keys(change.created).forEach((id) => {
        this.set(id, change.created[id])
      })
      Object.keys(change.updated).forEach((id) => {
        this.set(id, doc.get(id.split(',')))
      })
      Object.keys(change.deleted).forEach((id) => {
        this.set(id, change.deleted[id])
      })
    }
    if (selection) {
      this.set('selection', selection, info)
    }
    if (collaborators) {
      this.set('collaborators', collaborators, info)
    }
    this.startFlow()
  }
}

DocumentSessionFlowAdapter.connect = function(documentSession, flow) {
  new DocumentSessionFlowAdapter(flow, documentSession)
}

export { DocumentSessionFlowAdapter }

