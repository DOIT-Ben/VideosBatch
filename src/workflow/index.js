export const DEFAULT_STAGE_DEFINITIONS = Object.freeze([
  { id: 'LESSON_PLAN', kind: 'llm', next: 'ASSET_PLAN' },
  { id: 'ASSET_PLAN', kind: 'llm', next: 'ASSET_GENERATION' },
  { id: 'ASSET_GENERATION', kind: 'media', next: 'STORYBOARD' },
  { id: 'STORYBOARD', kind: 'llm', next: 'CANVAS_REVIEW' },
  { id: 'CANVAS_REVIEW', kind: 'review', next: 'VIDEO_GENERATION' },
  { id: 'VIDEO_GENERATION', kind: 'media', next: 'VIDEO_REVIEW' },
  { id: 'VIDEO_REVIEW', kind: 'review', next: 'STITCH' },
  { id: 'STITCH', kind: 'stitch', next: null },
])

const STAGE_IDS = new Set(DEFAULT_STAGE_DEFINITIONS.map((stage) => stage.id))

export function createWorkflowState(sessionId, input, seereel = {}) {
  if (!sessionId) throw new Error('sessionId is required')
  return {
    sessionId,
    input,
    seereel: structuredClone(seereel),
    cursor: DEFAULT_STAGE_DEFINITIONS[0].id,
    status: 'READY',
    artifacts: {},
    history: [],
  }
}

function assertKnownStage(stageId) {
  if (!STAGE_IDS.has(stageId)) throw new Error(`Unknown workflow stage: ${stageId}`)
}

export class InMemorySeeReelRuntime {
  constructor() {
    this.visibleEvents = []
  }

  async persistStageArtifact({ sessionId, stageId, artifact }) {
    this.visibleEvents.push({ type: 'stage_completed', sessionId, stageId, artifact })
  }

  async persistHumanEdit({ sessionId, stageId, artifact }) {
    this.visibleEvents.push({ type: 'human_edit', sessionId, stageId, artifact })
  }
}

export function createWorkflowRunner({ runtime, executors, stages = DEFAULT_STAGE_DEFINITIONS }) {
  const stageById = new Map(stages.map((stage) => [stage.id, stage]))

  function pause(state) {
    if (state.status === 'DONE') return state
    return { ...state, status: 'PAUSED' }
  }

  function resume(state) {
    if (state.status !== 'PAUSED') return state
    return { ...state, status: 'READY' }
  }

  function replaceArtifact(state, stageId, artifact) {
    assertKnownStage(stageId)
    void runtime.persistHumanEdit?.({ sessionId: state.sessionId, stageId, artifact })
    return {
      ...state,
      artifacts: { ...state.artifacts, [stageId]: artifact },
    }
  }

  async function runNext(state) {
    if (state.status === 'DONE') return state
    if (state.status === 'PAUSED') throw new Error('Workflow is paused')

    const stage = stageById.get(state.cursor)
    if (!stage) throw new Error(`Unknown workflow stage: ${state.cursor}`)
    const executor = executors[stage.id]
    if (typeof executor !== 'function') throw new Error(`Missing executor for stage: ${stage.id}`)

    const previousStage = state.history.at(-1)?.stageId ?? null
    const previousArtifact = previousStage ? state.artifacts[previousStage] : state.input
    const result = await executor({
      state,
      stage,
      input: previousArtifact,
      seereel: state.seereel,
    })

    const artifacts = { ...state.artifacts, [stage.id]: result.artifact }
    const history = [...state.history, { stageId: stage.id }]
    await runtime.persistStageArtifact?.({
      sessionId: state.sessionId,
      stageId: stage.id,
      artifact: result.artifact,
    })

    const nextStage = result.nextStage === undefined ? stage.next : result.nextStage
    if (nextStage === null) {
      return { ...state, artifacts, history, status: 'DONE' }
    }
    assertKnownStage(nextStage)
    return {
      ...state,
      artifacts,
      history,
      cursor: nextStage,
      status: 'READY',
    }
  }

  return { runNext, pause, resume, replaceArtifact }
}
