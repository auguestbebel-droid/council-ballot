import test from 'node:test'
import assert from 'node:assert/strict'
import { applyAction, createState, viewState, WorkflowError } from '../docs/workflow.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const start = Date.parse('2026-11-01T00:00:00Z')
const afterChallenge = start + HOUR
const rules = { threshold: 51, quorum: 50, days: 1, challengeHours: 1 }
const motionId = 'M-0001'

function person(id, region, group, extraRoles = []) {
  return { id, name: id, region, group, roles: ['member', ...extraRoles] }
}

const author = person('author', '北区', '一组')
const reviewer = person('reviewer', '北区', '一组', ['reviewer'])
const north = person('north', '北区', '一组', ['representative', 'coordinator'])
const northAlternate = person('alternate', '北区', '一组', ['representative'])
const south = person('south', '南区', '一组', ['representative'])
const outsider = person('outsider', '南区', '一组')
const roster = [author, reviewer, north, northAlternate, south, outsider]

function act(state, actor, type, data = {}, at = start) {
  return applyAction(state, actor, { type, motionId, ...data }, at, roster)
}

function submit(scope = 'national', mode = 'members') {
  return act(createState(), author, 'create', { scope, mode, rules, title: '动议的标题', description: '动议的内容' })
}

function review(state, accepted = true, mode = 'members') {
  return act(state, reviewer, 'review', { accepted, mode, reason: '审核理由' })
}

function visible(state, actor, at = start) {
  return viewState(state, actor, at).motions[0]
}

test('regional outcome is sanitized and withheld until publication', () => {
  let state = submit('regional', 'delegates')
  assert.equal(visible(state, author).mode, 'members')
  assert.equal(visible(state, author).ballot.total, 4)
  assert.equal(visible(state, south), undefined)
  assert.throws(() => act(state, south, 'vote', { choice: 'yes' }), WorkflowError)
  state = act(state, author, 'vote', { choice: 'yes' })
  state = act(state, reviewer, 'vote', { choice: 'abstain' })
  assert.throws(() => act(state, author, 'vote', { choice: 'yes' }), WorkflowError)
  assert.throws(() => act(state, north, 'closeBallot'), WorkflowError)
  assert.throws(() => act(state, north, 'vote', { choice: 'yes' }, start + DAY), WorkflowError)
  state = act(state, north, 'closeBallot', {}, start + DAY)
  assert.equal(visible(state, author).ballot.result.passed, true)
  assert.deepEqual(viewState(state, south).notices, [])
  state = act(state, north, 'publish', { summary: '敏感文本' }, start + DAY)
  assert.equal(visible(state, author).stage, 'resolved')
  const regional = viewState(state, south)
  assert.deepEqual(regional.motions, [])
  assert.deepEqual(Object.keys(regional.notices[0]).sort(), ['at', 'id', 'kind', 'summary', 'title'])
  assert.equal(regional.notices[0].summary, '一项地区内部动议已表决通过。')
  assert.deepEqual(viewState(state, outsider).notices, [])
})

test('unchallenged national acceptance opens member vote and assigns execution', () => {
  let state = submit()
  assert.equal(visible(state, south), undefined)
  state = review(state)
  assert.equal(viewState(state, south).notices[0].kind, 'review')
  assert.equal(visible(state, outsider), undefined)
  assert.throws(() => act(state, north, 'closeChallenge'), WorkflowError)
  assert.throws(() => act(state, south, 'challenge', { reason: '逾时' }, afterChallenge), WorkflowError)
  state = act(state, north, 'closeChallenge', {}, afterChallenge)
  const beforeVotes = state
  for (const voter of roster) {
    state = act(state, voter, 'vote', { choice: 'yes' }, afterChallenge)
  }
  assert.equal(visible(beforeVotes, author, afterChallenge).ballot.cast, 0)
  assert.equal(visible(state, outsider, afterChallenge).review, null)
  assert.equal(visible(state, outsider, afterChallenge).ballot.myVote, 'yes')
  assert.equal(visible(state, outsider, afterChallenge).ballot.votes, undefined)
  assert.equal(visible(state, outsider, afterChallenge).ballot.result, null)
  state = act(state, north, 'closeBallot', {}, afterChallenge)
  assert.equal(visible(state, author, afterChallenge).stage, 'assignment')
  assert.throws(() => act(state, north, 'assign', { owner: '', plan: '计划' }, afterChallenge), WorkflowError)
  state = act(state, north, 'assign', { owner: author.id, plan: '执行计划' }, afterChallenge)
  assert.equal(visible(state, author, afterChallenge).resolution.owner, author.name)
  assert.throws(() => act(state, outsider, 'complete', { summary: '无权限' }, afterChallenge), WorkflowError)
  state = act(state, author, 'complete', { summary: '完成执行并报告' }, afterChallenge)
  assert.equal(visible(state, author, afterChallenge).stage, 'resolved')
})

