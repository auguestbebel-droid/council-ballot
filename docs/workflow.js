const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const modes = ['members', 'delegates']
const choices = ['yes', 'no', 'abstain']
const participantStages = ['discussion', 'ballot', 'assignment', 'execution', 'resolved', 'failed']

export class WorkflowError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WorkflowError'
  }
}

function requireRule(condition, message) {
  if (!condition) throw new WorkflowError(message)
}

function hasRole(actor, role) {
  return actor?.roles?.includes(role) === true
}

function nationalOfficer(actor) {
  return hasRole(actor, 'reviewer') || hasRole(actor, 'coordinator')
}

function representative(actor) {
  return hasRole(actor, 'representative')
}

function coordinator(actor, motion) {
  return hasRole(actor, 'coordinator') &&
    (motion.scope === 'national' || actor.region === motion.region)
}

function actorLabel(actor) {
  return { id: actor.id, name: actor.name }
}

function timeValue(now) {
  const value = new Date(now).getTime()
  requireRule(Number.isFinite(value), '操作时间无效。')
  return value
}

function iso(time) {
  return new Date(time).toISOString()
}

function cleanText(value, name, max) {
  requireRule(typeof value === 'string' && value.trim().length > 0, `请填写${name}。`)
  const trimmed = value.trim()
  requireRule(trimmed.length <= max, `${name}最多填写 ${max} 个字符。`)
  return trimmed
}

function numberRule(value, fallback, min, max, label) {
  const error = `${label}须为 ${min} 到 ${max} 之间的整数。`
  requireRule(value === undefined || typeof value === 'number' ||
    (typeof value === 'string' && /^\d+$/.test(value)), error)
  const number = value === undefined ? fallback : Number(value)
  requireRule(Number.isInteger(number) && number >= min && number <= max, error)
  return number
}

function normalizeRules(value) {
  requireRule(value === undefined || (value && typeof value === 'object' && !Array.isArray(value)),
    '表决规则格式无效。')
  const rules = value ?? {}
  return {
    threshold: numberRule(rules.threshold, 51, 1, 100, '通过门槛'),
    quorum: numberRule(rules.quorum, 50, 0, 100, '最低投票率'),
    days: numberRule(rules.days, 7, 1, 30, '投票天数'),
    challengeHours: numberRule(rules.challengeHours, 48, 1, 720, '推翻动议提出时限')
  }
}

function normalizeRoster(roster, actor) {
  const members = Array.isArray(roster) ? roster : roster?.members ?? []
  const byId = new Map()
  for (const member of [...members, actor]) {
    if (member?.id) byId.set(member.id, member)
  }
  return [...byId.values()]
}

function record(motion, actor, at, label, visibility = 'participants') {
  motion.updatedAt = at
  motion.history.push({ label, at, by: actorLabel(actor), visibility })
}

function visibleMotion(motion, actor) {
  if (motion.scope === 'regional') {
    return !!actor.region && actor.region === motion.region &&
      (hasRole(actor, 'member') || hasRole(actor, 'coordinator') || representative(actor))
  }
  if (motion.author.id === actor.id || nationalOfficer(actor)) return true
  if (motion.stage === 'review') return false
  if (representative(actor)) return true
  return hasRole(actor, 'member') && participantStages.includes(motion.stage)
}

function groupKey(actor) {
  if (!actor.group) return null
  return JSON.stringify([actor.region ?? '', actor.group])
}

function eligibility(roster, scope, mode, region, isOverride = false) {
  if (isOverride) {
    return roster.filter(representative).map(actor => ({ key: actor.id, name: actor.name }))
  }
  if (scope === 'national' && mode === 'delegates') {
    const groups = new Map()
    for (const actor of roster.filter(representative)) {
      const key = groupKey(actor)
      if (key) groups.set(key, { key, name: actor.group, region: actor.region })
    }
    return [...groups.values()]
  }
  return roster.filter(actor =>
    hasRole(actor, 'member') && (scope === 'national' || actor.region === region)
  ).map(actor => ({ key: actor.id, name: actor.name }))
}

function newBallot(electorate, time, rules) {
  return {
    electorate,
    votes: [],
    openedAt: iso(time),
    deadline: iso(time + rules.days * DAY),
    result: null
  }
}

function ballotFor(motion) {
  return motion.stage === 'override' ? motion.challenge.ballot : motion.ballot
}

function ballotIdentity(motion, actor, isOverride) {
  if (isOverride) return representative(actor) ? actor.id : null
  if (motion.scope === 'national' && motion.mode === 'delegates') {
    return representative(actor) ? groupKey(actor) : null
  }
  return hasRole(actor, 'member') ? actor.id : null
}

