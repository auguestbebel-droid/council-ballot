const roles = {
  member: '正式成员',
  representative: '全国代表',
  reviewer: '动议审核员',
  coordinator: '统筹组',
}

function escape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function brand() {
  return '<div class="brand"><img src="./favicon.svg?v=3" alt="" width="42" height="42"><span><strong>议决台</strong><small>组织决议工作台</small></span></div>'
}

function textField(label, name, autocomplete = 'off') {
  return `<label class="field"><span>${label}</span><input type="text" name="${name}" maxlength="100" autocomplete="${autocomplete}" required></label>`
}

function formError() {
  return '<div class="form-error" role="alert"></div>'
}

function loginPage() {
  return `<main id="main" class="login-shell"><section class="panel login-card">
    ${brand()}
    <h1>投票管理</h1>
    <p>使用管理员密钥进入选民名册。</p>
    <form class="form" data-submit="admin-login">
      <label class="field"><span>管理员密钥</span><input type="password" name="token" autocomplete="current-password" required></label>
      ${formError()}
      <button type="submit" class="button primary">进入管理</button>
      <button type="button" class="button ghost" data-do="admin-back">返回成员登录</button>
    </form>
  </section></main>`
}

function credentialCard(credential) {
  if (!credential?.token) return ''
  return `<section class="panel section admin-credential" aria-labelledby="credential-heading">
    <h2 id="credential-heading">个人登录码已生成</h2>
    <p>请复制代号和登录码，单独交给对应成员。离开页面后，登录码需要重新生成。</p>
    <label class="field"><span>投票代号</span><input value="${escape(credential.codename)}" readonly></label>
    <label class="field"><span>个人登录码</span><input value="${escape(credential.token)}" readonly spellcheck="false"></label>
  </section>`
}

function createForm() {
  return `<section class="panel section"><h2>新增选民</h2>
    <form class="form" data-submit="admin-create">
      ${textField('投票代号', 'codename')}
      <div class="form-row">${textField('地区', 'region')}${textField('小组', 'group')}</div>
      <fieldset><legend>权限</legend><div class="admin-roles">${Object.entries(roles).map(([value, label]) => `
        <label><input type="checkbox" name="roles" value="${value}"${value === 'member' ? ' checked' : ''}> ${label}</label>`).join('')}</div></fieldset>
      ${formError()}
      <div class="form-actions"><button type="submit" class="button primary">生成个人登录码</button></div>
    </form>
  </section>`
}

function rosterAction(action, user, label, description) {
  return `<form class="form" data-submit="admin-${action}">
    <input type="hidden" name="id" value="${escape(user.id)}">
    <button type="submit" class="button compact${action === 'disable' ? ' danger' : ''}" title="${description}" aria-label="${label} ${escape(user.codename ?? user.name)}">${label}</button>
    ${formError()}
  </form>`
}

function userCard(user) {
  const status = user.enabled ? '可登录' : '已停用'
  const labels = (user.roles ?? []).map(role => roles[role]).filter(Boolean)
  const details = [user.region, user.group, ...labels].filter(Boolean).map(escape).join(' · ')
  return `<li class="admin-user"><div><h3>${escape(user.codename ?? user.name)}</h3><p>${details}</p><p>${status}</p></div>${user.enabled ? `<div class="admin-user-actions">
    ${rosterAction('rotate', user, '换发登录码', '生成新的登录码，旧登录码和会话立即失效。')}
    ${rosterAction('disable', user, '停用账号', '停用后无法登录，已提交选票仍保留。')}
  </div>` : ''}</li>`
}

export function adminPage({ operator = false, users = [], credential = null } = {}) {
  if (!operator) return loginPage()
  return `<main id="main" class="content admin-page" tabindex="-1">
    ${brand()}
    <header class="page-heading"><div><h1>投票管理</h1><p>为每位合资格成员发放一个投票代号和个人登录码。</p></div></header>
    <div class="detail-top admin-actions">
      <button type="button" class="button compact" data-do="admin-back">返回成员登录</button>
      <button type="button" class="button compact" data-do="admin-refresh">刷新名册</button>
      <button type="button" class="button compact ghost" data-do="admin-logout">退出管理</button>
    </div>
    <div class="stack">${credentialCard(credential)}${createForm()}
      <section class="panel section"><h2>选民名册</h2>${users.length ? `<ul class="admin-roster">${users.map(userCard).join('')}</ul>` : '<p>暂无选民。</p>'}</section>
    </div>
  </main>`
}

export function adminRequest(type, fields, request) {
  switch (type) {
    case 'admin-login':
      return request('admin/login', { token: fields.get('token').trim() })
    case 'admin-create':
      return request('admin/users', {
        action: 'create',
        codename: fields.get('codename').trim(),
        region: fields.get('region').trim(),
        group: fields.get('group').trim(),
        roles: fields.getAll('roles'),
      })
    case 'admin-rotate':
      return request('admin/users', { action: 'rotate', id: fields.get('id') })
    case 'admin-disable':
      return request('admin/users', { action: 'disable', id: fields.get('id') })
    default:
      throw new Error('无法识别管理操作。')
  }
}
