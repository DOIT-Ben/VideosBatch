import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createWorkflowState,
  createWorkflowRunner,
  DEFAULT_STAGE_DEFINITIONS,
  InMemorySeeReelRuntime,
} from './index.js'

function executors(overrides = {}) {
  const defaults = Object.fromEntries(DEFAULT_STAGE_DEFINITIONS.map((stage) => [
    stage.id,
    async ({ state }) => ({ artifact: { stage: stage.id, from: state.cursor } }),
  ]))
  return { ...defaults, ...overrides }
}

test('lesson workflow advances through one visible ordered chain', async () => {
  const runtime = new InMemorySeeReelRuntime()
  const runner = createWorkflowRunner({ runtime, executors: executors() })
  let state = createWorkflowState('session-1', { lessonText: '小学数学教案' })

  while (state.status !== 'DONE') state = await runner.runNext(state)

  assert.deepEqual(
    state.history.map((item) => item.stageId),
    DEFAULT_STAGE_DEFINITIONS.map((stage) => stage.id),
  )
  assert.deepEqual(
    runtime.visibleEvents.filter((event) => event.type === 'stage_completed').map((event) => event.stageId),
    DEFAULT_STAGE_DEFINITIONS.map((stage) => stage.id),
  )
})

test('human can pause, edit a visible stage artifact, and resume the same chain', async () => {
  const runtime = new InMemorySeeReelRuntime()
  const runner = createWorkflowRunner({ runtime, executors: executors() })
  let state = createWorkflowState('session-2', { lessonText: '教案' })

  state = await runner.runNext(state)
  state = runner.pause(state)
  assert.equal(state.status, 'PAUSED')

  state = runner.replaceArtifact(state, 'LESSON_PLAN', { title: '人工修改后的教学方案' })
  state = runner.resume(state)
  state = await runner.runNext(state)

  assert.deepEqual(state.artifacts.LESSON_PLAN, { title: '人工修改后的教学方案' })
  assert.equal(state.history.at(-1)?.stageId, 'ASSET_PLAN')
})

test('review failure rewinds the same workflow instead of creating a second orchestration graph', async () => {
  const runtime = new InMemorySeeReelRuntime()
  const runner = createWorkflowRunner({
    runtime,
    executors: executors({
      VIDEO_REVIEW: async () => ({
        artifact: { passed: false, issues: ['人物动作不一致'] },
        nextStage: 'STORYBOARD',
      }),
    }),
  })
  let state = createWorkflowState('session-3', { lessonText: '教案' })

  while (state.cursor !== 'VIDEO_REVIEW') state = await runner.runNext(state)
  state = await runner.runNext(state)

  assert.equal(state.cursor, 'STORYBOARD')
  assert.equal(state.status, 'READY')
})

test('existing SeeReel agent/skill context is preserved as opaque runtime state', async () => {
  const runtime = new InMemorySeeReelRuntime()
  const runner = createWorkflowRunner({ runtime, executors: executors() })
  const agentContext = {
    orchestratorSkill: 'seereel-shortdrama',
    handoffUrl: 'https://example.invalid/handoff',
    installedSkills: ['seereel-cli', 'seereel-canvas-review'],
  }
  let state = createWorkflowState('session-4', { lessonText: '教案' }, { agentContext })

  state = await runner.runNext(state)
  state = await runner.runNext(state)

  assert.deepEqual(state.seereel.agentContext, agentContext)
})

test('canonical asset references remain stable until provider execution', async () => {
  const runtime = new InMemorySeeReelRuntime()
  const runner = createWorkflowRunner({
    runtime,
    executors: executors({
      STORYBOARD: async () => ({
        artifact: {
          shots: [{
            id: 'shot-1',
            promptDocument: [
              { type: 'text', text: '让' },
              { type: 'reference', referenceId: 'P001-A001' },
              { type: 'text', text: '观察' },
              { type: 'reference', referenceId: 'P001-A002' },
            ],
          }],
        },
      }),
    }),
  })
  let state = createWorkflowState('session-5', { lessonText: '教案' })

  while (state.cursor !== 'CANVAS_REVIEW') state = await runner.runNext(state)

  const refs = state.artifacts.STORYBOARD.shots[0].promptDocument
    .filter((node) => node.type === 'reference')
    .map((node) => node.referenceId)
  assert.deepEqual(refs, ['P001-A001', 'P001-A002'])
})
