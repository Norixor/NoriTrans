<div align="center">
  <img src="./assets/branding/norixortrans.svg" width="112" alt="NorixorTrans 标志" />
  <h1>NorixorTrans</h1>
  <p>注重隐私的 Chrome 网页与已有视频字幕翻译扩展。</p>
  <p><a href="./README.md">English</a> · <strong>简体中文</strong></p>
</div>

> [!IMPORTANT]
> NorixorTrans 是仍在积极开发的 `0.x` 项目。目前正式面向桌面 Chrome 138+ 和 Manifest V3。流媒体网站修改播放器或私有接口后，站点专用字幕适配可能需要同步维护。

## 为什么做 NorixorTrans？

NorixorTrans 把网页翻译、视频字幕翻译和可选的本地 OCR 放在一个扩展中，但不会把三种问题混成同一条不透明流程。

- **网页翻译：** 基于语义文本节点工作，不替换整个页面的 HTML；支持动态内容、SPA 导航和安全恢复原文。
- **视频字幕：** 能取得完整字幕轨道时进行整轨预翻译；只能看到当前字幕时，明确回退到低延迟流式快速翻译。
- **本地 OCR：** 只有用户主动启用并框选区域后才识别烧录字幕，截图和识别文字始终留在本机。
- **Provider 可选：** 支持 Chrome 本地 Translator API 和用户配置的 OpenAI-compatible 服务。
- **统一浮窗：** 通过可拖动、Shadow DOM 隔离的紧凑控制器管理网页、视频和图像翻译。

## 翻译模式

| 模式     | 适用场景                                 | 行为                                                        |
| -------- | ---------------------------------------- | ----------------------------------------------------------- |
| 快速翻译 | 实时字幕、DOM 字幕、OCR 和低延迟网页翻译 | 使用配置的快速 Provider；流式字幕不会消耗 AI 批处理请求。   |
| AI 精译  | 需要上下文的网页和完整字幕轨道           | 使用稳定段落 ID、有界批次、渐进结果、严格校验、取消和缓存。 |

字幕轨道会明确区分为：

- **`full`：** 已取得完整时间轴，可以预翻译和缓存；
- **`stream`：** 只能获得播放期间已经出现的字幕，界面会明确提示已回退快速翻译。

## 字幕支持

NorixorTrans 会优先使用完整来源，再逐级回退到当前字幕采集：

1. HTML5 `TextTrack`；
2. WebVTT、TTML、timed-text 或有限字幕 manifest；
3. 受控的 MAIN world 网络拦截；
4. 内置或用户创建的 DOM Profile；
5. 没有可读字幕时，由用户主动启动本地 OCR。

仓库内置 20 个 Profile，覆盖标准 HTML5、通用 DOM 启发式、YouTube、Netflix、Max/HBO Max、Disney+/Hotstar、Prime Video、Apple TV+、Hulu、Paramount+、Discovery+、Peacock、fuboTV、TED、BBC iPlayer、ZDF、Deutsche Welle、Udemy、Kanopy 和 TVer。

腾讯视频被明确限定为 OCR-only，不启用 DOM、`TextTrack` 或网络字幕采集。对于其他站点，仓库存在内置 Profile 只表示已经声明相应采集策略，不代表每个版本都完成了第三方真实站点线上验收。

## 从源码安装

环境要求：

- Chrome 138 或更高版本；
- Node.js `>=22.22.2 <23` 或 `>=24.15.0 <25`；
- pnpm `10.32.1`。

```bash
corepack enable
corepack prepare pnpm@10.32.1 --activate
pnpm install --frozen-lockfile
pnpm build
```

打开 `chrome://extensions`，启用**开发者模式**，点击**加载已解压的扩展程序**，选择：

```text
.output/chrome-mv3
```

源码构建不会自动更新。希望 Chrome 保留同一个本地开发安装时，请保持加载目录不变。

## Provider 与隐私模型

| 能力                   | 处理位置                          | 会发送到外部的数据                                            |
| ---------------------- | --------------------------------- | ------------------------------------------------------------- |
| Chrome 本地翻译        | Chrome 本地模型运行时             | 不会把文字发送给配置的 AI Provider；Chrome 可能下载语言模型。 |
| OpenAI-compatible 翻译 | 用户配置的服务端点                | 仅发送当前任务需要的文本段和有界上下文。                      |
| 本地图像字幕 OCR       | 扩展 origin 的 Offscreen Document | 截图和识别文字不上传，也不允许发送给 AI Provider。            |

