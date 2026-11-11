# agent-mobile-runtime

给 AI Agent 使用的独立 Android 虚拟手机运行时。管理原生 Android Emulator 的生命周期，通过 STDIO MCP 操作 App，并录制内部声音及屏幕。提供本地管理 API，供 paxd 接入；不依赖 Pax，也不修改其他仓库。

**让 Agent 安装和使用：从 [AGENTS.md](AGENTS.md) 开始，按 [首次安装与 MCP 接入](docs/quickstart.md) 执行。**
英文阅读索引见 [llms.txt](llms.txt)。无需先通读源码，也没有 npm 包依赖要安装。

| 你需要的能力 | 从哪里开始 |
| --- | --- |
| 安装、创建第一台手机、给 Agent 接入 MCP | [Quickstart](docs/quickstart.md)；统一入口 `node scripts/setup.cjs --help` |
| Linux 私有 SDK 安装、KVM 和部署检查 | [Linux](docs/linux.md) |
| macOS SDK、独立模板和配置准备 | [macOS](docs/macos.md) |
| Agent 操作 App、截图、读取 UI、录音录像 | [Quickstart 的 MCP 使用流程](docs/quickstart.md) |
| 人工查看实时画面与内部声音 | [WebRTC](docs/webrtc.md) |
| 接到自己的前端或 Pax 节点 | [本地 API / Pax 接入协议](docs/pax-api.md) |
| 分清已经测过的能力和安全边界 | [验收记录](docs/acceptance.md)、[SECURITY.md](SECURITY.md) |

**当前是第一版实现，不是恶意 APK 沙箱。** 独立的数据目录、设备凭证和工具范围已经实现；新增的 WebRTC 默认关闭，只允许本机、只传音视频。宿主机/局域网防火墙、Pax 远程 WebRTC、完整 Docker 部署和 iOS 后端尚未实现。不要把未知恶意软件直接放到日常电脑上运行。详见 [安全边界](SECURITY.md)。

## 已实现

- 每会话一个服务拥有的模拟器：创建、启动、就绪检查、停止、恢复、销毁。
- 从显式配置的干净 AVD 模板复制私有数据，拒绝符号链接和外部可写磁盘路径；不连接真实手机、不导入用户原有账号。
- 私有 ADB 服务端口与 Android HOME；子进程不继承宿主机凭证环境。
- UI XML、截图、点击、滑动、导航键、输入、启动和列出 App。第一版输入仅支持可打印 ASCII。
- 操作员安装 APK；Agent 不获得任意 ADB shell、宿主文件路径或设备选择能力。
- 内部音频录制（Opus）与屏幕加内部音频录制（MKV），时长及累计文件容量限制，ffprobe 音轨/视频轨验证。
- 可选的本机 WebRTC 实时画面和内部声音；每条连接对应可撤销的媒体进程，无数据通道、无原生 RTC/ADB 入口，输入仍走受限 HTTP。见 [配置和安全设计](docs/webrtc.md)。
- 人工接管暂停 Agent 的观察和操作、结束进行中的录制。人工输入需新鲜且单次使用的截图引用。
- 会话专用 MCP 凭证、独立管理员凭证、只含操作元信息的审计。
- 对可能已完成的输入不自动重试；服务崩溃后先验证设备身份，再恢复，绝不凭磁盘里保存的 PID 杀进程。

## 依赖

Node.js 22+，Android SDK 的 Emulator、Platform Tools 与一个匹配主机架构的系统镜像；录音录屏另需 scrcpy 和 ffprobe（通常随 FFmpeg 安装）。默认使用硬件加速的原生模拟器，Mac 使用系统虚拟化能力，Linux 需要 KVM。无需 Docker。

建议先选择 Android 13+ 镜像。第三方 App 的 ABI、Google Play 依赖、登录风控与模拟器检测仍需要实际验证。scrcpy 的 `--require-audio` 等选项必须受所安装版本支持。

仓库没有 npm 第三方依赖。服务不会自动下载 SDK、接受 SDK 许可或配置 Agent 客户端；Linux 可显式运行[私有安装脚本](docs/linux.md)。

## Linux

首个目标是 **Ubuntu 24.04 x86_64、headless、可访问 KVM**。提供显式安装脚本、私有 Android HOME/XDG 目录和 Linux 主机检查；缺少 KVM 时明确失败，不悄悄退化为软件 CPU 模拟。安装和验收方法见 [docs/linux.md](docs/linux.md)。

