/** One artifact listed for a Session: a local file or a Feishu cloud document. */
export interface Artifact {
  path?: string
  url?: string
  resource?: string
  kind: 'delivered' | 'produced' | 'document'
  turn: number
  description?: string
}

/** The client-visible projection view. */
export interface ArtifactsView {
  artifacts: Artifact[]
}