额外保证：

- API Key 只保存在 `chrome.storage.local`，不会写入源码或同步存储；
- 云端请求由 Background Service Worker 发起，不由网页 Content Script 直接调用；
- Provider 诊断是有界信息，不包含 API Key、认证头、完整原文或原始响应正文；
- 清除翻译缓存和清除凭据是两个独立操作；
- OCR 模型只会在用户明确点击后从固定来源下载，并校验固定 SHA-256。

## 权限说明

NorixorTrans 声明 `https://*/*`，因为统一浮窗以及网页、视频翻译需要在用户未先点击工具栏图标时也能在 HTTPS 页面工作。项目不申请 Cookie、浏览历史或音频捕获权限。

以下可选主机权限只会在对应操作中请求：

- `<all_urls>`：用户主动启动可见标签页 OCR 截图；
- 固定 GitHub 资源域名：用户明确下载 OCR 模型；
- `http://localhost/*` 和 `http://127.0.0.1/*`：用户配置本地 Provider。

## 本地开发

```bash
pnpm dev             # WXT 开发构建
pnpm format:check    # 全仓 Prettier 检查
pnpm run ci          # ESLint、TypeScript、单测和生产构建
pnpm test:e2e        # Chromium 中的合成 Manifest V3 验收
pnpm zip             # 生成版本化扩展压缩包
```

标准 E2E 使用项目自建页面和短字幕夹具，不替代发布前对真实登录流媒体站点的检查。

完整 OCR 截图链路还需要固定版本的本地运行时文件：

```bash
NORIXORTRANS_OCR_RUNTIME_DIR=/absolute/path/to/runtime pnpm test:e2e:ocr
```

没有提供运行时时，命令会明确报告跳过；跳过不等于 OCR 验收成功。

## 架构

NorixorTrans 使用 WXT、TypeScript strict mode、原生 HTML/CSS、Chrome Manifest V3、Vitest 和 Playwright。项目不使用 UI 框架，也不允许远程加载可执行代码。

```text
entrypoints/     扩展页面、Content Script 和 Background Worker
src/page/        网页扫描、会话、渲染和恢复
src/subtitles/   字幕 Profile、Adapter、Parser、时间轴和 Overlay
src/translation/ Provider、调度、结果校验和保护文本
src/ocr/         本地截图、运行时、预处理和识别
src/cache/       Background origin 的 IndexedDB 存储
src/messaging/   跨上下文消息协议和校验
src/shared/      设置、错误、诊断和共享控制器
```

产品契约和完整验收边界见 [`AGENTS.md`](./AGENTS.md)。

## 当前不包含的能力

NorixorTrans 当前不从音频生成字幕、不提供 AI 配音、不下载字幕文件、不自动跳转整季页面，也不批量下载流媒体内容。新增这些能力前需要明确评估范围、权限、隐私和成本。

## 参与贡献与安全报告

提交 Pull Request 前请阅读 [`CONTRIBUTING.md`](./CONTRIBUTING.md)，并遵守 [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)。安全漏洞请按照 [`SECURITY.md`](./SECURITY.md) 私下报告，不要在公开 Issue 中发布凭据、私人文本、完整字幕或可直接利用的细节。

## 致谢

NorixorTrans 基于 [WXT](https://github.com/wxt-dev/wxt)、`idb`、ONNX Runtime Web 和兼容 PaddleOCR 的本地运行时构建。固定的上游版本及第三方许可证记录在 [`THIRD_PARTY_NOTICES.txt`](./public/ocr/licenses/THIRD_PARTY_NOTICES.txt)。

## 许可证

除另有说明外，源代码和文档采用 [Apache License 2.0](./LICENSE) 授权。Copyright 2026 Norixor。

NorixorTrans 名称、Logo、产品标识和 `assets/branding/` 下的文件不属于 Apache-2.0 授权范围，品牌使用规则见 [`TRADEMARKS.md`](./TRADEMARKS.md)。
