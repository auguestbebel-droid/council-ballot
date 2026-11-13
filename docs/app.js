import { adminPage, adminRequest } from './admin.js?v=4'

const app = document.querySelector('#app')
const dialog = document.querySelector('#dialog')
const toast = document.querySelector('#toast')
const roles = { member: '正式成员', reviewer: '动议审核员', representative: '全国代表', coordinator: '统筹组', admin: '管理员' }
const stages = { review: '待审核', challenge: '异议期', override: '推翻表决', discussion: '小组讨论', ballot: '表决中', report: '待通报', assignment: '待指派', execution: '执行中', resolved: '已完成', failed: '未形成决议', stopped: '已停止' }
const actionNames = { review: '提交审核决定', challenge: '提出推翻动议', closeChallenge: '确认审核决定生效', discuss: '提交讨论摘要', openBallot: '开启代表表决', vote: '提交选票', closeBallot: '结束表决并计票', publish: '发布通报', assign: '指派执行人', complete: '提交执行报告' }
const choices = { yes: '赞成', no: '反对', abstain: '弃权' }
const modes = { members: '全体成员表决', delegates: '代表按组表决' }
const nav = { home: ['◫', '工作台'], motions: ['≡', '全部动议'], tasks: ['✓', '我的待办'], notices: ['◉', '通报中心'], resolutions: ['◇', '决议档案'], flow: ['⇢', '流程说明'] }
const apiBase = new URL('./api/', window.location.href)
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const longDateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full' })
const { mode, votingUrl, admin: adminEnabled } = document.documentElement.dataset
const isPortal = mode === 'portal'
let operator = false
let users = []
let credential = null
let actor = null
let state = { motions: [], notices: [] }
let page = 'home'
let detailId = null
let previousPage = 'motions'
let search = ''
let filterStage = ''
let filterScope = ''
let toastTimer
let refreshGeneration = 0

