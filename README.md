# 议决台 · council-ballot

根据组织决议投票流程设计的中文工作台。成员发起动议，全国代表查阅通报和提出推翻动议，审核员处理全国动议，统筹组指派执行人并跟进执行报告。

## 在线演示

GitHub Pages 公开演示使用虚构样例，进度仅保存在当前浏览器。通过右上角身份菜单切换成员、全国代表、审核员或统筹组。菜单还可快进演示时间，体验异议期结束、计票和后续处理。

发布设置为仓库 **Settings → Pages → Deploy from a branch → `main` → `/docs`**。公开站点只托管 `docs/` 中的静态演示。

## 组织内正式使用

安装 Node.js 24 或更高版本。在仓库根目录运行以下命令创建账号并启动服务器，无需安装依赖。

```sh
node server.mjs add-user --name 许青 --region 华东 --group 华东小组 --roles member,representative,coordinator
node server.mjs add-user --name 顾宁 --region 华北 --group 华北小组 --roles member,reviewer
node server.mjs add-user --name 林澄 --region 华东 --group 华东小组 --roles member
node server.mjs
```

访问 `http://127.0.0.1:8787`，用 `add-user` 输出的个人登录码登录。各参与地区应配置统筹组角色，各参与代表表决的小组应配置代表。角色可叠加，正式成员需包含 `member` 角色。帐号和登录码由组织运营人员通过安全渠道分发。

- `node server.mjs list-users` 查看账号、角色和账号 ID。
- `node server.mjs rotate-token <ID>` 换发登录码并注销原会话。
- `node server.mjs disable-user <ID>` 停用账号并注销会话。
- `node --test` 运行流程与 HTTP 集成测试。

多人使用时，在组织控制的服务器运行 `server.mjs`，经 HTTPS 反向代理转发到本地监听端口，并设置 `VOTING_ORIGIN` 为实际公开源，例如 `https://vote.example.org`。默认监听 `127.0.0.1:8787`，可通过 `VOTING_HOST` 和 `PORT` 配置。`VOTING_DB` 可指定 SQLite 文件路径，默认使用 `data/voting.sqlite`。帐号、会话、动议和原始选票存放在 SQLite 中，应限制数据库及备份的读取权限。GitHub Pages 演示和正式服务各自使用独立数据。

## 流程规则

- **地区动议**由本地区正式成员投票。地区统筹组结束计票后，可向全国代表发布只含通过与否的通报。
- **全国动议**由审核员接受或停止，并确定原动议的表决方式。全国代表收到审核决定后，可在异议期内提出推翻动议。推翻动议由全国代表一人一票直接表决，通过后撤销原审核决定。
- **原动议表决**采用全体正式成员一人一票，或由各地小组先提交讨论摘要，再由代表按组投票，每组一票。采用代表方式时，有表决资格的小组以已配代表的小组为准。
- **决议执行**由统筹组指派执行人。执行人或统筹组可记录执行报告。表决未通过的原动议以未形成决议结束。审核决定最终停止原动议时，由审核员通报。
- 流程图未指定数值规则。网站预填赞成门槛 51%、最低投票率 50%、投票期 7 天、异议期 48 小时。发起时可按章程调整。赞成率以赞成和反对票为基数，弃权计入投票率。每轮表决按开启时确定的名单计算，投票期截止或全部选票收到后，由有权限的角色结算。
