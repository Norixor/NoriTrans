# NorixorTrans 项目规范（AGENTS.md）

本文件适用于 NorixorTrans 仓库。用户当前明确指令优先于本文件；本文件优先于全局通用 `AGENTS.md` 中与本项目冲突的普通约定。

## 1. 项目定位

NorixorTrans 是一个基于 Chrome Manifest V3 的桌面浏览器翻译扩展。

核心能力：

1. 网页全文翻译。
2. 视频已有字幕的实时翻译。
3. 使用完整字幕轨道进行 AI 预翻译。
4. 同时支持快速翻译和 AI 精译。
5. 可选的本地图像字幕 OCR 实验能力；必须由用户主动开启并框选区域。

第一阶段不包含：

- 从视频音频生成字幕的 ASR。
- AI 配音。
- 字幕文件下载。
- Netflix 整季自动跳转和批量下载。
- Chrome 以外浏览器的正式兼容。
- 云端账户同步、翻译历史同步或多人共享。

新增这些能力前必须先确认范围、权限、隐私和成本。

## 2. 产品术语

### 快速翻译

快速翻译面向低延迟场景，包括：

- 网页快速翻译。
- 直播字幕。
- 只能读取当前画面字幕的网站。
- AI 预翻译尚未完成时的临时回退。

快速翻译不等于使用非正式或未授权的免费接口。

### AI 精译

AI 精译面向质量和上下文一致性，包括：

- 网页段落上下文翻译。
- 完整视频字幕轨道预翻译。
- 术语、人名、语气和上下文一致性。

AI 翻译可以渐进显示，但不得宣称严格实时。字幕实时展示不得依赖 AI 请求始终在单条字幕显示时间内完成。

### 完整字幕与流式字幕

- `full`：已经获得完整字幕时间轴，可以预翻译和缓存完整轨道。
- `stream`：只能读取播放过程中出现的字幕，只能翻译和缓存已经采集的部分。

UI 和日志必须明确区分二者。

## 3. 技术栈

默认使用：

- WXT。
- TypeScript strict mode。
- 原生 HTML。
- 原生 CSS。
- Chrome Manifest V3。
- pnpm。
- Vitest。
- Playwright。

除非用户明确同意，否则不得引入：

- React。
- Vue。
- Svelte。
- Tailwind CSS。
- 大型 UI 组件库。
- 第二种业务编程语言。

WXT 只负责扩展入口、构建和打包，不作为 UI 框架使用。

不得使用 `eval`、`new Function`、远程加载的可执行 JavaScript 或其他违反 Manifest V3 的远程代码方案。

源码注释、跨模块契约和公开 TypeScript API 文档统一使用英文；面向用户与贡献者的文档可以根据目标受众使用中文或英文。同一文件中不得无理由混用两种注释语言。

### 版本与验收包

- 每一批提供给用户重新加载或验收的功能改动，都必须递增补丁版本；不得用同一个版本号覆盖不同代码。
- `package.json`、构建后的 Manifest 和压缩包文件名必须使用同一版本。
- 交付验收包时必须同时报告版本号和 SHA-256，便于确认 Chrome 实际加载的是哪一批代码。

## 4. 目录与模块边界

建议保持以下职责边界：

```text
entrypoints/
  background.ts
  video.content.ts
  video-main-world.ts
  popup/
    index.html
    main.ts
    style.css
  options/
    index.html
    main.ts
    style.css

src/
  page/
    scanner.ts
    segmenter.ts
    renderer.ts
    session.ts

  subtitles/
    types.ts
    controller.ts
    profiles/
      site-profile.schema.json
      registry.ts
      builtin/
    parsers/
      vtt.ts
      ttml.ts
      youtube.ts
    adapters/
      html5.ts
      youtube.ts
      netflix.ts

  translation/
    types.ts
    scheduler.ts
    providers/
      chrome-local.ts
      openai-compatible.ts

  cache/
    database.ts
    keys.ts

  messaging/
    protocol.ts

  shared/
    errors.ts
    languages.ts
    settings.ts
    unified-floating-control.ts
```

页面入口只负责装配，不得把 DOM 扫描、Provider 请求、字幕解析、缓存和 UI 混写在同一个文件中。

Content Script 默认不得直接调用云端翻译服务。云端 Provider 通过 Background Service Worker 调度。

如果某个本地浏览器 API 不能在 Service Worker 中运行，应通过明确的执行器抽象处理，不得为了方便复制整套 Provider 逻辑。

## 5. 翻译契约

快速翻译与 AI 精译必须共用统一结果结构，不建立两套页面和字幕渲染管线。

最小契约：

