# 更新镜像与同域下载入口

状态：本地实现，尚未配置或部署。CNB 仓库尚未创建；Cloudflare/R2 账户资格、额度及下载网络均待验证。不能通过修改变量跳过发布审批或真实升级验收。

## 固定合同

- `download.shhield.ai/<stable|staging>/update.json` 是唯一安装授权入口。Worker 从 R2 binding 读取 `_channels/<channel>.json`，再读取该指针指向的冻结清单，返回同域 200 和 `no-store`。缺失、损坏或不可读取时返回错误，不返回旧清单。
- stable 的 `latest.json`、`latest-mac.yml` 与 `update.json` 使用同一个指针。staging 的 `latest.json` 返回同一份 `update.json`。schema、canonical 包 URL 和已冻结清单字节保持不变。
- R2 的对象 key 与 canonical URL 去掉起始 `/` 后一致。固定版本文件不能覆盖；staging 全部 `no-store`、`noindex`。Worker 流式返回大包，不缓冲整个文件；首版 Range 请求返回完整 200，客户端失败后从头下载。
- 保留 `/staging/healthz` 的 GET/HEAD 响应及 `no-store`、`noindex`，兼容既有运维存活检查；它不证明发布指针或安装包完整，发布验收仍须读取清单和原文件。
- CNB 使用独立公开发布仓库，附件仅为自建且已获准分发的原文件及公开清单。stable tag 为 `v<version>`，staging 为 `staging-v<version>-<source_sha>-<run_id>-<run_attempt>`。不更新 CNB latest，不复制私有源码、凭据或内部验收记录。
- 发布端冻结源码仓库的 `ui/desktop/src/update-mirror-policy.json` 为候选的 `mirror-policy.json`。普通镜像发布要求它与实际发布配置完全一致；只有当前旧版本的 bootstrap 允许缺少该文件。客户端不会接受用户自填下载 URL。
- 所有候选文件在 R2 和 CNB 都匿名读回并通过长度/SHA-256 校验后，才以 ETag 条件写入推进渠道指针。GitHub 保留原归档及 stable 下载后备，展示 latest 不是客户端提交点。

## 开通前需要核实

CNB 发布者需要微信、本人手机号及平台实名认证。其公开 Release 允许匿名下载；本方案使用 CNB 原生地址，公开开通流程未要求另交自有域名 ICP 备案号，不代表业务本身获得备案豁免。使用自有域名接入大陆 CDN 属于另一方案；`.ai` 当前备案适用性需单独核实。

先建立有 `main` 分支的公开发布仓库，记录真实仓库路径。通过自己已批准的安装包验证附件上传、匿名下载、完整重定向链、限流和平台对镜像用法的要求。下载及上传 origin 都逐个记录为 `https://确切主机名`，不能填通配域名、端口、路径或带 token 的 URL。CNB API 地址固定为 `https://api.cnb.cool`；发布令牌只发往该 origin 的本仓库 Release API，不发给附件主机。

确认 R2 Standard 桶、Worker、账户实际用量及费用告警。人民币 100 元/月是项目预算，不是程序实现的账单硬限制。此实现复用 AWS CLI v2 的 S3 API，不自行实现签名；所用 CLI 必须支持 `put-object --if-match/--if-none-match`。当前单文件上传限制为小于 5 GiB，超过时停止，不采用可覆盖文件的退化路径。

## 发布环境配置

在 GitHub 的 `release` 与 `staging-publish` 环境分别配置，保留原审批保护：

| 类型 | 名称 | 用途 |
| --- | --- | --- |
| Variable | `UPDATE_DISTRIBUTION_MODE` | 空或 `legacy` 保留旧发布方式；完成迁移后设置 `mirrors`；其他值报错 |
| Variable | `R2_ACCOUNT_ID`、`R2_RELEASE_BUCKET` | 目标账户和发布桶 |
| Secret | `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY` | 限定目标桶的读写凭据；不写入源码、候选或客户端 |
| Variable | `GLOBAL_MIRROR_PROBE_ORIGIN` | 指向同一桶的 Worker 预览 HTTPS origin，供切流前验证；正常发布读回用户使用的 canonical 域名 |
| Variable | `CNB_RELEASE_REPOSITORY` | 已验证的完整组织/仓库路径 |
| Variable | `CNB_DOWNLOAD_ORIGINS` | 精确下载跳转 origin 的 JSON 数组，与客户端策略完全一致 |
| Variable | `CNB_UPLOAD_ORIGINS` | 精确上传 origin 的 JSON 数组，仅发布端使用 |
| Secret | `CNB_TOKEN` | 仅目标发布仓库所需的 Release 管理和附件上传权限 |

