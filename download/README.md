# 更新镜像与同域下载入口

状态（2026-11-06）：两个渠道已发布的 1.0.20 原候选已同步到 R2 和 CNB，全部文件经匿名读回和完整哈希校验后初始化渠道指针。三条 `download.shhield.ai` 路由已接入 Worker，六份兼容清单保持原字节，安装包 HEAD 检查通过。GitHub `staging-publish` 与 `release` 的 `UPDATE_DISTRIBUTION_MODE` 均已设为 `mirrors`。本次按维护者授权先切流，再在新的 staging 签名包上真机验收；`staging-acceptance` 与 `release` 审批保护保持不变。

## 已准备的资源

- CNB：[`shhield-ai/shhield-ai-releases`](https://cnb.cool/shhield-ai/shhield-ai-releases)，公开仓库，`main` 已初始化。令牌列表已核实仅限该仓库，授权为 `repo-release:rw`。
- R2：`shhield-releases`，Standard 存储，直接公开访问关闭；与已有备份桶分离。令牌列表已核实仅限该桶的对象读写权限，状态为活动。
- 用户已把凭据保存至两个发布环境，真实上传、读回和条件写入已通过。首次 R2 请求返回 `SignatureDoesNotMatch`，用户修正两个环境的凭据后重试成功；原始 AWS 诊断和签名 URL 不写入日志。CNB 实际令牌显示永久有效，与 90 天表单草稿不同；R2 列表未显示到期时间，轮换按最终令牌状态管理。
- Worker `shhield-downloads` 已部署，预览 origin 为 `https://shhield-downloads.lijy0717.workers.dev`，`RELEASES` 绑定为 `shhield-releases`。线上 `/stable/*`、`/staging/*`、`/releases/*` 三条 routes 已保存并记录在 `wrangler.jsonc`，使用默认失败关闭模式。
- CNB 上传和下载 origin 均实测为 `https://asset.cnb.cool`，已写入两个发布环境；客户端启用配置见[源码 PR #260](https://github.com/gavin-k/shhield-ai/pull/260)。账户费用告警、不同地区网络表现和真实签名版本升级仍待验收。

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
| Variable | `R2_ACCOUNT_ID`、`R2_RELEASE_BUCKET` | 分别为 `3e87efa04e6357d6f423001eb9c69798`、`shhield-releases` |
| Secret | `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY` | 限定目标桶的读写凭据；不写入源码、候选或客户端 |
| Variable | `GLOBAL_MIRROR_PROBE_ORIGIN` | 指向同一桶的 Worker 预览 HTTPS origin，供切流前验证；正常发布读回用户使用的 canonical 域名 |
| Variable | `CNB_RELEASE_REPOSITORY` | `shhield-ai/shhield-ai-releases` |
| Variable | `CNB_DOWNLOAD_ORIGINS` | 精确下载跳转 origin 的 JSON 数组，与客户端策略完全一致 |
| Variable | `CNB_UPLOAD_ORIGINS` | 精确上传 origin 的 JSON 数组，仅发布端使用 |
| Secret | `CNB_TOKEN` | 仅目标发布仓库所需的 Release 管理和附件上传权限 |

`prepare-candidate` 使用现有 `SOURCE_DEPLOY_KEY` 读取指定源码 SHA 下的公开镜像策略；不重建原包。新增镜像策略为 `null` 的客户端可走旧全球源，但不能晋级至 `mirrors` 发布模式。原 SSH 配置保留，`legacy` staging 仍使用原 publisher。

## 迁移顺序

受保护的执行入口是 **Initialize update mirrors**（`bootstrap-mirrors.yml`），仅允许 `main`，与日常发布共用渠道并发锁。输入当前版本的原 Release run ID 和 `staging` / `production`；它复用原候选 artifact，核对原 run、attestation 和全部文件哈希，不重新打包。

先用 `mode=probe` 向 CNB 上传候选中已经公开的 `update.json`，验证匿名下载字节并输出精确上传/下载 origins；结果 artifact 仅包含仓库和 origins，不包含令牌、签名 URL、源码或内部验收记录。探测不会推进渠道指针。将实测结果写入两侧变量与客户端策略后，用 `mode=bootstrap` 分别初始化两个当前渠道。production 仍经过 `release` 环境审批，既有审批规则保持有效。

1. 完成账户与域名核验，把实际 CNB 仓库/下载 origin 写入客户端策略，核对两侧配置；不要提交凭据。
2. 审核 `wrangler.jsonc` 中的账户与 R2 binding，先发布到 `workers.dev` 预览域名，不挂载线上路由。此步已完成，部署证据见下文。R2 的对象访问凭据不能替代 Worker 部署授权。
3. 暂停新版本发布并保存当前路由、GitHub latest、staging PVC `current` 及原清单字节。分别取得两个渠道当前已公布版本的原冻结候选，核对来源、attestation 和候选哈希；不是重新构建当前版本。
4. 在受控发布环境设置上述变量和 `CANDIDATE_SHA256`。stable 还需要现有版本实际已发布的 `latest.json`，时间戳不能重新生成。执行对应 bootstrap：

   ```sh
   node scripts/publish-mirrors.mjs bootstrap /path/to/stable-candidate /path/to/published-latest.json
   node scripts/publish-mirrors.mjs bootstrap /path/to/staging-candidate
   ```

   bootstrap 在同步前后都比对当前权威 `update.json` 的冻结字节。已有不同指针时拒绝覆盖；两个源未通过则不创建指针。它只准备当前版本，不部署路由。
5. 在预览域名验证两个渠道所有兼容清单及固定版本路径，包含 `HEAD`、匿名读取、缓存头和 staging `noindex`。再为原域名挂载 `/stable/*`、`/staging/*`、`/releases/*` 三条 Worker route，保持其他服务不变。安装包旧客户端必须看到同域 200。
6. 确认当前两个渠道与切流前完全一致，再启用两个发布环境的 `mirrors` 模式。恢复发布，先 staging，用更高版本验证旧客户端到新客户端升级；保留 `staging-acceptance` 与 `release` 审批。
7. 本次维护者选择先切流，在新 staging 签名包上完成真机验收。至少两个大陆运营商无代理网络及一个海外网络的清单/完整包下载对比，以及 Windows MSI、macOS 两架构的真实升级、换源、拒绝坏包与数据保留仍需记录；未实测不得标记通过。正式候选继续走原有晋级审批。

## 重试、撤回与回退

同步或读回失败发生在提交前时，活动指针不变。重跑原发布 job 复用原文件；同名不同内容立即失败，不覆盖、不重建候选。R2 写入采用 `If-None-Match: *`，渠道切换采用读到的 ETag；旧任务不能覆盖更高版本或不同的同版本候选。

条件写入响应丢失时，脚本读回指针确认是否已经提交。同一候选的重试不会再次改写指针。提交后的 GitHub 展示或后续下载验证失败不意味着版本从未公布；先检查权威指针，再幂等重跑，不能盲目回滚或重建。

撤回由维护者在受控环境条件替换指针为先前完整可用的版本，或删除对应指针以暂时停止该渠道的安装授权；不要删除仍被指针引用的冻结文件。指针缺失时 Worker 返回不可用，客户端拒绝安装并保留已完成缓存；恢复清单后重新验证。已安装版本不自动降级。

回退路由前先将旧 GitHub/staging PVC 的发布状态恢复到目标候选，核对所有文件与清单；记录条件写入前后指针及路由。不能只关闭 Worker 然后假定三个存储已经同步。CNB 仅是可替换的下载来源，故障或平台限流时仍保留全球源。

## 验证状态

已添加 `scripts/mirror-distribution.test.mjs` 并接入原 `Test release scripts` 工作流。覆盖双源失败不提交、原文件重试、客户端/发布端策略一致、条件写入冲突、提交响应丢失、Worker 清单不回退及 streaming/HEAD 行为。

上述测试已在[发布 PR #20 合并后的 GitHub Actions](https://github.com/gavin-k/shhield-ai-releases/actions/runs/42191340872) 通过；安全错误码诊断在 [PR #23 的 CI](https://github.com/gavin-k/shhield-ai-releases/actions/runs/42207528764) 通过。两个当前渠道的真实 R2/CNB 全量文件校验也已完成，见下方切流记录。原生升级尚未验收；脚本和网络校验不能代替真实签名版本升级。

### Worker 预览部署记录（2026-11-06）

- 来源为已合并提交 `38fc735167ecffecb782ccb8bc11d93612273562` 的 `download/worker.mjs`，原文件 SHA-256 为 `9130f8a7f33cee3a9d567bfeea15a008fd74b9683aef6e25e4cb6c4b32ac7cc6`。部署 ID 为 `ae3feaf25f994069a80040bf7b819f52`，Cloudflare 返回创建时间 `2026-11-06T09:36:34.235888Z`。
- Wrangler `4.158.0` 的 dry-run 通过。其服务查询和部署查询接口返回 `503 no healthy upstream`，随后使用同一已批准 OAuth 连接，通过官方 Worker 上传 API 部署原文件与相同 R2 binding；官方设置接口读回成功。没有为此扩大 OAuth 权限。
- [预览健康地址](https://shhield-downloads.lijy0717.workers.dev/staging/healthz) 在浏览器和 curl 中成功返回。curl 的六项检查通过：健康 GET/HEAD 为 200，两个渠道缺少指针时为 503，固定版本缺失对象为 404，POST 为 405；同时核对 `no-store`、staging `noindex, nofollow` 和 `X-Shhield-Distribution: r2`。缺失对象的 404 验证了实际 R2 binding 读取，但不代表安装包已就绪。
- Python urllib 探针曾被 Cloudflare 边缘返回 `403 / 1010`；浏览器和 curl 验证通过。尚不能据此宣称所有网络和发布客户端都可用，后续 bootstrap 必须通过真实发布流程的匿名读回。
- 预览 origin 已写入两个发布环境。此段记录最初的空桶部署检查；后续原包预置与线上切流已完成，见下方记录。

### 双源初始化与线上切流记录（2026-11-06）

- 复用 Release run `42151620602` attempt 1、源码 `ab7fb2ee30bf8a31d48a7043e6795418d2722b21` 的 1.0.20 原冻结候选，没有重新打包。[staging 初始化](https://github.com/gavin-k/shhield-ai-releases/actions/runs/42207651711/attempts/2)和[正式版初始化](https://github.com/gavin-k/shhield-ai-releases/actions/runs/42212161906)均成功，包含原 attestation、全部本地文件哈希、双源匿名读回和指针条件写入。
- staging 的 `candidate.json` SHA-256 为 `f8a60a1d8be2e0622b942c35c46bb227ff67037e9da9efc4a689587383bb2e94`；正式版为 `4dcf01e65f4a0aedca2efb777aa955312a38cfa2ffbcd8e3528fa0ee952907c8`。
- Worker 预览域名和线上域名各通过 12 项检查：stable/staging 各三份兼容清单的 GET 字节不变；各渠道三个原生安装包 HEAD 为 200、长度正确。线上均直接返回同域 200 和 `X-Shhield-Distribution: r2`，清单 `no-store`、staging `noindex` 正确。
- 三条路由通过已登录 Cloudflare 控制台保存，未扩大既有 Wrangler OAuth 权限；之后两个发布环境切换为 `mirrors` 并读回确认。原 k3s 下载服务配置保留；回退必须先按上文恢复对应版本，不能直接撤下 Worker 后依赖可能已落后的 staging PVC。