function canClose(ballot, time) {
  return time >= Date.parse(ballot.deadline) || ballot.votes.length >= ballot.electorate.length
}

function canVote(motion, ballot, actor, time, isOverride) {
  const key = ballotIdentity(motion, actor, isOverride)
  return !!key && !ballot.result && time < Date.parse(ballot.deadline) &&
    ballot.electorate.some(entry => entry.key === key) &&
    !ballot.votes.some(vote => vote.key === key)
}

function tally(ballot, rules) {
  const totals = { yes: 0, no: 0, abstain: 0 }
  for (const vote of ballot.votes) totals[vote.choice]++
  const cast = ballot.votes.length
  const total = ballot.electorate.length
  const decided = totals.yes + totals.no
  const approvalPercent = decided > 0 ? totals.yes * 100 / decided : 0
  const turnoutPercent = total > 0 ? cast * 100 / total : 0
  const quorumMet = total > 0 && cast * 100 >= rules.quorum * total
  return {
    ...totals, cast, total,
    passed: quorumMet && decided > 0 && totals.yes * 100 >= rules.threshold * decided,
    quorumMet, approvalPercent, turnoutPercent
  }
}

function actionsFor(motion, actor, time) {
  const isOfficer = nationalOfficer(actor)
  switch (motion.stage) {
    case 'review':
      return hasRole(actor, 'reviewer') ? ['review'] : []
    case 'challenge':
      if (time < Date.parse(motion.review.deadline)) return representative(actor) ? ['challenge'] : []
      return isOfficer ? ['closeChallenge'] : []
    case 'override': {
      const actions = []
      const ballot = motion.challenge.ballot
      if (canVote(motion, ballot, actor, time, true)) actions.push('vote')
      if ((isOfficer || representative(actor)) && canClose(ballot, time)) actions.push('closeBallot')
      return actions
    }
    case 'discussion': {
      const group = groupKey(actor)
      const actions = []
      if ((hasRole(actor, 'member') || representative(actor)) &&
          motion.discussion.groups.some(entry => entry.key === group) &&
          !motion.discussion.entries.some(entry => entry.key === group)) actions.push('discuss')
      if (isOfficer && motion.discussion.entries.length === motion.discussion.groups.length) {
        actions.push('openBallot')
      }
      return actions
    }
    case 'ballot': {
      const actions = []
      if (canVote(motion, motion.ballot, actor, time, false)) actions.push('vote')
      const canManage = motion.scope === 'regional' ? coordinator(actor, motion) : isOfficer
      if (canManage && canClose(motion.ballot, time)) actions.push('closeBallot')
      return actions
    }
    case 'report':
      return (motion.scope === 'regional' ? coordinator(actor, motion) : hasRole(actor, 'reviewer'))
        ? ['publish'] : []
    case 'assignment':
      return coordinator(actor, motion) ? ['assign'] : []
    case 'execution':
      return coordinator(actor, motion) || motion.resolution.ownerId === actor.id ? ['complete'] : []
    default:
      return []
  }
}

function newMotion(state, actor, action, time, roster) {
  requireRule(hasRole(actor, 'member'), '仅正式成员可以提出动议。')
  requireRule(['regional', 'national'].includes(action.scope), '请选择动议范围。')
  const regional = action.scope === 'regional'
  requireRule(!regional || actor.region, '地区动议需要关联发起人的地区。')
  const mode = regional ? 'members' : action.mode ?? 'members'
  requireRule(modes.includes(mode), '请选择表决方式。')
  const rules = normalizeRules(action.rules)
  const at = iso(time)
  const motion = {
    id: `M-${String(state.nextId).padStart(4, '0')}`,
    title: cleanText(action.title, '动议标题', 100),
    description: cleanText(action.description, '动议正文', 5000),
    scope: action.scope,
    mode,
    region: regional ? actor.region : null,
    author: actorLabel(actor),
    stage: regional ? 'ballot' : 'review',
    rules,
    review: null,
    challenge: null,
    ballot: regional ? newBallot(eligibility(roster, action.scope, mode, actor.region), time, rules) : null,
    discussion: null,
    resolution: null,
    history: [],
    createdAt: at,
    updatedAt: at
  }
  record(motion, actor, at, regional ? '地区动议已提交并开启表决' : '全国动议已提交')
  state.nextId++
  state.motions.unshift(motion)
}

