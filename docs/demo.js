import { createState } from './workflow.js'

export const demoActors = [
  { id: 'demo-xu', name: '许青', region: '华东', group: '华东小组', roles: ['member', 'representative', 'coordinator'] },
  { id: 'demo-lin', name: '林澄', region: '华东', group: '华东小组', roles: ['member'] },
  { id: 'demo-chen', name: '陈舟', region: '华南', group: '华南小组', roles: ['member', 'representative'] },
  { id: 'demo-he', name: '何远', region: '华北', group: '华北小组', roles: ['member', 'representative'] },
  { id: 'demo-gu', name: '顾宁', region: '华北', group: '华北小组', roles: ['member', 'reviewer'] }
]

export function createDemo() {
  return { state: createState(), offset: 0, actorId: demoActors[0].id }
}

export function migrateDemo(stored) {
  // The previous demo always created these five motions before user actions.
  const seededMotions = new Set(['M-0001', 'M-0002', 'M-0003', 'M-0004', 'M-0005'])
  const motions = stored.state.motions.filter(motion => !seededMotions.has(motion.id))
  const notices = stored.state.notices.filter(notice =>
    !seededMotions.has(notice.motionId) && !(notice.id === 'N-1' && notice.kind === 'regional')
  )
  // Regional notices intentionally omit the motion ID. The seeded regional notice was always first.
  const reindexedNotices = notices.map((notice, index) => ({ ...notice, id: `N-${notices.length - index}` }))
  return { ...stored, state: { motions, notices: reindexedNotices, nextId: motions.length ? stored.state.nextId : 1 } }
}
