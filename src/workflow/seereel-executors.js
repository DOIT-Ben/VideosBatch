export function createSeeReelStageExecutors(runtime) {
  return {
    LESSON_PLAN: async ({ state, input }) => ({
      artifact: await runtime.callModel({
        stageId: 'LESSON_PLAN',
        sessionId: state.sessionId,
        promptId: 'videosbatch.lesson-plan.v1',
        input,
        seereel: state.seereel,
      }),
    }),

    ASSET_PLAN: async ({ state, input }) => ({
      artifact: await runtime.callModel({
        stageId: 'ASSET_PLAN',
        sessionId: state.sessionId,
        promptId: 'videosbatch.asset-plan.v1',
        input,
        seereel: state.seereel,
      }),
    }),

    ASSET_GENERATION: async ({ state, input }) => ({
      artifact: await runtime.generateAssets({
        stageId: 'ASSET_GENERATION',
        sessionId: state.sessionId,
        plan: input,
        seereel: state.seereel,
      }),
    }),

    STORYBOARD: async ({ state, input }) => ({
      artifact: await runtime.syncStoryboard({
        stageId: 'STORYBOARD',
        sessionId: state.sessionId,
        promptId: 'videosbatch.storyboard.v1',
        input,
        seereel: state.seereel,
      }),
    }),

    CANVAS_REVIEW: async ({ state, input }) => {
      const review = await runtime.reviewCanvas({
        stageId: 'CANVAS_REVIEW',
        sessionId: state.sessionId,
        input,
        seereel: state.seereel,
      })
      return {
        artifact: review,
        ...(review.passed === false && review.retryStage ? { nextStage: review.retryStage } : {}),
      }
    },

    VIDEO_GENERATION: async ({ state, input }) => ({
      artifact: await runtime.generateVideos({
        stageId: 'VIDEO_GENERATION',
        sessionId: state.sessionId,
        storyboard: input,
        seereel: state.seereel,
      }),
    }),

    VIDEO_REVIEW: async ({ state, input }) => {
      const review = await runtime.reviewVideos({
        stageId: 'VIDEO_REVIEW',
        sessionId: state.sessionId,
        input,
        seereel: state.seereel,
      })
      return {
        artifact: review,
        ...(review.passed === false && review.retryStage ? { nextStage: review.retryStage } : {}),
      }
    },

    STITCH: async ({ state, input }) => ({
      artifact: await runtime.stitch({
        stageId: 'STITCH',
        sessionId: state.sessionId,
        input,
        seereel: state.seereel,
      }),
    }),
  }
}
