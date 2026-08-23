# 参与 NorixorTrans 开发

感谢你愿意改进 NorixorTrans。提交代码前，请先阅读本指南、
[行为准则](./CODE_OF_CONDUCT.md)和[安全策略](./SECURITY.md)。

## 开发环境

- Node.js `>=22.22.2 <23` or `>=24.15.0 <25`
- pnpm `10.32.1`（版本固定在 `package.json` 的 `packageManager` 字段）
- Chrome 138 或更高版本

启用正确版本的 pnpm 并安装依赖：

```bash
corepack enable
corepack prepare pnpm@10.32.1 --activate
pnpm install --frozen-lockfile
```

启动开发构建：

```bash
pnpm dev
```

构建完成后，可在 `chrome://extensions` 开启开发者模式并加载
`.output/chrome-mv3`。

## 提交改动

1. 先搜索已有 issue 和 pull request，避免重复工作。
2. 缺陷修复应描述复现步骤、预期行为和实际行为。涉及站点适配时，请说明
   Chrome 版本、站点、字幕来源、语言和是否登录；不要附带 Cookie、API Key、
   完整字幕或其他敏感信息。
3. 对新增权限、音频捕获、ASR/OCR、云端服务、账户同步、计费、商店发布或
   批量字幕采集等范围，先通过 issue 与维护者确认设计和隐私边界。
4. 保持改动聚焦。不要提交 `.output/`、`.wxt/`、测试报告、OCR 模型、真实用户
   数据或受版权保护的完整字幕。
5. 公共契约、设置、可见文案或权限发生变化时，同步更新相应类型、Chrome
   i18n 资源和文档。除非维护者要求，普通 pull request 不要自行修改版本号。

项目使用 WXT、TypeScript strict mode、原生 HTML/CSS 和 Chrome Manifest V3。
不要引入远程可执行代码、`eval` 或 `new Function`。新增依赖和 UI 框架必须先
说明必要性、许可与打包影响。

## 验证

提交 pull request 前至少运行：

```bash
pnpm run ci
pnpm format:check
```

`pnpm run ci` 依次执行 ESLint、TypeScript 类型检查、Vitest 单元测试和生产构建。
`pnpm format:check` 检查仓库内受 Prettier 支持且未在 `.prettierignore` 排除的
源码、测试、配置与文档。

修改扩展页面、Content Script、字幕适配器或浏览器消息链路时，再运行：

```bash
pnpm test:e2e
```

标准 E2E 使用合成夹具，不等同于真实登录站点验收。它也不覆盖需要本地
PP-OCR 运行时、真实图片夹具和有界截图权限的 OCR 路径。只有准备好仓库固定的
OCR 运行时文件后，才单独运行：

```bash
NORIXORTRANS_OCR_RUNTIME_DIR=/absolute/path/to/runtime pnpm test:e2e:ocr
```

如果没有该运行时，命令会明确跳过；跳过不代表 OCR 链路已验证。不要下载或
提交第三方真实字幕作为测试夹具。

站点适配诊断在默认构建中关闭。只有本地排障需要时，才从 `.env.example` 创建
未提交的 `.env.local`，并设置 `WXT_NORIXORTRANS_SITE_DIAGNOSTICS=1`。诊断可能
包含经过裁剪的媒体路径和语言标识；不要在敏感账户中启用，也不要未经检查直接
提交或粘贴完整 Console 输出。

## Pull request 清单

- 说明问题、方案、行为变化和未验证边界。
- 关联相关 issue，并列出实际运行的验证命令与结果。
- 新行为具有与风险相称的测试，缺陷修复尽量包含回归测试。
- UI 改动检查键盘可达性、可访问名称、浅色/深色主题及受影响语言。
- 不包含凭据、认证头、完整原文、原始 Provider 响应或生成产物。
- 保持提交可审查，不混入无关重构或格式化改动。
