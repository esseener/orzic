import { defineCheck } from 'orca/testing'
import { deliveryUnknown, executing, extended, mockModels, modelRunning, noProject, planning, planReview, ready, running, unknown, workspaceTask } from './fixtures'

export default defineCheck({
  ready: { requests: { 'flow.snapshot': ready } },
  planning: { requests: { 'flow.snapshot': planning } },
  planReview: { requests: { 'flow.snapshot': planReview } },
  deliveryUnknown: { requests: { 'flow.snapshot': deliveryUnknown } },
  boundaryDraft: { requests: { 'flow.snapshot': ready }, persisted: { workspace: {
    ...workspaceTask, 'task.policy': { allowedPaths: ['src/settings', 'tests'], allowNetwork: false, allowDependencies: false, allowDeletion: false, maxReworks: 2 }
  } } },
  running: { requests: { 'flow.snapshot': running } },
  abandon: { requests: { 'flow.snapshot': executing } },
  customTeam: { requests: { 'flow.snapshot': extended } },
  syncTrouble: { requests: { 'flow.snapshot': unknown } },
  projectNotSelected: { requests: { 'flow.snapshot': noProject } },
  // Check draws the preview; panel.test opens this same scenario through the native settings button.
  modelConfiguredTeam: { requests: { 'flow.snapshot': modelRunning, 'flow.models': mockModels } },
  // Synthetic configured strengths; not local capability or runtime evidence.
  effortConfiguredTeam: { requests: { 'flow.snapshot': {
    ...modelRunning,
    team: { ...modelRunning.team, leadEffort: 'high' },
    run: modelRunning.run ? { ...modelRunning.run, team: { ...modelRunning.run.team, leadEffort: 'low' } } : null
  }, 'flow.models': mockModels } },
  workspaceInstructions: { requests: { 'flow.snapshot': ready }, persisted: { workspace: workspaceTask } }
})