```sh
node scripts/setup-linux.cjs --root "$HOME/.local/share/agent-mobile-linux" --plan
node scripts/setup-linux.cjs --root "$HOME/.local/share/agent-mobile-linux" --accept-sdk-licenses
```

Linux ARM、继承用户桌面/声音会话、以及跨容器的本机 WebRTC 不在本版支持范围。Linux 真实模拟器与非静音音频必须在有 `/dev/kvm` 的部署主机验收，不能用 macOS 或无 KVM 的容器测试结果代替。

## 快速使用

1. 用 Android SDK 的 AVD Manager / `avdmanager` **新建专用、没有账号的模板**。保持模板关闭；推荐使用未启动过的干净 AVD。模板中的内容都会复制给新设备，不要选择日常使用的模拟器。快照和 qcow2 运行状态不继承。
2. 优先使用 [Quickstart](docs/quickstart.md) 的安装入口创建专用模板和配置。如果手工复制 [examples/config.json](examples/config.json)，替换所有绝对路径；`templates.clean35.avdDir` 指向专用 `.avd` 目录，不是 `.ini` 文件。SDK 22 生成的新模板可能含占位路径，使用安装入口规范化自己的新模板；不要关闭模板校验。
3. 检查依赖并启动服务：

```sh
node bin/agent-mobile.cjs --config /absolute/config.json doctor
node bin/agent-mobile.cjs --config /absolute/config.json serve
```

`doctor` 返回 `ready:false` 时退出码为 2，不会伪报可用。服务只监听 `127.0.0.1:7341`，默认 ADB 服务端口为 5038，与日常使用的默认端口分开。

另开终端创建、启动设备。下面的 `SESSION_ID` 用创建结果中的 `id` 替换：

```sh
node bin/agent-mobile.cjs --config /absolute/config.json session create --template clean35 --key my-task
node bin/agent-mobile.cjs --config /absolute/config.json session start SESSION_ID
node bin/agent-mobile.cjs --config /absolute/config.json install SESSION_ID --apk /absolute/app.apk
```

创建结果里的 `credentialFile` 是给 MCP 进程读取的私有文件路径，**不是让模型读取其内容**。运行下面的命令生成可合并到 MCP 客户端的配置（绝对 Node 路径、CLI 路径及凭证文件引用，不含 token），合并时保留客户端已有的配置：

```sh
node bin/agent-mobile.cjs --config /absolute/config.json mcp-config SESSION_ID
```

手工配置参考 [examples/mcp.json](examples/mcp.json)。一个 MCP 连接固定绑定该会话，没有任意切换设备的工具。

普通 Agent 会话与管理员共享同一个 OS 用户时，这些权限不是防止 Agent 通过 shell 绕过的安全边界。需要限制 Agent 的宿主 shell/文件访问，或使用独立服务账号/远程机器。

## 录音、录屏及清理

```sh
node bin/agent-mobile.cjs --config /absolute/config.json record start SESSION_ID --kind screen --seconds 30
node bin/agent-mobile.cjs --config /absolute/config.json record list SESSION_ID
node bin/agent-mobile.cjs --config /absolute/config.json record stop SESSION_ID --id RECORDING_ID
node bin/agent-mobile.cjs --config /absolute/config.json session stop SESSION_ID
node bin/agent-mobile.cjs --config /absolute/config.json session destroy SESSION_ID
```

`--kind audio` 只录内部声音。`recording` 表示录制进程已启动，只有 `completed` 才可读取文件。默认 ffprobe 校验必须发现音轨，屏幕录制还必须有视频轨；`audio-track-verified` **不证明声音不是静音**。文件与原始 UI 都可能含敏感内容。

Agent 可通过 `mobile_recording_read` 读取不超过 8 MiB 的已完成文件；较大文件由操作员使用鉴权 artifact API 下载。MKV/Opus 并非所有浏览器都能直接播放。本机实时画面和声音可显式启用 [WebRTC](docs/webrtc.md)；Pax 的截图、控制和录制文件桥接见[接入协议](docs/pax-api.md)，远程 WebRTC 尚未实现。