```ts
type TranslationMode = "fast" | "ai";

interface TranslationSegment {
  id: string;
  text: string;
}

interface TranslationRequest {
  sourceLanguage: string;
  targetLanguage: string;
  mode: TranslationMode;
  segments: TranslationSegment[];
}

interface TranslationResult {
  id: string;
  translatedText: string;
}

interface TranslationProvider {
  id: string;
  mode: TranslationMode;
  translateBatch(
    request: TranslationRequest,
    signal: AbortSignal,
  ): Promise<TranslationResult[]>;
}
```

要求：

- 每个输入段落都有稳定 ID。
- Provider 返回结果必须按 ID 校验。
- 同一翻译任务内，Unicode 组合与连续空白归一化后完全相同的文本只发送一次，并把译文映射回全部原始 ID；不得做大小写或语义近似合并。
- Provider 响应错误必须提供有界、可展开的结构化诊断（状态码、长度、缺失/重复/未知 ID、字段结构），但不得暴露 API Key、认证头、完整原文或原始响应正文。
- 不得只依赖换行符或数组位置拆分 AI 输出。
- 缺少、重复或未知 ID 时必须判定该批次不完整。
- 失败时不得把原文伪装成成功译文。
- 请求必须支持取消或结果失效。
- 页面切换、语言切换和视频切换后，旧响应不得覆盖新状态。
- Provider 应声明批量大小、字符限制、上下文能力和执行环境。
- 网页和字幕的 AI 流式/完整返回都使用最多八个有界并发批次；增加并发不得改变批次上限、绕过去重或重复发送已成功 ID。
- 划词翻译模式独立于整页翻译模式，保存设置和运行时请求不得互相覆盖。

## 6. 网页翻译规则

网页翻译必须基于文本节点和语义块，不得替换整个页面的 `innerHTML`。

需要处理：

- 跨 `span`、`a`、`strong`、`em` 等行内元素的完整句子。
- 动态加载内容。
- SPA 页面导航。
- 翻译中止。
- 恢复原文。
- 原文、译文和双语显示模式。
- 视口附近内容优先翻译。

必须跳过：

- `script`、`style` 和 `noscript`。
- `code` 和 `pre`。
- `textarea`、`input`、`select` 和 `option`。
- `contenteditable`。
- `translate="no"`。
- `.notranslate`。
- 扩展自身注入的 UI。
- 隐藏且没有用户可见价值的内容。

翻译开始时需要建立独立 Session，并保存恢复原文所需的信息。恢复时只能恢复该 Session 实际修改的节点，不能覆盖网页在翻译期间自行更新的内容。

动态 DOM 使用 `MutationObserver`，必须防抖、去重并避免重新翻译扩展生成的译文。

## 7. 字幕采集规则

统一字幕结构：

```ts
type SubtitleCompleteness = "full" | "stream";

type SubtitleSource =
  | "texttrack"
  | "youtube-timedtext"
  | "netflix-manifest"
  | "network"
  | "dom"
  | "ocr";

interface SubtitleCue {
  id: string;
  startMs: number;
  endMs: number | null;
  originalText: string;
}

interface SubtitleTrack {
  source: SubtitleSource;
  completeness: SubtitleCompleteness;
  language: string;
  cues: SubtitleCue[];
}
```

字幕来源优先级：

1. 完整 HTML5 `TextTrack`。
2. WebVTT、TTML 或网站字幕接口。
3. 网站专用 MAIN world 字幕拦截。
4. 当前字幕 DOM 读取。
5. 无字幕时提示不支持，不自动捕获音频。

实验性 OCR 不属于自动站点采集：只有用户主动开启并框选视频画面区域后才可启动。PP-OCRv5 执行器与 ONNX Runtime Web 随扩展打包；识别模型默认不内置，只能由用户在设置的“OCR 运行时”中明确点击，从固定 commit 和固定来源下载，校验固定 SHA-256 后保存到扩展本地，并支持查看状态与删除。不得静默下载模型，也不得把模型下载权限扩大为普通网页权限。OCR 必须运行在扩展 origin 的 Offscreen Document 中，不得在内容脚本中创建而受网站 CSP 影响。截图只允许在扩展本地内存中完成裁剪和识别，不得上传。OCR 识别文字只能使用 Chrome 本地 Translator 进行快速翻译，不得发送给 AI 或其他云端 Provider；OCR 模型或本地翻译模型未就绪时保留识别原文并明确提示。受保护视频为黑帧、截图权限被拒绝或采集失败时必须明确停止并提示。OCR 不得干扰已获得的完整字幕轨道。

首期适配顺序：

