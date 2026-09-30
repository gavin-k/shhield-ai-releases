# 手动验证未合并的源码提交

`Validate reviewed source PR (offline)` 为固定源码仓库 `gavin-k/shhield-ai` 增加合并前验证入口。输入完整、已审查的 40 位小写 commit SHA；不接受仓库 URL、分支、命令或自由构建参数。只有发布仓库 `main` 上的 workflow 可以执行。

运行仍须人工批准后手动启动。validation_scope 只允许 all（默认）或 ui；ui 仅重跑 Desktop，不声称本轮验证 Rust。相同源码 SHA 的既有 Rust 证据应单独引用。原有 `Release` 和 `Validate macOS staging` 的 source-main 祖先校验、签名和发布门禁完全保留。

## 验证范围

- 保留源码完整 Cargo workspace 和原 Cargo.lock，以 `--locked --offline` 构建 Linux CLI 的 `rustls-tls,system-keyring` 最小功能组合
- 运行 `shhield-privacy` 默认关闭模型功能的测试和全部 target 的 Clippy；不执行 ignored 模型/性能测试
- 生成并构建 ACP SDK，运行 Desktop 类型检查、i18n 编译、Vite renderer 构建和脚本中列明的现有 mock 测试；五个固定步骤分别报告状态，失败后的依赖步骤不会伪报通过
- 不等价于默认功能 release build、完整 workspace Clippy、Electron 主进程/安装包、真实 Keychain、legacy/state-machine 端到端或 macOS/Windows 发行验收
- 不启动 CLI、Electron、self-test recipe 或 provider 集成测试；当前所选源码测试使用 mock/合成数据并关闭 privacy 模型特性。不签名、不公证、不发布、不更新 latest、不部署。对将来输入的 SHA，维护者仍须审查测试内容；网络隔离可以阻断外部调用，不能保证任意未来代码不会自行进行本地推理

## 凭据、网络和私有源码边界

发布仓库是公开仓库。源码、构建产物、依赖缓存和详细诊断均不上传 artifact/cache；容器输出从不转发到公开 Actions 日志，防止源码片段、断言输入和 workflow command 注入。结果仅公开固定步骤的成功/失败和提交 SHA。输入 SHA 本身会显示在运行名和摘要中。

`SOURCE_DEPLOY_KEY` 仅用于可信脚本对固定私有仓库的 bare fetch，写入 umask 077 的临时 key 文件后立即从脚本环境 unset；建议 key 本身保持只读。脚本固定 GitHub 官方 Ed25519 host key并启用 StrictHostKeyChecking，不运行私有源码 checkout action，避免私有 commit subject 出现在公开日志。源提交被验证为 exact SHA 后以 `git archive` 导出，不包含 `.git` 或 SSH 配置。脚本在成功/失败退出时删除临时 key、known_hosts 和 bare repo。发布仓库自己的可信驱动 checkout 仍使用 `persist-credentials: false`。导出文件只在当前 runner 本地存在，不通过公开 artifact 转交。源码及依赖不在 host 上执行。

Docker 容器仅挂载导出的源码、空白专用 home 和只读验证脚本；不挂载 host home、runner 临时目录、SSH key、Docker socket 或 GitHub 环境文件，也不转发 host 环境变量。容器使用 UID 1000、只读系统目录、cap-drop ALL、no-new-privileges。代码仍须经过人工审查；此配置不是针对恶意 kernel/container escape 的隔离保证。

网络仅用于官方工具镜像/工具安装和依赖准备。准备阶段使用固定 Cargo/pnpm 版本，移除源码快照中的 Cargo 下载器配置、`.npmrc` 和 pnpmfile 文件，运行 Cargo fetch 和关闭生命周期脚本/pnpmfile 的 frozen pnpm install；不改源码 manifest 或 lockfile。依赖准备失败就停止，不自动打开构建阶段网络。所有编译、SDK 生成、Vite 配置执行、Rust build.rs、测试均在 Docker `--network none` 中运行，不能访问外部 provider；容器内 loopback 可供本地 mock 使用。配置有特殊 registry/自定义 hook 的后续提交需要单独审查，不能静默回退为联网执行。

原始诊断只留在当前 runner 的临时目录，结束后删除。排错需要授权人员在私有环境重现；不会因为失败而泄露日志或自动开启网络、签名或发布。源代码的变更可能使冻结依赖、最小 CLI 功能或 mock 测试失败；这样的失败是待修复/待审查结果，不应被跳过。

## 私有环境复现

需要 Linux、Docker、Python 3 和 sudo。先以自己的授权方式 checkout 固定源码仓库的目标 SHA，以及本发布仓库的验证脚本；不要把凭据写入源码目录。设置 RUNNER_TEMP 为专用临时目录，创建其下的 `pr-validation/source` 和 `pr-validation/home`，将 `git archive <SHA>` 解包至 source。依次运行：

```sh
bash scripts/pr-validation/run.sh image
bash scripts/pr-validation/run.sh dependencies
bash scripts/pr-validation/run.sh rust
bash scripts/pr-validation/run.sh ui-sdk
bash scripts/pr-validation/run.sh ui-typecheck
bash scripts/pr-validation/run.sh ui-i18n
bash scripts/pr-validation/run.sh ui-renderer
bash scripts/pr-validation/run.sh ui-tests
```

详细日志位于 `$RUNNER_TEMP/pr-validation/{image,export,prepare,dependencies,rust,ui-*}.log`，只应在私有环境查看，禁止贴入公开 issue/PR。删除整个临时目录结束复现。公开 workflow 中不会提供这些日志。

## 驱动自身检查

```sh
python3 -m unittest discover -s scripts/pr-validation -p 'test_*.py' -v
for script in scripts/pr-validation/*.sh; do bash -n "$script"; done
```

这些是驱动回归/静态检查，不代替 GitHub-hosted runner 的源码构建。首次运行 [36707741503](https://github.com/gavin-k/shhield-ai-releases/actions/runs/36707741503) 已针对 a8d11ae25f3e7aad653270c249dd408e932a5bf4 通过最小 CLI build、privacy tests 和 Clippy；聚合 UI 步骤失败，不能认定其任何子步骤已通过。细分步骤用于定位失败阶段，仍不公开私有错误正文。工具镜像使用明确版本但未固定 digest；正式复现应记录/固定实际镜像 digest 和系统包版本，当前不承诺位级可复现。
