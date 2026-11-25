# 从源码重建

需要 Git、Node.js 24.9 或更新版本，以及上游项目要求的 pnpm。以下步骤在本仓库根目录执行。安装插件的使用者可以直接使用 Release 安装包，不需要构建上游仓库。

## 1. 取得固定上游版本

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git .build/upstream
git -C .build/upstream checkout 9c2670d3bce5275e0d1610272958121af87787bb
git -C .build/upstream apply --check ../../patches/dsh-0.2.2-rc.5.patch
git -C .build/upstream apply ../../patches/dsh-0.2.2-rc.5.patch
```

上游版本及许可证记录在 [UPSTREAM.json](<../UPSTREAM.json>)。补丁包括三个 UI 模块中的特性改动、相关测试和说明；不含 profile、会话数据或上游完整仓库历史。

## 2. 构建模块

```sh
cd .build/upstream
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm --filter @deepseek-ai/dsh-client-ui-session exec tsdown --config-loader native --fail-on-warn
pnpm --filter @deepseek-ai/dsh-client-ui-workspace exec tsdown --config-loader native --fail-on-warn
pnpm --filter @deepseek-ai/dsh-client-ui-conversation exec tsdown --config-loader native --fail-on-warn
pnpm run build:check
cd ../..
node scripts/export.mjs .build/upstream
npm run verify
```

导出器验证上游提交后，仅复制三个模块的 Host/Client 产物、源码映射和语言资源，生成精简模块 manifest、第三方许可证、SHA-256 校验值以及完整源码补丁。它不安装插件，也不修改 DSH profile。

## 3. 验证打包字节

在上游测试环境中执行以下显式产物测试。`DSH_SPLIT_BUILT_ROOT` 指向本仓库导出的模块，而不是上游原目录：

```sh
RELEASE_ROOT="$PWD"
cd .build/upstream
DSH_SPLIT_BUILT_BOOT=1 DSH_SPLIT_BUILT_ROOT="$RELEASE_ROOT/modules" \
  pnpm exec vitest run packages/client/ui-conversation/tests/split-built-boot.client.spec.tsx
pnpm exec vitest run \
  packages/client/ui-conversation/tests/split-state.client.spec.ts \
  packages/client/ui-conversation/tests/split-panel.client.spec.tsx \
  packages/client/ui-conversation/tests/split-focus.client.spec.tsx \
  packages/client/ui-conversation/tests/split-draft-retention.client.spec.ts \
  packages/client/ui-conversation/tests/split-restore-race.client.spec.ts
cd ../..
npm run pack:release
```

产物测试执行真实模块注册、Cordis 启动、工作区会话行拖拽、双会话绑定和原生 Lexical 独立输入。它也检查产物中分栏行高与最小高度的 CSS 声明。jsdom 不验证像素几何，布局可见性仍需在实际 Desktop 中确认。

`dist/` 中生成 `.tgz` 与 SHA-256 校验文件。发布前应解包到一个不同目录，在该目录执行 `node scripts/verify.mjs`，并将上面的 `DSH_SPLIT_BUILT_ROOT` 指向解包后的 `modules` 重跑。

若在 DSH Desktop 提供的工具环境中验证，可对独立解包目录安装生产依赖后执行实际 Host 注册器检查。`DSH_INSTALL_DIR` 和 `DSH_NODE_EXECUTABLE` 必须指向对应版本的运行安装：

```sh
npm install --ignore-scripts --omit=dev --prefix /absolute/unpacked/package
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --expose-internals \
  scripts/verify-installed.cjs /absolute/unpacked/package
```

该检查使用安装版 Cordis Loader、patch 解析器和 ClientModuleRegistry，检查相对入口、嵌套 manifest、模块图、bundle 响应和重复来源错误；只创建内存中的测试上下文，不启动服务器或更改 profile。

## 安装后的检查

按 [README 的冷加载次序](<../README.md#安装与升级>) 安装。核查长会话的两个输入框均可见、草稿不串栏、重复拖入聚焦已有栏、关闭不删除会话、分隔线拖动以及窄窗收起后恢复。安装或配置工具返回成功只说明配置已应用，不代替页面验收。