`prepare-candidate` 使用现有 `SOURCE_DEPLOY_KEY` 读取指定源码 SHA 下的公开镜像策略；不重建原包。新增镜像策略为 `null` 的客户端可走旧全球源，但不能晋级至 `mirrors` 发布模式。原 SSH 配置保留，`legacy` staging 仍使用原 publisher。

## 迁移顺序

1. 完成账户与域名核验，把实际 CNB 仓库/下载 origin 写入客户端策略，核对两侧配置；不要提交凭据。
2. 根据 `wrangler.example.jsonc` 建立部署配置，绑定已核实的 R2 桶。先部署到预览域名，不挂载线上路由；本次没有安装或执行 Wrangler。
3. 暂停新版本发布并保存当前路由、GitHub latest、staging PVC `current` 及原清单字节。分别取得两个渠道当前已公布版本的原冻结候选，核对来源、attestation 和候选哈希；不是重新构建当前版本。
4. 在受控发布环境设置上述变量和 `CANDIDATE_SHA256`。stable 还需要现有版本实际已发布的 `latest.json`，时间戳不能重新生成。执行对应 bootstrap：

   ```sh
   node scripts/publish-mirrors.mjs bootstrap /path/to/stable-candidate /path/to/published-latest.json
   node scripts/publish-mirrors.mjs bootstrap /path/to/staging-candidate
   ```

   bootstrap 在同步前后都比对当前权威 `update.json` 的冻结字节。已有不同指针时拒绝覆盖；两个源未通过则不创建指针。它只准备当前版本，不部署路由。
5. 在预览域名验证两个渠道所有兼容清单及固定版本路径，包含 `HEAD`、匿名读取、缓存头和 staging `noindex`。再为原域名挂载 `/stable/*`、`/staging/*`、`/releases/*` 三条 Worker route，保持其他服务不变。安装包旧客户端必须看到同域 200。
6. 确认当前两个渠道与切流前完全一致，再启用两个发布环境的 `mirrors` 模式。恢复发布，先 staging，用更高版本验证旧客户端到新客户端升级；保留 `staging-acceptance` 与 `release` 审批。
7. 至少两个大陆运营商无代理网络及一个海外网络通过清单/完整包下载对比；Windows MSI、macOS 两架构完成真实签名版本升级、换源、拒绝坏包与数据保留后，才能正式上线。

## 重试、撤回与回退

同步或读回失败发生在提交前时，活动指针不变。重跑原发布 job 复用原文件；同名不同内容立即失败，不覆盖、不重建候选。R2 写入采用 `If-None-Match: *`，渠道切换采用读到的 ETag；旧任务不能覆盖更高版本或不同的同版本候选。

条件写入响应丢失时，脚本读回指针确认是否已经提交。同一候选的重试不会再次改写指针。提交后的 GitHub 展示或后续下载验证失败不意味着版本从未公布；先检查权威指针，再幂等重跑，不能盲目回滚或重建。

撤回由维护者在受控环境条件替换指针为先前完整可用的版本，或删除对应指针以暂时停止该渠道的安装授权；不要删除仍被指针引用的冻结文件。指针缺失时 Worker 返回不可用，客户端拒绝安装并保留已完成缓存；恢复清单后重新验证。已安装版本不自动降级。

回退路由前先将旧 GitHub/staging PVC 的发布状态恢复到目标候选，核对所有文件与清单；记录条件写入前后指针及路由。不能只关闭 Worker 然后假定三个存储已经同步。CNB 仅是可替换的下载来源，故障或平台限流时仍保留全球源。

## 验证状态

已添加 `scripts/mirror-distribution.test.mjs` 并接入原 `Test release scripts` 工作流。覆盖双源失败不提交、原文件重试、客户端/发布端策略一致、条件写入冲突、提交响应丢失、Worker 清单不回退及 streaming/HEAD 行为。

当前仅执行语法与 diff 检查，未运行上述测试、真实 AWS/CNB API、Worker 部署或原生升级。需在获得测试授权后通过 GitHub Actions 执行；CI 替身结果仍不能代替真实网络、签名和升级验收。
