import { applyAction, createState } from './workflow.js'

export const demoActors = [
  { id: 'demo-xu', name: '许青', region: '华东', group: '华东小组', roles: ['member', 'representative', 'coordinator'] },
  { id: 'demo-lin', name: '林澄', region: '华东', group: '华东小组', roles: ['member'] },
  { id: 'demo-chen', name: '陈舟', region: '华南', group: '华南小组', roles: ['member', 'representative'] },
  { id: 'demo-he', name: '何远', region: '华北', group: '华北小组', roles: ['member', 'representative'] },
  { id: 'demo-gu', name: '顾宁', region: '华北', group: '华北小组', roles: ['member', 'reviewer'] }
]

const day = 24 * 60 * 60 * 1000

export function buildDemo(now = Date.now()) {
  let state = createState()
  const [xu, lin, chen, he, gu] = demoActors
  const act = (actor, action, at) => {
    state = applyAction(state, actor, action, at, demoActors)
  }
  const create = (actor, title, description, at, scope = 'national') => {
    act(actor, { type: 'create', title, description, scope }, at)
    return state.motions[0].id
  }
  const at = now - 15 * day
  const regional = create(xu, '华东小组活动记录模板试行', '在华东小组试行统一的活动记录模板，试行一个月后回顾。', at, 'regional')
  for (const actor of [xu, lin]) act(actor, { type: 'vote', motionId: regional, choice: 'yes' }, at + 100)
  act(xu, { type: 'closeBallot', motionId: regional }, at + 200)
  act(xu, { type: 'publish', motionId: regional }, at + 300)

  const resolved = create(chen, '建立季度活动复盘机制', '各小组每季度整理一次活动复盘，由统筹组汇总下一季度需要协作的事项。', now - 13 * day)
  act(gu, { type: 'review', motionId: resolved, accepted: true, mode: 'members', reason: '涉及各地协作，提交全体成员表决。' }, now - 12 * day)
  act(gu, { type: 'closeChallenge', motionId: resolved }, now - 9 * day)
  for (const actor of demoActors) act(actor, { type: 'vote', motionId: resolved, choice: actor === he ? 'abstain' : 'yes' }, now - 8 * day)
  act(gu, { type: 'closeBallot', motionId: resolved }, now - 7 * day)
  act(xu, { type: 'assign', motionId: resolved, owner: chen.id, plan: '整理首期复盘模板，汇总各小组的试用反馈后提交统筹组。' }, now - 6 * day)

  const group = create(he, '建立跨地区资料共享目录', '拟建立供各地区维护的资料目录。各地小组先讨论目录分类和维护分工，由代表按组表决。', now - 6 * day)
  act(gu, { type: 'review', motionId: group, accepted: true, mode: 'delegates', reason: '各地需要讨论资料维护分工，采用代表按组表决。' }, now - 5 * day)
  act(gu, { type: 'closeChallenge', motionId: group }, now - 2 * day)
  act(he, { type: 'discuss', motionId: group, summary: '建议按活动类型整理资料，并安排每月轮值维护。' }, now - day)

  const open = create(lin, '通过跨地区活动协作办法', '拟统一跨地区活动的报名、联络和反馈流程。请审阅草案，并就正式采用协作办法投票。', now - 4 * day)
  act(gu, { type: 'review', motionId: open, accepted: true, mode: 'members', reason: '协作办法涉及所有地区，交由全体正式成员表决。' }, now - 3 * day)
  act(gu, { type: 'closeChallenge', motionId: open }, now - day + 60000)
  act(lin, { type: 'vote', motionId: open, choice: 'yes' }, now - day + 70000)
  act(chen, { type: 'vote', motionId: open, choice: 'abstain' }, now - day + 80000)

  create(xu, '调整年度交流会筹备方式', '提议由各地小组联合组成筹备团队，并在第一次筹备会议前明确各组分工。', now - 5 * 3600000)
  return state
}