1. HTML5 TextTrack。
2. YouTube timedtext。
3. Netflix manifest、TTML 或 VTT。
4. Netflix `.player-timedtext` 实时回退。
5. 腾讯视频仅允许用户主动启用并框选区域的本地 OCR，不启用 DOM、TextTrack 或网络字幕采集。
6. Max/HBO Max、Disney+ 与 Prime Video 的内置网络分片和 DOM 回退 Profile。

每个网站使用独立 Profile；需要特殊解析或 MAIN world hook 时再绑定受控 Adapter。网站选择器、字幕接口 URL 规则、解析格式和原字幕选择器优先放入 `src/subtitles/profiles/builtin/*.json`，不得散落在通用字幕控制器中。

Profile 必须遵循统一 JSON Schema。优先级为用户当前站点 Profile、内置站点 Profile、通用 HTML5、通用 DOM 启发式。Profile 只能选择白名单 parser 和声明式规则，不得包含任意 JavaScript、`eval`、远程代码或绕过站点权限的逻辑。YouTube、Netflix、Max/HBO Max、Disney+、Prime Video、标准 HTML5 和通用 DOM 启发式属于内置 Profile；腾讯视频明确排除这些字幕采集路径，只保留用户主动 OCR。Max/HBO Max、Disney+ 和 Prime Video 被动捕获到的字幕分片默认只能标记为 `stream`；只有有限 VOD manifest 和所有字幕分片均已成功获取、解析时才允许升级为 `full`。

MAIN world 拦截必须：

- 仅在目标网站启用。
- 保留原始函数行为和返回值。
- 支持重复初始化检查。
- 不向页面暴露 API Key、设置或扩展内部状态。
- 只向隔离世界发送经过校验的字幕数据。
- 页面结构变化时安全失效，不得破坏播放器。

## 8. 字幕翻译策略

### 完整轨道

获得完整轨道后：

1. 解析并规范化时间轴。
2. 合并过碎的字幕片段为语义句组。
3. 保留 cue 与句组之间的稳定映射。
4. 优先翻译当前播放位置后的短窗口。
5. 达到可播放缓冲后继续后台翻译剩余内容。
6. 显示真实完成进度。
7. 将结果写入 IndexedDB。

AI 精译默认用于该流程。

### 流式字幕

只能读取当前字幕时：

- 无论用户选择快速或 AI 翻译模式，都只使用快速翻译；浮窗必须明确说明“未获取完整字幕，已回退快速翻译”。
- 根据 `video.currentTime` 记录开始时间。
- 下一句出现时结束上一句。
- 相同文本优先读取缓存。
- 旧请求返回时不得覆盖当前字幕。
- 不得为只能读取当前或已播放 cue 的流式轨道发送 AI 请求；AI 结果通常会在字幕消失后才返回，无法稳定显示且会浪费 token。只有轨道升级为 `full` 后才启动 AI 预翻译。
- OCR 流式轨道只允许 Chrome 本地快速翻译，不进入 AI 批处理。
- 不得把已观看部分描述成完整字幕。

## 9. 缓存与任务恢复

字幕和网页翻译缓存使用扩展 Background origin 的 IndexedDB，由受校验的内部消息统一读写。Content Script 不得直接在目标网站 origin 创建缓存数据库。完整字幕轨道可单独持久化，用于页面刷新或字幕接口暂时不可用时恢复；流式 DOM/OCR 轨道不得伪装为完整轨道持久化。

缓存键至少包含：

- Provider ID 和 Provider 类型。
- 模型和提示词版本。
- 源语言和目标语言。
- 翻译模式。
- 原文。
- 视频或页面稳定标识。

AI 字幕预翻译任务必须支持：

- 完成数量和总数量。
- 暂停或取消。
- 页面刷新后从缓存继续。
- 完整轨道恢复后仍按稳定 cue ID 读取译文，清除缓存后不得从站点侧残留副本恢复。
- 失败批次单独重试。
- 切换模型或提示词后不误用旧缓存。

不得仅以字幕数组下标作为长期缓存身份。

## 10. Provider 与外部服务

第一版至少保留以下 Provider 方向：

- Chrome 本地 Translator API。
- OpenAI-compatible AI Provider。

AI Provider 必须允许配置：

- Base URL。
- API Key。
- 模型。
- 系统提示词或预设。
- 请求超时。

不得：

- 把 API Key 写进源码。
- 使用从翻译网站抓取的内部密钥。
- 默认依赖未公开、未授权或易变的内部翻译接口。
- 在日志或错误信息中输出认证头、完整响应或用户敏感文本。

NorixorAI 可以作为 OpenAI-compatible Provider 的默认预设，但核心代码不得与单一服务硬耦合。

## 11. 权限与隐私