停止保留 App 数据、录制和凭证；销毁撤销凭证并删除整台设备的私有目录（包括 SD 卡和录像）。容量限制是应用级检查，可能短暂超出，不是 OS 磁盘配额。审计需要操作员按部署需求轮转。

## 本地查看页面

服务启动后，在本机操作员终端执行：

```sh
node bin/agent-mobile.cjs --config /absolute/config.json open
```

浏览器会打开 `http://127.0.0.1:7341/` 并使用两分钟内有效、单次使用的登录链接完成登录。管理员长效 token 不进入页面，也不会输出到终端。页面只使用 HttpOnly、SameSite=Strict 的短期 cookie；退出登录或重启服务会撤销网页登录状态。直接打开地址能看到页面，但操作需要先执行 `open` 登录。

页面提供设备列表、模板选择、新建/启停/销毁、每两秒刷新一次的截图、人工接管和导航键，以及录制结果列表、录音播放和文件下载。按 [WebRTC 设置](docs/webrtc.md) 显式配置后，还可开启本机实时画面和声音。隐藏页面会暂停截图并关闭实时连接。人工点击必须先接管，每次输入消费一张最新截图的引用；输入失败不会自动重发。

没有 SDK 或专用模板时会显示空设备状态，页面不会伪造 Android 画面。macOS 可将 `headless` 改为 `false` 查看原生窗口；本版 Linux 仅支持 headless，通过网页查看。未配置 WebRTC 时使用截图预览；MKV 录屏提供下载，浏览器不一定支持直接播放。

这是本仓库独立的本地查看入口，不会修改 Pax 页面。后续 Pax 查看器可使用同一套设备/API，但不应转发这里的网页 cookie 或登录链接。

## 人工接管与异常恢复

```sh
node bin/agent-mobile.cjs --config /absolute/config.json session takeover SESSION_ID
node bin/agent-mobile.cjs --config /absolute/config.json session release SESSION_ID
```

人工接管结束录制并阻止 Agent 读取截图、操作和下载录制。接管状态持久保存，服务重启不会自动交还 Agent。录制停止后仍可能已捕获先前内容，已发送的画面无法撤回。

正常退出服务（Ctrl+C / SIGTERM）会停止拥有的模拟器与录制，保留会话数据。崩溃后锁文件不会自动删除：确认原服务已退出，再执行 `unlock`。恢复后的设备可能标记 `interrupted`；先 `session stop` 尝试验证 AVD 身份并停止。如果启动崩溃窗口中没有保存 PID，ADB 暂时不存在也不能证明进程不存在，需要人工检查、终止该服务创建的模拟器后执行：

```sh
node bin/agent-mobile.cjs --config /absolute/config.json unlock
node bin/agent-mobile.cjs --config /absolute/config.json serve
# 在另一个操作员终端中，确认该模拟器已停止后：
node bin/agent-mobile.cjs --config /absolute/config.json session recover SESSION_ID --confirm-stopped
```

不要删除不认识的模拟器目录、杀掉任意同名进程，或将 `-no-snapshot` / `-wipe-data` 当成完整数据销毁。

## Pax 接入与验证状态

接口和分工见 [docs/pax-api.md](docs/pax-api.md)。paxd 负责节点本地调用，Manager 校验用户/节点归属，Console 负责展示；本仓库只实现运行时及版本化本地协议。

```sh
npm test
# 真实模拟器验收需要先配置 SDK；不会借用已有设备或真实手机：
AGENT_MOBILE_TEST_CONFIG=/absolute/config.json npm run test:emulator
```

自动测试涵盖私有磁盘、生命周期、崩溃窗口、会话鉴权、接管、MCP、注入防护、容量和录制退出。媒体测试用 FFmpeg 生成真实文件，验证音视频轨及缺失音轨的拒绝行为。测试环境缺少 FFmpeg 时该媒体用例会明确跳过。

Intel macOS 已完成真实 SDK 的完整生命周期及默认 Chrome 音视频验收；Linux 的真实 KVM 设备验收仍需在 Linux 部署主机完成。测试范围、录制音量限制和复现步骤见 [docs/acceptance.md](docs/acceptance.md) 与 [Linux 说明](docs/linux.md)。

## License

Apache-2.0。Android SDK、系统镜像、scrcpy、FFmpeg 与 App 各自遵循其许可；本仓库不附带这些二进制或第三方账号。