function notice(state, motion, title, summary, at, kind) {
  const id = `N-${state.notices.length + 1}`
  const item = { id, title, summary, at, kind }
  if (motion.scope === 'national') item.motionId = motion.id
  state.notices.unshift(item)
}

function enactReview(motion, proceed, actor, time, roster) {
  const at = iso(time)
  motion.review.effectiveAccepted = proceed
  if (!proceed) {
    motion.stage = 'report'
    record(motion, actor, at, '原动议停止，待审核员通报', 'review')
    return
  }
  const electorate = eligibility(roster, motion.scope, motion.mode, motion.region)
  if (motion.mode === 'delegates') {
    motion.stage = 'discussion'
    motion.discussion = { groups: electorate, entries: [] }
    record(motion, actor, at, '各地小组开始讨论')
    return
  }
  motion.stage = 'ballot'
  motion.ballot = newBallot(electorate, time, motion.rules)
  record(motion, actor, at, '全体成员表决已开启')
}

function applyMotionAction(state, motion, actor, action, time, roster) {
  const at = iso(time)
  switch (action.type) {
    case 'review': {
      requireRule(typeof action.accepted === 'boolean', '请选择接受或停止原动议。')
      requireRule(action.mode === undefined || modes.includes(action.mode), '请选择表决方式。')
      motion.mode = action.mode ?? motion.mode
      const reason = cleanText(action.reason, '审核理由', 1500)
      motion.review = {
        accepted: action.accepted, reason,
        reviewer: actorLabel(actor), at, deadline: iso(time + motion.rules.challengeHours * HOUR)
      }
      motion.stage = 'challenge'
      const summary = action.accepted ? '接受原动议进入表决。' : '停止原动议进入表决。'
      notice(state, motion, motion.title, `${summary}${reason}`, at, 'review')
      record(motion, actor, at, '审核决定已通报全国代表', 'review')
      break
    }
    case 'challenge': {
      const reason = cleanText(action.reason, '推翻理由', 1500)
      const electorate = eligibility(roster, motion.scope, motion.mode, motion.region, true)
      motion.challenge = { reason, by: actorLabel(actor), at, ballot: newBallot(electorate, time, motion.rules) }
      motion.stage = 'override'
      record(motion, actor, at, '推翻动议已由全国代表直接表决', 'review')
      break
    }
    case 'closeChallenge':
      record(motion, actor, at, '提出推翻动议的时限结束，原审核决定生效', 'review')
      enactReview(motion, motion.review.accepted, actor, time, roster)
      break
    case 'discuss': {
      const summary = cleanText(action.summary, '小组讨论摘要', 1500)
      const key = groupKey(actor)
      const group = motion.discussion.groups.find(entry => entry.key === key)
      motion.discussion.entries.push({ key, group: group.name, region: group.region, summary, at, by: actorLabel(actor) })
      record(motion, actor, at, '一个小组已提交讨论摘要')
      break
    }
    case 'openBallot':
      motion.ballot = newBallot(motion.discussion.groups, time, motion.rules)
      motion.stage = 'ballot'
      record(motion, actor, at, '小组讨论已完成，代表按组表决已开启')
      break
    case 'vote': {
      requireRule(choices.includes(action.choice), '请选择赞成、反对或弃权。')
      const key = ballotIdentity(motion, actor, motion.stage === 'override')
      ballotFor(motion).votes.push({ key, voterId: actor.id, choice: action.choice, at })
      break
    }
    case 'closeBallot': {
      const ballot = ballotFor(motion)
      ballot.result = tally(ballot, motion.rules)
      if (motion.stage === 'override') {
        const passed = ballot.result.passed
        record(motion, actor, at, passed ? '推翻动议通过，原审核决定已撤销' : '推翻动议未通过，原审核决定生效', 'review')
        enactReview(motion, passed ? !motion.review.accepted : motion.review.accepted, actor, time, roster)
      } else if (motion.scope === 'regional') {
        motion.stage = 'report'
        record(motion, actor, at, '地区表决已结束，待通报脱敏结果')
      } else {
        motion.stage = ballot.result.passed ? 'assignment' : 'failed'
        record(motion, actor, at, ballot.result.passed ? '原动议表决通过，待指派执行人' : '原动议表决未通过，未形成决议')
      }
      break
    }
    case 'publish':
      if (motion.scope === 'regional') {
        const passed = motion.ballot.result.passed
        notice(state, motion, '地区表决结果', passed ? '一项地区内部动议已表决通过。' : '一项地区内部动议表决未通过。', at, 'regional')
        motion.stage = passed ? 'resolved' : 'failed'
        record(motion, actor, at, '脱敏结果已通报全国代表')
      } else {
        const summary = cleanText(action.summary, '处理结果', 1500)
        notice(state, motion, motion.title, summary, at, 'disposition')
        motion.stage = 'stopped'
        record(motion, actor, at, '停止处理的结果已通报全国代表', 'review')
      }
      break
    case 'assign': {
      const selectedOwner = cleanText(action.owner, '执行人', 120)
      const named = roster.filter(person => person.name === selectedOwner)
      const owner = roster.find(person => person.id === selectedOwner) ?? (named.length === 1 ? named[0] : null)
      const plan = cleanText(action.plan, '执行计划', 3000)
      motion.resolution = { owner: owner?.name ?? selectedOwner, ownerId: owner?.id ?? null, plan, assignedAt: at, summary: null, completedAt: null }
      motion.stage = 'execution'
      record(motion, actor, at, '已形成组织决议并指派执行人，执行情况向统筹组报告')
      break
    }
    case 'complete':
      motion.resolution.summary = cleanText(action.summary, '执行报告', 3000)
      motion.resolution.completedAt = at
      motion.stage = 'resolved'
      record(motion, actor, at, '执行报告已提交统筹组')
      break
  }
}

