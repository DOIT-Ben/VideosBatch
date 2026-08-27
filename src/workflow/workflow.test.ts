import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createWorkflowState,
  createWorkflowRunner,
  DEFAULT_STAGE_DEFINITIONS,
  InMemorySeeReelRuntime,
  type StageExecutor,
} from './index.js'

function executors(overrides: Partial<Record<string, StageExecutor>> = {}) {
  const defaults: Record<string, StageExecutor> = {}
  for (const stage of DEFAULT_STAGE_DEFINITIONS) {
    defaults[stage.id] = async ({ state }) => ({
      artifact: { stage: stage.id, from: state.cursor },
    })
  }
  return { ...defaults, ...overrides }
}

test('workflow advances through one ordered chain without spawning agents', async () => {
  const runtime = new InMemorySeeReelRuntime()
  const runner = createWorkflowRunner({ runtime, executors: executors() })
  let state = createWorkflowState('session-1', { lessonText: '小学数学教案' })

  while (state.status !== 'DONE') {
    state = await runner.runNext(state)
  }

  assert.deepEqual(
    state.history.map((item) => item.stageId),
    DEFAULT_STAGE_DEFINITIONS.map((stage) => stage.id),
  )
  assert.equal(runtime.visibleEvents.some((event) => event.type === 'agent_spawned'), false)
})

test('human can pause, edit a visible stage artifact, and resume from that exact stage', async () => {
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

test('failed video review rewinds the same chain instead of creating a repair agent', async () => {
  const runtime = new InMemorySeeReelRuntime()
  const runner = createWorkflowRunner({
    runtime,
    executors: executors({
      VIDEO_REVIEW: async () => ({
        artifact: { passed: false, issues: ['人物动作不一致'] },
        nextStage: 'PROMPT_COMPILE',
      }),
    }),
  })
  let state = createWorkflowState('session-3', { lessonText: '教案' })

  while (state.cursor !== 'VIDEO_REVIEW') state = await runner.runNext(state)
  state = await runner.runNext(state)

  assert.equal(state.cursor, 'PROMPT_COMPILE')
  assert.equal(state.status, 'READY')
  assert.equal(runtime.visibleEvents.some((event) => event.type === 'agent_spawned'), false)
})

test('canonical asset references stay stable until provider compilation', async () => {
  const runtime = new InMemorySeeReelRuntime()
  const runner = createWorkflowRunner({
    runtime,
    executors: executors({
      PROMPT_COMPILE: async () => ({
        artifact: {
          promptDocument: [
            { type: 'text', text: '让' },
            { type: 'reference', referenceId: 'P001-A001' },
            { type: 'text', text: '观察' },
            { type: 'reference', referenceId: 'P001-A002' },
          ],
        },
      }),
    }),
  })
  let state = createWorkflowState('session-4', { lessonText: '教案' })

  while (state.cursor !== 'VIDEO_GENERATION') state = await runner.runNext(state)

  const prompt = state.artifacts.PROMPT_COMPILE as {
    promptDocument: Array<{ type: string; referenceId?: string }>
  }
  assert.deepEqual(
    prompt.promptDocument.filter((node) => node.type === 'reference').map((node) => node.referenceId),
    ['P001-A001', 'P001-A002'],
  )
})