const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
const icon = glyph => `<span class="icon" aria-hidden="true">${glyph}</span>`
const button = (action, title, className = '', glyph = '') => `<button type="button" class="button ${className}" data-do="${action}">${glyph ? icon(glyph) : ''}${esc(title)}</button>`
const date = at => at ? dateFormat.format(new Date(at)) : '—'
const time = at => `<time datetime="${esc(at)}">${date(at)}</time>`
const badge = stage => `<span class="badge ${stage}">${stages[stage]}</span>`
const roleLabel = person => person.roles.filter(role => role !== 'member').map(role => roles[role]).join(' · ') || '正式成员'
const scopeLabel = motion => motion.scope === 'regional' ? (motion.region || '地区') : '全国'
const canCreate = () => actor?.roles.includes('member')
const isResolution = motion => motion.scope === 'national' && !!motion.resolution
const isVoting = motion => ['ballot', 'override'].includes(motion.stage)
const sorted = motions => [...motions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

function displayToast(message) {
  clearTimeout(toastTimer)
  toast.textContent = message
  toast.hidden = false
  toastTimer = setTimeout(() => { toast.hidden = true }, 4200)
}

async function request(path, payload) {
  const response = await fetch(new URL(path, apiBase), {
    cache: 'no-store',
    ...(payload === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(data?.error || '请求失败，请稍后重试。')
    error.status = response.status
    throw error
  }
  return data
}

async function fetchLiveState() {
  const { actor: signedIn, state: safeState } = await request('state')
  actor = signedIn
  state = safeState
}

function navTo(target) {
  page = target
  detailId = null
  search = ''
  filterStage = ''
  filterScope = ''
  render(true)
}

function actorMarkup(person) {
  return `<span class="avatar" aria-hidden="true">${esc([...person.name][0])}</span><span class="actor-label"><strong>${esc(person.name)}</strong><small>${esc(roleLabel(person))}</small></span>`
}

function brand() {
  return `<img src="./favicon.svg?v=3" alt="" width="42" height="42"><span><strong>议决台</strong><small>组织决议工作台</small></span>`
}

function shell(content) {
  const activePage = page === 'detail' ? previousPage : page
  const taskCount = state.motions.filter(motion => motion.allowedActions.length).length
  const navigation = Object.entries(nav).map(([id, [glyph, label]]) => `<button type="button" data-do="nav:${id}" ${activePage === id ? 'aria-current="page"' : ''}>${icon(glyph)}<span>${label}</span>${id === 'tasks' && taskCount ? `<span class="count">${taskCount}</span>` : ''}</button>`).join('')
  return `<div class="shell"><aside class="sidebar"><button type="button" class="brand" data-do="nav:home">${brand()}</button><p class="nav-title">工作空间</p><nav class="nav" aria-label="主要导航">${navigation}</nav><div class="sidebar-footer"><span class="mode-chip">正式空间</span><small>${esc(actor.region || '全国工作空间')}</small></div></aside><div class="workspace"><header class="topbar"><div class="crumb"><span>组织空间</span><span aria-hidden="true">/</span><strong>${page === 'detail' ? '动议详情' : nav[page][1]}</strong></div><div class="top-actions">${button('refresh', '刷新', 'compact', '↻')}<button type="button" class="actor" data-do="actor" aria-label="账号菜单">${actorMarkup(actor)}<span class="chevron" aria-hidden="true">⌄</span></button></div></header><main id="main" class="content" tabindex="-1">${content}</main></div></div>`
}

function heading(title, summary, end = '') {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${summary}</p></div>${end}</div>`
}

function noticeList(notices) {
  if (!notices.length) return '<p class="empty">当前身份暂无可查看的通报。</p>'
  return `<div class="notice-list">${notices.map(item => `<article class="notice">${icon(item.kind === 'regional' ? '◈' : '◉')}<div><h3>${esc(item.title)}</h3><p>${esc(item.summary)}</p>${time(item.at)}${item.motionId && state.motions.some(motion => motion.id === item.motionId) ? ` ${button(`motion:${item.motionId}`, '查看动议', 'ghost compact')}` : ''}</div></article>`).join('')}</div>`
}

function getPageMotions() {
  if (page === 'tasks') return sorted(state.motions.filter(motion => motion.allowedActions.length))
  if (page === 'resolutions') return sorted(state.motions.filter(isResolution))
  return sorted(state.motions)
}

function tableRows() {
  const query = search.trim().toLocaleLowerCase()
  const matches = getPageMotions().filter(motion => (!filterStage || (filterStage === 'voting' ? isVoting(motion) : motion.stage === filterStage)) && (!filterScope || motion.scope === filterScope) && (!query || `${motion.title} ${motion.id}`.toLocaleLowerCase().includes(query)))
  if (!matches.length) return `<p class="empty">${search || filterStage || filterScope ? '没有匹配的动议。' : '这里还没有动议。'}</p>`
  return matches.map(motion => `<button type="button" class="motion-row" data-do="motion:${esc(motion.id)}"><span><strong>${esc(motion.title)}</strong><small>${esc(motion.id)} · ${date(motion.updatedAt)}</small></span><span class="row-scope">${esc(scopeLabel(motion))}</span>${badge(motion.stage)}<span class="row-arrow" aria-hidden="true">›</span></button>`).join('')
}

function table(title, summary, compact = false) {
  return `<section class="panel"><header class="panel-head"><div><h2>${title}</h2><p>${summary}</p></div>${compact ? button('nav:motions', '查看全部', 'ghost compact', '↗') : canCreate() && page === 'motions' ? button('create', '发起动议', 'primary compact', '+') : ''}</header><div class="filters"><input class="search" type="search" id="motion-search" aria-label="搜索动议" placeholder="搜索标题或编号" value="${esc(search)}"><select id="filter-stage" aria-label="筛选状态"><option value="">全部状态</option>${Object.entries({ voting: '全部表决中', ...stages }).map(([key, label]) => `<option value="${key}" ${key === filterStage ? 'selected' : ''}>${label}</option>`).join('')}</select><select id="filter-scope" aria-label="筛选范围"><option value="">全部范围</option><option value="national" ${filterScope === 'national' ? 'selected' : ''}>全国</option><option value="regional" ${filterScope === 'regional' ? 'selected' : ''}>地区</option></select></div><div class="table"><div class="table-head" aria-hidden="true"><span>动议</span><span class="row-scope">范围</span><span>进度</span><span></span></div><div id="motion-rows">${tableRows()}</div></div></section>`
}

function home() {
  const metrics = [
    ['≡', '可见动议', state.motions.length, 'nav:motions'],
    ['✓', '我的待办', state.motions.filter(motion => motion.allowedActions.length).length, 'nav:tasks'],
    ['◈', '正在表决', state.motions.filter(isVoting).length, 'voting'],
    ['◇', '已形成决议', state.motions.filter(isResolution).length, 'nav:resolutions']
  ]
  return `${heading('工作台', '查看动议进展，处理待办事项。', `<p class="page-date">${icon('▦')}${longDateFormat.format(Date.now())}</p>`)}<section class="hero"><div><h2>${canCreate() ? '发起组织动议' : '查看组织动议'}</h2><p>地区事务由本地区表决。全国动议经审核与通报后，按指定方式表决。</p><div class="hero-actions">${canCreate() ? button('create', '发起动议', 'hero-main', '+') : button('nav:motions', '查看动议', 'hero-main')}${button('nav:flow', '查看投票流程', 'hero-alt', '↗')}</div></div></section><div class="metrics">${metrics.map(([glyph, label, value, target]) => `<button class="metric" type="button" data-do="${target}"><span class="metric-icon icon" aria-hidden="true">${glyph}</span><span><span class="caption">${label}</span><b>${value}</b></span></button>`).join('')}</div><div class="board">${table('动议一览', '按最近更新排序', true)}<div class="side-stack"><section class="panel"><header class="panel-head"><div><h2>最新通报</h2><p>发给全国代表的流程通报</p></div>${button('nav:notices', '全部', 'ghost compact', '↗')}</header>${noticeList(state.notices.slice(0, 3))}</section><section class="guide">${button('nav:flow', '查看流程说明', 'ghost compact', '⇢')}<p>查看审核、表决、通报与执行的步骤。</p></section></div></div>`
}

function flowNode(title, description = '', kind = '') {
  return `<div class="flow-node ${kind}"><strong>${title}</strong>${description ? `<p>${description}</p>` : ''}</div>`
}

function flowArrow(label = '', fromRight = false) {
  return `<div class="flow-arrow${fromRight ? ' flow-from-right' : ''}"${label ? '' : ' aria-hidden="true"'}>${label ? `<span>${label}</span>` : ''}<i aria-hidden="true"></i></div>`
}

function flowSplit(left, right) {
  return `<ul class="flow-split" role="list">${[left, right].map(([label, content]) => `
    <li>${flowArrow(label)}${content}</li>`).join('')}</ul>`
}

function mobileFlowDiagram() {
  return `<div class="flow-mobile">
    ${flowNode('正式成员发起动议', '', 'flow-start')}
    ${flowArrow()}
    ${flowNode('仅涉及地区内部事务？', '', 'flow-decision')}
    ${flowSplit(
      ['是 · 地区事务', `${flowNode('地区自行表决', '仅限本地区成员参与。')}${flowArrow()}${flowNode('脱敏后通报全国代表', '只公布通过与否。', 'flow-end')}`],
      ['否 · 全国动议', `${flowNode('动议审核员作出决定', '决定是否接受原动议，并确定表决范围和方式。')}${flowArrow()}${flowNode('审核决定通报全国代表')}`],
    )}
    ${flowArrow('全国动议继续', true)}
    ${flowNode('异议期内有代表提出推翻动议？', '', 'flow-decision')}
    ${flowSplit(
      ['否 · 异议期届满', flowNode('原审核决定生效')],
      ['是 · 提出推翻动议', flowNode('全国代表直接表决', '全国代表按人投票，无需审核员审核。')],
    )}
    ${flowArrow('提出推翻动议时', true)}
    ${flowNode('推翻动议通过？', '', 'flow-decision')}
    ${flowSplit(
      ['否', flowNode('原审核决定生效')],
      ['是', flowNode('撤销原审核决定', '原决定接受则改为停止，原决定停止则改为发起投票。')],
    )}
    ${flowArrow('依据生效的审核决定')}
    ${flowNode('原动议是否进入投票？', '', 'flow-decision')}
    ${flowSplit(
      ['否 · 停止原动议', flowNode('审核员通报处理结果', '', 'flow-end')],
      ['是 · 进入表决', flowNode('按选定方式表决')],
    )}
    ${flowArrow('原动议进入投票时', true)}
    ${flowNode('采用哪种表决方式？', '', 'flow-decision')}
    ${flowSplit(
      ['代表表决', `${flowNode('各地小组先讨论')}${flowArrow()}${flowNode('代表按组投票')}`],
      ['全体成员表决', flowNode('成员直接投票')],
    )}
    ${flowArrow('原动议计票')}
    ${flowNode('表决通过？', '', 'flow-decision')}
    ${flowSplit(
      ['否', flowNode('本次表决未形成决议', '', 'flow-end')],
      ['是', flowNode('形成组织决议', '统筹组指派执行人。执行情况向统筹组报告。', 'flow-end flow-confirmed')],
    )}
  </div>`
}

function flowDiagram() {
  return `<figure class="panel flow-diagram" aria-labelledby="flow-diagram-title">
    <figcaption><h2 id="flow-diagram-title">组织决议投票流程图</h2></figcaption>
    <div class="flow-desktop">
    <div class="flow-diagram-entry">
      ${flowNode('正式成员发起动议', '', 'flow-start')}
      ${flowArrow()}
      ${flowNode('仅涉及地区内部事务？', '', 'flow-decision')}
    </div>
    <ul class="flow-branches flow-routes" role="list">
      <li>
        ${flowArrow('是 · 地区事务')}
        <div class="flow-lane">
          ${flowNode('地区自行表决', '仅限本地区成员参与。')}
          ${flowArrow()}
          ${flowNode('脱敏后通报全国代表', '只公布通过与否。', 'flow-end')}
        </div>
      </li>
      <li>
        ${flowArrow('否 · 全国动议')}
        <div class="flow-lane">
          ${flowNode('动议审核员作出决定', '决定是否接受原动议，并确定表决范围和方式。')}
          ${flowArrow()}
          ${flowNode('审核决定通报全国代表')}
          ${flowArrow()}
          ${flowNode('异议期内有代表提出推翻动议？', '', 'flow-decision')}
          <ul class="flow-branches" role="list">
            <li>
              ${flowArrow('否 · 异议期届满')}
              ${flowNode('原审核决定生效')}
            </li>
            <li>
              ${flowArrow('是 · 提出推翻动议')}
              ${flowNode('全国代表直接表决', '全国代表按人投票，无需审核员审核。')}
              ${flowArrow()}
              ${flowNode('推翻动议通过？', '', 'flow-decision')}
              <ul class="flow-branches flow-compact" role="list">
                <li>
                  ${flowArrow('否')}
                  ${flowNode('原审核决定生效')}
                </li>
                <li>
                  ${flowArrow('是')}
                  ${flowNode('撤销原审核决定', '原决定接受则改为停止，原决定停止则改为发起投票。')}
                </li>
              </ul>
            </li>
          </ul>
          ${flowArrow('依据生效决定')}
          ${flowNode('原动议是否进入投票？', '', 'flow-decision')}
          <ul class="flow-branches" role="list">
            <li>
              ${flowArrow('否 · 停止原动议')}
              ${flowNode('审核员通报处理结果', '', 'flow-end')}
            </li>
            <li>
              ${flowArrow('是 · 进入表决')}
              ${flowNode('采用哪种表决方式？', '', 'flow-decision')}
              <ul class="flow-branches flow-compact" role="list">
                <li>
                  ${flowArrow('代表表决')}
                  ${flowNode('各地小组先讨论')}
                  ${flowArrow()}
                  ${flowNode('代表按组投票')}
                </li>
                <li>
                  ${flowArrow('全体成员表决')}
                  ${flowNode('成员直接投票')}
                </li>
              </ul>
              ${flowArrow('原动议计票')}
              ${flowNode('表决通过？', '', 'flow-decision')}
              <ul class="flow-branches flow-compact" role="list">
                <li>
                  ${flowArrow('否')}
                  ${flowNode('本次表决未形成决议', '', 'flow-end')}
                </li>
                <li>
                  ${flowArrow('是')}
                  ${flowNode('形成组织决议', '统筹组指派执行人。执行情况向统筹组报告。', 'flow-end flow-confirmed')}
                </li>
              </ul>
            </li>
          </ul>
        </div>
      </li>
    </ul>
    </div>
    ${mobileFlowDiagram()}
  </figure>`
}

function flowPage() {
  const steps = [
    ['正式成员发起动议', '选择地区事务或全国事务。地区成员自行表决，结束后由本地区统筹组向全国代表发布脱敏结果。'],
    ['审核全国动议', '审核员决定接受或停止原动议，并设定表决方式。审核决定发布给全国代表。'],
    ['全国代表可提出推翻动议', '异议期内，任一全国代表可发起推翻表决。全国代表直接按人投票。通过则撤销原审核决定，未通过则按原决定处理。'],
    ['按表决方式处理', '停止的动议由审核员通报。进入表决的动议可由全体成员直接投票，或在各地小组讨论完毕后由代表按组投票。'],
    ['形成决议并跟进执行', '表决未通过时结束流程。通过后由统筹组指派执行人，执行报告提交给统筹组。']
  ]
  return `${heading('投票流程', '各角色在动议处理中的职责。')}${flowDiagram()}<div class="detail-grid"><section class="panel section"><h2>动议如何推进</h2><ol class="flow-steps">${steps.map(([title, info]) => `<li><div><h3>${title}</h3><p>${info}</p></div></li>`).join('')}</ol></section><section class="panel section"><h2>计票规则</h2><p>赞成率以赞成票和反对票为基数。弃权票计入投票率。达到最低投票率和赞成门槛方可通过，零票或全部弃权均无法通过。</p><p>通过门槛、最低投票率、投票期和异议期在发起动议时设置。每轮表决按开启时确定的名单计票。</p></section></div>`
}

function stats(result) {
  return `<div class="result">${Object.entries(choices).map(([value, label]) => `<span><b>${result[value]}</b>${label}</span>`).join('')}</div><p>${result.passed ? '表决通过' : '表决未通过'} · 赞成率 ${result.approvalPercent.toFixed(1)}% · 投票率 ${result.turnoutPercent.toFixed(1)}%</p>`
}

function ballotMarkup(ballot) {
  const selection = ballot.myVote ? `已投${choices[ballot.myVote]}票。` : ballot.hasVoted ? '你所在的小组已投票。' : ''
  return `<p>已收到 ${ballot.cast} / ${ballot.total} 票 · 截止 ${time(ballot.deadline)}</p><progress class="progress" max="${ballot.total || 1}" value="${ballot.cast}" aria-label="表决进度"></progress>${selection ? `<p>${selection}</p>` : ''}${ballot.result ? stats(ballot.result) : ''}`
}

function motionDetail(motion) {
  const actionButtons = motion.allowedActions.map(action => button(`action:${action}`, actionNames[action], action === 'vote' ? 'primary' : '')).join('')
  const review = motion.review
  const challenge = motion.challenge
  const discussion = motion.discussion
  const resolution = motion.resolution
  const hints = { review: '等待动议审核员决定是否接受原动议并确定表决方式。', challenge: '全国代表可在异议期内提出推翻动议。', override: '全国代表按人直接表决。', discussion: '全部有表决资格的小组提交摘要后，即可开启代表表决。', ballot: '投票截止或所有选票提交后，有权限的角色可结束表决。', report: motion.scope === 'regional' ? '地区统筹组可发布脱敏结果。' : '等待审核员通报停止处理结果。', assignment: '表决已通过，等待统筹组指派执行人。', execution: '执行人或统筹组可提交执行报告。', resolved: '此动议流程已完成。', failed: '本次表决未形成决议。', stopped: '原动议已停止，处理结果已通报。' }
  return `<div class="detail-top">${button('back', '返回', 'compact', '‹')}${badge(motion.stage)}<span class="row-scope">${esc(motion.id)}</span></div><header class="panel detail-head"><h1>${esc(motion.title)}</h1><p>${esc(scopeLabel(motion))} · ${esc(motion.author.name)} · ${time(motion.createdAt)}</p><p>${esc(motion.description)}</p></header><div class="detail-grid"><div class="stack"><section class="panel section"><h2>当前进度</h2><p class="stage-hint">${hints[motion.stage]}</p>${actionButtons ? `<div class="inline-actions">${actionButtons}</div>` : ''}</section>${review ? `<section class="panel section"><h2>审核决定</h2><p><strong>${review.accepted ? '接受原动议' : '停止原动议'}</strong> · ${esc(review.reviewer.name)} · ${time(review.at)}</p><p>${esc(review.reason)}</p><p>异议截止 ${time(review.deadline)}</p>${typeof review.effectiveAccepted === 'boolean' ? `<p>最终处理结果：${review.effectiveAccepted ? '进入原动议表决' : '停止原动议表决'}</p>` : ''}</section>` : ''}${challenge ? `<section class="panel section"><h2>推翻动议表决</h2><p>${esc(challenge.by.name)}提出 · ${esc(challenge.reason)}</p>${ballotMarkup(challenge)}</section>` : ''}${discussion ? `<section class="panel section"><h2>小组讨论</h2><p>已提交摘要 ${discussion.completed} / ${discussion.total} 组</p>${discussion.entries.map(entry => `<h3>${esc(entry.group)}</h3><p>${esc(entry.summary)}</p>`).join('')}</section>` : ''}${motion.ballot ? `<section class="panel section"><h2>原动议表决</h2>${ballotMarkup(motion.ballot)}</section>` : ''}${resolution ? `<section class="panel section"><h2>决议执行</h2><p>执行人：${esc(resolution.owner)} · ${time(resolution.assignedAt)}</p><h3>执行计划</h3><p>${esc(resolution.plan)}</p>${resolution.summary ? `<h3>执行报告</h3><p>${esc(resolution.summary)}</p><p>提交于 ${time(resolution.completedAt)}</p>` : ''}</section>` : ''}</div><div class="stack"><section class="panel section"><h2>表决规则</h2><p>${motion.scope === 'regional' ? '地区成员表决' : modes[motion.mode]}</p><div class="rule-grid"><div>赞成门槛<strong>${motion.rules.threshold}%</strong></div><div>最低投票率<strong>${motion.rules.quorum}%</strong></div><div>投票期<strong>${motion.rules.days} 天</strong></div>${motion.scope === 'national' ? `<div>异议期<strong>${motion.rules.challengeHours} 小时</strong></div>` : ''}</div></section><section class="panel section"><h2>流程记录</h2><ol class="timeline">${[...motion.history].reverse().map(entry => `<li><div><strong>${esc(entry.label)}</strong>${time(entry.at)}</div></li>`).join('')}</ol></section></div></div>`
}

function login() {
  const entry = isPortal
    ? `<p>请使用名册中的组织代号和个人登录码。</p>${votingUrl ? `<a class="button primary portal-link" href="${esc(votingUrl)}">进入正式投票</a>` : '<p role="status">正式投票服务正在配置。</p>'}`
    : `<p>使用组织代号和管理员发给你的个人登录码。</p><form class="form" data-submit="login">${field('组织代号', '<input name="codename" autocomplete="username" maxlength="100" required>')}${field('个人登录码', '<input type="password" name="token" autocomplete="current-password" maxlength="128" required>')}<div class="form-error" role="alert"></div><button type="submit" class="button primary">登录</button></form>`
  const links = `<div class="login-links">${button('nav:flow', '流程说明', 'ghost compact')}${adminEnabled ? '<a href="#admin" class="button ghost compact">名册管理</a>' : ''}</div>`
  return `<main id="main" class="login-shell"><section class="panel login-card"><div class="brand">${brand()}</div><h1>${isPortal ? '组织决议投票' : '进入组织空间'}</h1>${entry}${links}</section></main>`
}

function render(focus = false) {
  if (adminEnabled && window.location.hash === '#admin') {
    app.innerHTML = adminPage({ operator, users, credential })
    return
  }
  if (!actor) {
    app.innerHTML = page === 'flow'
      ? `<main id="main" class="content" tabindex="-1"><div class="detail-top">${button('nav:home', '返回入口', 'compact', '‹')}</div>${flowPage()}</main>`
      : login()
    if (focus) document.querySelector('#main').focus({ preventScroll: true })
    return
  }
  const activeMotion = state.motions.find(motion => motion.id === detailId)
  if (page === 'detail' && !activeMotion) page = previousPage
  let content
  if (page === 'detail') content = motionDetail(activeMotion)
  else if (page === 'home') content = home()
  else if (page === 'flow') content = flowPage()
  else if (page === 'notices') content = `${heading('通报中心', '审核决定、停止处理结果和地区脱敏通报。')}<section class="panel">${noticeList(state.notices)}</section>`
  else {
    const copy = { motions: ['全部动议', '浏览当前身份有权限查看的动议。'], tasks: ['我的待办', '当前身份可处理的审核、表决与执行事项。'], resolutions: ['决议档案', '查看已形成的组织决议与执行报告。'] }
    const [title, summary] = copy[page]
    content = `${heading(title, summary)}<div class="board single">${table(title, '按最近更新排序')}</div>`
  }
  app.innerHTML = shell(content)
  if (focus) {
    window.scrollTo(0, 0)
    document.querySelector('#main').focus({ preventScroll: true })
  }
}

function showDialog(title, body) {
  dialog.innerHTML = `<header class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2>${button('dismiss', '关闭', 'compact', '×')}</header><div class="dialog-body">${body}</div>`
  if (!dialog.open) dialog.showModal()
  dialog.querySelector('input:not([type="radio"]), textarea, select, button')?.focus()
}

function formDialog(title, action, contents, submit = title) {
  showDialog(title, `<form class="form" data-submit="${action}">${contents}<div class="form-error" role="alert"></div><div class="form-actions">${button('dismiss', '取消')}<button type="submit" class="button primary">${esc(submit)}</button></div></form>`)
}

function field(label, control, help = '') {
  return `<label class="field"><span>${label}</span>${control}${help ? `<small>${help}</small>` : ''}</label>`
}

function textArea(name, label, max, help = '') {
  return field(label, `<textarea name="${name}" required maxlength="${max}"></textarea>`, help)
}

function modeField(mode) {
  return field('表决方式', `<select name="mode">${Object.entries(modes).map(([value, label]) => `<option value="${value}" ${value === mode ? 'selected' : ''}>${label}</option>`).join('')}</select>`)
}

function numberField(name, label, value, min, max) {
  return field(label, `<input name="${name}" type="number" value="${value}" min="${min}" max="${max}" step="1" required>`)
}

function createDialog() {
  const title = field('动议标题', '<input name="title" required maxlength="100">')
  const scope = field('事务范围', `<select name="scope"><option value="national">全国事务</option>${actor.region ? '<option value="regional">仅涉及本地区</option>' : ''}</select>`)
  formDialog('发起动议', 'create', `${title}${textArea('description', '动议正文', 5000)}${scope}<fieldset><legend>表决规则</legend><p class="form-help">请按组织章程调整。地区动议按本地区成员计票，全国动议由审核员确定表决方式。</p><div class="form-row">${numberField('threshold', '赞成门槛（%）', 51, 1, 100)}${numberField('quorum', '最低投票率（%）', 50, 0, 100)}${numberField('days', '投票期（天）', 7, 1, 30)}<span id="challenge-rule">${numberField('challengeHours', '异议期（小时）', 48, 1, 720)}</span></div></fieldset>`, '提交动议')
}

function actionDialog(action) {
  const motion = state.motions.find(item => item.id === detailId)
  if (!motion?.allowedActions.includes(action)) return
  const paragraphs = {
    closeChallenge: '异议期已结束。确认后，原审核决定将生效。',
    openBallot: '全部有表决资格的小组均已提交讨论摘要。确认后，每组可由一位代表提交一票。',
    closeBallot: '确认后将停止接收选票并按本轮规则公布计票结果。'
  }
  let fields = ''
  if (action === 'review') {
    fields = `${field('审核决定', '<select name="accepted"><option value="true">接受原动议</option><option value="false">停止原动议</option></select>')}${modeField(motion.mode)}${textArea('reason', '审核理由', 1500, '审核决定与理由将通报全国代表。')}`
  } else if (action === 'challenge') {
    fields = `${textArea('reason', '推翻理由', 1500)}<p class="form-help">提交后直接开启全国代表表决。通过即撤销原审核决定。</p>`
  } else if (action === 'discuss') {
    fields = textArea('summary', '小组讨论摘要', 1500, '同一小组提交一份摘要。')
  } else if (action === 'vote') {
    fields = `<fieldset><legend>选择表决意见</legend><div class="vote-options">${Object.entries(choices).map(([value, label]) => `<label><span><input type="radio" name="choice" value="${value}" required>${label}</span></label>`).join('')}</div></fieldset><p class="form-help">提交后选票即生效。</p>`
  } else if (action === 'publish') {
    fields = motion.scope === 'regional' ? '<p class="form-help">通报仅包含通过或未通过的结果，全国代表可以查看。</p>' : textArea('summary', '停止处理结果', 1500)
  } else if (action === 'assign') {
    fields = `${field('执行人', '<input name="owner" required maxlength="120">', '可填写账号编号或组织代号，便于执行人提交报告。')}${textArea('plan', '执行计划', 3000, '执行情况向统筹组报告。')}`
  } else if (action === 'complete') {
    fields = textArea('summary', '提交给统筹组的执行报告', 3000)
  } else if (paragraphs[action]) {
    fields = `<p class="form-help">${paragraphs[action]}</p>`
  }
  formDialog(actionNames[action], action, fields)
}

function showActorMenu() {
  showDialog('当前账号', `<p>${esc(actor.name)} · ${esc(roleLabel(actor))}</p><p>${esc([actor.region, actor.group, actor.id].filter(Boolean).join(' · '))}</p><div class="form-actions">${button('logout', '退出登录', 'danger')}</div>`)
}

async function refreshRoster() {
  const roster = await request('admin/users')
  users = roster.users
}

async function logout() {
  await request('logout', {})
  refreshGeneration++
  actor = null
  operator = false
  credential = null
  users = []
  state = { motions: [], notices: [] }
  page = 'home'
  dialog.close()
  render()
}

async function updateFromServer() {
  const generation = ++refreshGeneration
  try {
    const payload = await request('state')
    if (generation !== refreshGeneration) return
    actor = payload.actor
    state = payload.state
    render()
  } catch (error) {
    if (generation !== refreshGeneration) return
    if (error.status === 401) {
      actor = null
      state = { motions: [], notices: [] }
      dialog.close()
      render()
    } else {
      displayToast(error.message)
    }
  }
}

function routeAction(command) {
  const [type, value] = command.split(':')
  if (type === 'nav') return navTo(value)
  if (type === 'back') return navTo(previousPage)
  if (type === 'voting') {
    navTo('motions')
    filterStage = 'voting'
    return render()
  }
  if (type === 'motion') {
    previousPage = page === 'detail' ? previousPage : page
    detailId = value
    page = 'detail'
    return render(true)
  }
  if (type === 'actor' && actor) return showActorMenu()
  if (type === 'admin-back') { window.location.hash = ''; return }
  if (type === 'admin-refresh') return refreshRoster().then(() => { credential = null; render() }).catch(error => displayToast(error.message))
  if (type === 'refresh') return updateFromServer()
  if (type === 'logout' || type === 'admin-logout') return logout().catch(error => displayToast(error.message))
  if (type === 'dismiss') return dialog.close()
  if (type === 'create' && canCreate()) return createDialog()
  if (type === 'action') return actionDialog(value)
  if (type === 'retry') return start()
}

function createPayload(type, fields) {
  if (type === 'create') {
    const { title, description, scope, threshold, quorum, days, challengeHours } = fields
    return { type, title, description, scope, rules: { threshold: Number(threshold), quorum: Number(quorum), days: Number(days), challengeHours: Number(challengeHours ?? 48) } }
  }
  return { ...fields, type, motionId: detailId, ...(type === 'review' ? { accepted: fields.accepted === 'true' } : {}) }
}

async function submitForm(form) {
  const type = form.dataset.submit
  const formData = new FormData(form)
  const fields = Object.fromEntries(formData)
  const submit = form.querySelector('[type="submit"]')
  const errorArea = form.querySelector('.form-error')
  errorArea.textContent = ''
  submit.disabled = true
  try {
    if (type === 'login') {
      await request('login', { codename: fields.codename.trim(), token: fields.token.trim() })
      operator = false
      users = []
      credential = null
      await fetchLiveState()
      navTo('home')
      return
    }
    if (type.startsWith('admin-')) {
      if (type === 'admin-disable' && !window.confirm('停用此账号并结束其当前会话？')) return
      if (type === 'admin-rotate' && !window.confirm('换发个人登录码并结束此账号当前会话？')) return
      const response = await adminRequest(type, formData, request)
      if (type === 'admin-login') {
        operator = response.operator === true
        actor = null
        state = { motions: [], notices: [] }
      }
      credential = response.token ? response : null
      await refreshRoster().catch(error => displayToast(error.message))
      render()
      return
    }
    const payload = createPayload(type, fields)
    const existing = new Set(state.motions.map(motion => motion.id))
    refreshGeneration++
    const updated = await request('actions', payload)
    refreshGeneration++
    actor = updated.actor
    state = updated.state
    dialog.close()
    if (type === 'create') {
      const newMotion = state.motions.find(motion => !existing.has(motion.id) && motion.author.id === actor.id && motion.title === payload.title.trim())
      if (newMotion) return routeAction(`motion:${newMotion.id}`)
    }
    render()
    displayToast(type === 'vote' ? '选票已提交。' : '操作已完成。')
  } catch (error) {
    if (error.status === 401 && !['login', 'admin-login'].includes(type)) {
      dialog.close()
      actor = null
      operator = false
      credential = null
      users = []
      state = { motions: [], notices: [] }
      render()
      displayToast('登录已过期，请重新登录。')
    } else {
      errorArea.textContent = error.message
    }
  } finally {
    submit.disabled = false
  }
}

document.addEventListener('click', event => {
  const target = event.target.closest('[data-do]')
  if (target) routeAction(target.dataset.do)
})

document.addEventListener('input', event => {
  if (event.target.id !== 'motion-search') return
  search = event.target.value
  document.querySelector('#motion-rows').innerHTML = tableRows()
})

document.addEventListener('change', event => {
  if (event.target.id === 'filter-stage') filterStage = event.target.value
  else if (event.target.id === 'filter-scope') filterScope = event.target.value
  else if (event.target.name === 'scope') {
    const challengeRule = dialog.querySelector('#challenge-rule')
    if (challengeRule) {
      challengeRule.hidden = event.target.value === 'regional'
      challengeRule.querySelector('input').disabled = challengeRule.hidden
    }
    return
  } else return
  document.querySelector('#motion-rows').innerHTML = tableRows()
})

document.addEventListener('submit', event => {
  if (!event.target.dataset.submit) return
  event.preventDefault()
  submitForm(event.target)
})

window.addEventListener('hashchange', () => {
  credential = null
  render()
})

async function start() {
  try {
    if (!isPortal) {
      const session = await request('session')
      if (!session || !Object.hasOwn(session, 'actor')) throw new Error('服务暂时无法连接。')
      operator = session.operator === true
      if (session.actor) await fetchLiveState()
      if (operator) await refreshRoster()
    }
    render()
  } catch (error) {
    app.innerHTML = `<main id="main" class="login-shell"><section class="panel login-card"><h1>无法打开工作台</h1><p>${esc(error.message)}</p>${button('retry', '重试', 'primary')}</section></main>`
  }
}

start()