test('approved overturn reverses rejection and opens group discussion before group ballot', () => {
  let state = review(submit(), false, 'delegates')
  assert.throws(() => act(state, author, 'challenge', { reason: '理由' }), WorkflowError)
  state = act(state, south, 'challenge', { reason: '代表理由' })
  assert.equal(visible(state, south).challenge.total, 3)
  assert.throws(() => act(state, reviewer, 'vote', { choice: 'yes' }), WorkflowError)
  assert.throws(() => act(state, north, 'challenge', { reason: '重复提出' }), WorkflowError)
  state = act(state, north, 'vote', { choice: 'yes' })
  state = act(state, northAlternate, 'vote', { choice: 'yes' })
  state = act(state, south, 'vote', { choice: 'no' })
  state = act(state, south, 'closeBallot')
  assert.equal(visible(state, south).review.effectiveAccepted, true)
  assert.equal(visible(state, south).stage, 'discussion')
  assert.equal(visible(state, south).discussion.total, 2)
  assert.throws(() => act(state, north, 'openBallot'), WorkflowError)
  assert.throws(() => act(state, north, 'vote', { choice: 'yes' }), WorkflowError)
  state = act(state, author, 'discuss', { summary: '北区讨论' })
  assert.deepEqual(visible(state, south).discussion.entries, [])
  assert.throws(() => act(state, northAlternate, 'discuss', { summary: '重复摘要' }), WorkflowError)
  state = act(state, outsider, 'discuss', { summary: '南区讨论' })
  state = act(state, north, 'openBallot')
  assert.equal(visible(state, author).ballot.total, 2)
  state = act(state, north, 'vote', { choice: 'yes' })
  assert.equal(visible(state, northAlternate).ballot.myVote, null)
  assert.equal(visible(state, northAlternate).ballot.hasVoted, true)
  assert.throws(() => act(state, northAlternate, 'vote', { choice: 'yes' }), WorkflowError)
  state = act(state, south, 'vote', { choice: 'no' })
  state = act(state, north, 'closeBallot')
  assert.equal(visible(state, author).stage, 'failed')
})

test('approved overturn reverses acceptance and requires reviewer disposition', () => {
  let state = review(submit())
  state = act(state, south, 'challenge', { reason: '代表理由' })
  for (const actor of [north, northAlternate, south]) state = act(state, actor, 'vote', { choice: 'yes' })
  state = act(state, south, 'closeBallot')
  assert.equal(visible(state, south).review.effectiveAccepted, false)
  assert.equal(visible(state, south).stage, 'report')
  assert.throws(() => act(state, north, 'publish', { summary: '处理结果' }), WorkflowError)
  state = act(state, reviewer, 'publish', { summary: '停止原动议表决。' })
  assert.equal(visible(state, south).stage, 'stopped')
  assert.equal(viewState(state, south).notices[0].kind, 'disposition')
})

test('unsuccessful overturn preserves both original decisions', () => {
  for (const accepted of [true, false]) {
    let state = review(submit(), accepted)
    state = act(state, south, 'challenge', { reason: '代表理由' })
    state = act(state, south, 'vote', { choice: 'yes' })
    state = act(state, south, 'closeBallot', {}, start + DAY)
    const motion = visible(state, south, start + DAY)
    assert.equal(motion.challenge.result.quorumMet, false)
    assert.equal(motion.review.effectiveAccepted, accepted)
    assert.equal(motion.stage, accepted ? 'ballot' : 'report')
  }
})

test('zero and abstention-only ballots do not pass', () => {
  for (const votes of [[], [author, reviewer, north, northAlternate]]) {
    let state = submit('regional')
    for (const actor of votes) state = act(state, actor, 'vote', { choice: 'abstain' })
    state = act(state, north, 'closeBallot', {}, start + DAY)
    assert.equal(visible(state, author).ballot.result.passed, false)
  }
})