export function createState() {
  return { motions: [], notices: [], nextId: 1 }
}

export function applyAction(state, actor, action, now = Date.now(), roster = []) {
  requireRule(!!actor?.id && Array.isArray(actor.roles), '请先登录。')
  requireRule(action && typeof action.type === 'string', '操作无效。')
  const time = timeValue(now)
  const next = structuredClone(state)
  const members = normalizeRoster(roster, actor)
  if (action.type === 'create') {
    newMotion(next, actor, action, time, members)
    return next
  }
  const motion = next.motions.find(item => item.id === action.motionId)
  requireRule(motion && visibleMotion(motion, actor), '找不到该动议。')
  requireRule(actionsFor(motion, actor, time).includes(action.type), '当前身份或流程阶段无法执行此操作。')
  applyMotionAction(next, motion, actor, action, time, members)
  return next
}

function viewBallot(motion, ballot, actor, time, isOverride) {
  if (!ballot) return null
  const key = ballotIdentity(motion, actor, isOverride)
  const vote = ballot.votes.find(entry => entry.key === key)
  return {
    openedAt: ballot.openedAt,
    deadline: ballot.deadline,
    cast: ballot.votes.length,
    total: ballot.electorate.length,
    myVote: vote?.voterId === actor.id ? vote.choice : null,
    hasVoted: !!vote,
    canVote: canVote(motion, ballot, actor, time, isOverride),
    result: ballot.result ? { ...ballot.result } : null
  }
}

function viewMotion(motion, actor, time) {
  const canSeeReview = nationalOfficer(actor) || representative(actor) || motion.author.id === actor.id
  const myGroup = groupKey(actor)
  const discussion = motion.discussion && {
    completed: motion.discussion.entries.length,
    total: motion.discussion.groups.length,
    myGroupDone: motion.discussion.entries.some(entry => entry.key === myGroup),
    entries: motion.discussion.entries
      .filter(entry => nationalOfficer(actor) || entry.key === myGroup)
      .map(({ key, ...entry }) => entry)
  }
  let challenge = null
  if (canSeeReview && motion.challenge) {
    const { reason, by, at, ballot } = motion.challenge
    challenge = { reason, by, at, ...viewBallot(motion, ballot, actor, time, true) }
  }
  return {
    id: motion.id,
    title: motion.title,
    description: motion.description,
    scope: motion.scope,
    mode: motion.mode,
    region: motion.region,
    author: motion.author,
    stage: motion.stage,
    createdAt: motion.createdAt,
    updatedAt: motion.updatedAt,
    rules: motion.rules,
    review: canSeeReview ? motion.review : null,
    challenge,
    ballot: viewBallot(motion, motion.ballot, actor, time, false),
    discussion,
    resolution: motion.resolution,
    history: motion.history
      .filter(entry => entry.visibility !== 'review' || canSeeReview)
      .map(({ visibility, ...entry }) => entry),
    allowedActions: actionsFor(motion, actor, time)
  }
}

export function viewState(state, actor, now = Date.now()) {
  if (!actor?.id || !Array.isArray(actor.roles)) return { motions: [], notices: [] }
  const time = timeValue(now)
  const notices = representative(actor) ? state.notices : []
  return structuredClone({
    motions: state.motions.filter(motion => visibleMotion(motion, actor)).map(motion => viewMotion(motion, actor, time)),
    notices
  })
}
