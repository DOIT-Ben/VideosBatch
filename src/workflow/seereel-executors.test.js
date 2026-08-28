import test from 'node:test'
import assert from 'node:assert/strict'

import { createSeeReelStageExecutors } from './seereel-executors.js'

function fakeRuntime() {
  const calls = []
  return {
    calls,
    async callModel(input) { calls.push(['callModel', input.stageId]); return { stageId: input.stageId } },
    async generateAssets(input) { calls.push(['generateAssets', input.stageId]); return { assets: [] } },
    async syncStoryboard(input) { calls.push(['syncStoryboard', input.stageId]); return { shots: [] } },
    async reviewCanvas(input) { calls.push(['reviewCanvas', input.stageId]); return { passed: true, issues: [] } },
    async generateVideos(input) { calls.push(['generateVideos', input.stageId]); return { renders: [] } },
    async reviewVideos(input) { calls.push(['reviewVideos', input.stageId]); return { passed: true, issues: [] } },
    async stitch(input) { calls.push(['stitch', input.stageId]); return { url: 'final.mp4' } },
  }
}

test('stage executors inject lesson workflow into existing SeeReel capabilities', async () => {
  const runtime = fakeRuntime()
  const executors = createSeeReelStageExecutors(runtime)
  const state = { sessionId: 's1', artifacts: {}, seereel: { agentContext: { enabled: true } } }

  await executors.LESSON_PLAN({ state, input: { lessonText: '教案' } })
  await executors.ASSET_PLAN({ state, input: { title: '教学方案' } })
  await executors.ASSET_GENERATION({ state, input: { assets: [] } })
  await executors.STORYBOARD({ state, input: { assets: [] } })
  await executors.CANVAS_REVIEW({ state, input: { shots: [] } })
  await executors.VIDEO_GENERATION({ state, input: { shots: [] } })
  await executors.VIDEO_REVIEW({ state, input: { renders: [] } })
  await executors.STITCH({ state, input: { renders: [] } })

  assert.deepEqual(runtime.calls, [
    ['callModel', 'LESSON_PLAN'],
    ['callModel', 'ASSET_PLAN'],
    ['generateAssets', 'ASSET_GENERATION'],
    ['syncStoryboard', 'STORYBOARD'],
    ['reviewCanvas', 'CANVAS_REVIEW'],
    ['generateVideos', 'VIDEO_GENERATION'],
    ['reviewVideos', 'VIDEO_REVIEW'],
    ['stitch', 'STITCH'],
  ])
})

test('review executors can route back inside the same chain', async () => {
  const runtime = fakeRuntime()
  runtime.reviewCanvas = async () => ({ passed: false, issues: ['分镜缺少必要资产'], retryStage: 'ASSET_PLAN' })
  runtime.reviewVideos = async () => ({ passed: false, issues: ['镜头人物漂移'], retryStage: 'STORYBOARD' })
  const executors = createSeeReelStageExecutors(runtime)
  const state = { sessionId: 's2', artifacts: {}, seereel: {} }

  const canvas = await executors.CANVAS_REVIEW({ state, input: { shots: [] } })
  const video = await executors.VIDEO_REVIEW({ state, input: { renders: [] } })

  assert.equal(canvas.nextStage, 'ASSET_PLAN')
  assert.equal(video.nextStage, 'STORYBOARD')
})