权限采用与已确认产品行为相称的最小范围。

- 为保证用户不点击扩展也能自动显示统一浮动控制，并支持所有 HTTPS 网站的网页与视频翻译，当前版本声明 `https://*/*` 必需主机权限；权限说明和商店材料必须明确披露这一点。
- `http://localhost/*` 与 `http://127.0.0.1/*` 仅作为本地 Provider 的可选权限，在用户配置时明确申请。
- 不得申请 Cookie、浏览历史、音频捕获等与现有功能无关的权限。
- API Key 默认仅保存在 `chrome.storage.local`，不得默认同步。
- 翻译前只发送必要文本，不发送完整 DOM、Cookie、认证数据或视频内容。
- UI 必须说明文本将发送到哪个 Provider。
- 清除缓存和清除凭据必须是两个独立操作。
- 调试日志不得长期保存完整网页和字幕内容。

## 12. UI 规则

扩展 UI 使用原生 HTML、CSS 和 TypeScript。

注入网页的 UI 使用 Shadow DOM 隔离样式，包括：

- 翻译状态条。
- 字幕层。
- 进度提示。
- 错误和重试入口。
- 默认折叠、可拖动的统一浮动按钮，以及通过“网页 / 视频”Tab 切换的快速设置。

统一浮窗默认开启并自动挂载，必须支持折叠、拖动、当前网页隐藏和永久隐藏，并能在完整设置中重新开启。进入视频全屏时自动收起设置面板，但必须把圆形控制按钮迁入全屏顶层保持可用；退出全屏后恢复到页面及记忆位置。网页自动翻译和视频显示选项应在对应 Tab 中快速调整。快速设置和完整设置读写同一份配置，不得维护两套互相覆盖的状态。

网页显示必须同时保留“替换原文”和“原文后附加译文”两种模式。附加模式默认采用低干扰的 integrated 样式：译文紧邻对应语义块，继承其字体、字号、行高、方向与对齐，不添加“译”“译文”或 `Translation` 标题，不默认使用卡片、底色或高饱和颜色。列表、表格、Flex/Grid 等布局需要选择安全锚点，不能因插入译文破坏编号、列宽或主要控件排布。

UI 必须提供清晰的 loading、translating、success、partial、error、disabled 和 unavailable 状态。

所有用户可见文案使用 Chrome i18n 语言目录，不在页面脚本中维护内联翻译字典。

字幕状态不能只靠颜色表达。按钮必须支持键盘操作和可访问名称。

## 13. 测试与验收

纯逻辑至少覆盖：

- 网页文本分段。
- 排除节点规则。
- AI 返回 ID 对齐。
- VTT 和 TTML 解析。
- 缓存键。
- 任务恢复。
- 旧响应失效。
- 字幕时间轴边界。

浏览器验收至少覆盖：

- 静态网页翻译和恢复。
- 动态加载网页。
- SPA 导航。
- 同源与跨域 iframe 内的网页文本、HTML5 TextTrack、设置同步、单一顶层浮窗和 iframe 移除恢复。
- HTML5 TextTrack。
- YouTube 手工字幕和自动字幕。
- Netflix 完整轨道成功路径。
- Netflix DOM 实时回退。
- 本地 OCR 模型加载、区域截图、识别、翻译和字幕显示；生产构建必须确认截图权限为可选权限。
- OCR 浏览器链路必须使用真实 Canvas 像素与真实 pointer 拖框，并覆盖区域外干扰文本、全屏面板收起且控制按钮可用，以及黑帧/DRM 视频内提示。
- 原文、译文和双语显示。
- API 失败、限流和取消。

测试夹具使用自建或短小的合成字幕，不提交完整的受版权保护字幕文件。

构建成功不等于功能验收完成。必须记录实际验证的平台、站点、语言、主题和字幕来源。

## 14. 开源参考与许可证

可以参考开源项目的架构、数据流和公开协议，但不得未经检查复制代码。

引入代码前必须确认：

- 仓库存在有效许可证。
- 许可证允许当前使用方式。
- 保留必要版权声明。
- 没有许可证的仓库只允许用于理解实现思路。
- GPL、MPL 等许可证的代码不得在未评估传播要求前直接复制。

## 15. 变更边界

新增以下内容前必须先获得用户确认：

- UI 框架。
- 新的字幕采集权限。
- 音频捕获。
- ASR 或 OCR。
- 新的云端服务。
- 远端账户或同步系统。
- 付费、计费或配额逻辑。
- Chrome Web Store 发布。
- 对 Netflix 等站点进行批量页面导航或批量字幕下载。

实现、提交、推送和发布仍是独立授权阶段。
