# 议决台 · council-ballot

根据组织决议投票流程设计的中文工作台。成员发起动议，全国代表查阅通报和提出推翻动议，审核员处理全国动议，统筹组指派执行人并跟进执行报告。

## 在线投票

GitHub Pages 是公开入口，实际登录与投票在链接指向的正式站点进行。选民使用组织代号和管理员单独发放的个人登录码。代号可以是自选网名，由管理员按合资格名册登记，一名选民只登记一个账号。

正式站点的「名册管理」需要独立管理员密钥。管理员可登记代号、地区、小组和权限，生成、换发或停用个人登录码。请私下交付登录码。每轮表决由服务器校验资格和已投票状态。按人表决时每个账号一票，代表按组表决时每组一票。新账号不会加入已经开启的表决。

GitHub Pages 设置为 **Settings → Pages → Deploy from a branch → `main` → `/docs`**。正式托管 Worker 位于 `site/`，使用 D1 绑定 `DB` 和独立的 `OPERATOR_CODE_HASH` 密钥配置。`site/build.mjs` 可构建包含投票界面和迁移脚本的部署包。

## 组织内正式使用

安装 Node.js 24 或更高版本。在仓库根目录运行以下命令创建账号并启动服务器，无需安装依赖。

```sh
node server.mjs add-user --codename 青松 --region 华东 --group 华东小组 --roles member,representative,coordinator
node server.mjs add-user --codename 北辰 --region 华北 --group 华北小组 --roles member,reviewer
node server.mjs add-user --codename 红叶 --region 华东 --group 华东小组 --roles member
node server.mjs
```

访问 `http://127.0.0.1:8787`，用 `add-user` 输出的代号和个人登录码登录。各参与地区应配置统筹组角色，各参与代表表决的小组应配置代表。角色可叠加，正式成员需包含 `member` 角色。账号和登录码由组织运营人员单独分发。

- `node server.mjs list-users` 查看账号、角色和账号 ID。
- `node server.mjs rotate-token <ID>` 换发登录码并注销原会话。
- `node server.mjs disable-user <ID>` 停用账号并注销会话。
- `node --test` 运行流程与 HTTP 集成测试。

自行托管时，在组织控制的服务器运行 `server.mjs`，经 HTTPS 反向代理转发到本地监听端口，并设置 `VOTING_ORIGIN` 为实际公开源，例如 `https://vote.example.org`。默认监听 `127.0.0.1:8787`，可通过 `VOTING_HOST` 和 `PORT` 配置。`VOTING_DB` 可指定 SQLite 文件路径，默认使用 `data/voting.sqlite`。请限制对账号、会话、动议、原始选票和数据库备份的读取权限。

## 流程规则

- **地区动议**由本地区正式成员投票。地区统筹组结束计票后，可向全国代表发布只含通过与否的通报。
- **全国动议**由审核员接受或停止，并确定原动议的表决方式。全国代表收到审核决定后，可在异议期内提出推翻动议。推翻动议由全国代表一人一票直接表决，通过后撤销原审核决定。
- **原动议表决**采用全体正式成员一人一票，或由各地小组先提交讨论摘要，再由代表按组投票，每组一票。采用代表方式时，有表决资格的小组以已配代表的小组为准。
- **决议执行**由统筹组指派执行人。执行人或统筹组可记录执行报告。表决未通过的原动议以未形成决议结束。审核决定最终停止原动议时，由审核员通报。
- 流程图未指定数值规则。网站预填赞成门槛 51%、最低投票率 50%、投票期 7 天、异议期 48 小时。发起时可按章程调整。赞成率以赞成和反对票为基数，弃权计入投票率。每轮表决按开启时确定的名单计算，投票期截止或全部选票收到后，由有权限的角色结算。
