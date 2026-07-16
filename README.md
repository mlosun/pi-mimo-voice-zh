# pi-mimo-voice-zh

[![npm](https://img.shields.io/npm/v/pi-mimo-voice-zh?style=flat-square)](https://www.npmjs.com/package/pi-mimo-voice-zh)

> ⚠️ **注意**：本项目完全由 AI 生成，作者本人并不懂 TypeScript。如有问题请通过 [Issues](https://github.com/mlosun/pi-mimo-voice-zh/issues) 提出，我会尽力解决。
>
> 目前仅支持 MiMo API Key，暂不支持 Token Plan。

小米 MiMo 中文语音扩展。

| 操作 | 快捷键 |
|------|--------|
| 🎤 语音输入 | `Ctrl+Shift+V` |
| 🔊 开关/打断 | `Ctrl+Shift+K` |

AI 回复完自动朗读。朗读前自动清理 markdown。

## 平台要求

- **macOS**（已测试）
- **Homebrew**（安装 sox）
- Windows 暂未支持

## 安装

```bash
# 1. 安装录音工具
brew install sox

# 2. 安装扩展（二选一）
pi install npm:pi-mimo-voice-zh              # npm（推荐）
pi install git:github.com/mlosun/pi-mimo-voice-zh  # GitHub

# 3. 创建配置文件
# npm 安装：
cp ~/.pi/agent/npm/pi-mimo-voice-zh/mimo-voice-zh.example.json ~/.pi/mimo-voice-zh.json
# GitHub 安装：
cp ~/.pi/agent/git/github.com/mlosun/pi-mimo-voice-zh/mimo-voice-zh.example.json ~/.pi/mimo-voice-zh.json
```

编辑 `~/.pi/mimo-voice-zh.json`，将 `apiKey` 设为你的 MiMo API Key。获取地址：[platform.xiaomimimo.com](https://platform.xiaomimimo.com)。

```bash
# 4. 加载
pi /reload
```

状态栏出现 🔔 TTS 开启 即表示加载成功。

## 配置

`~/.pi/mimo-voice-zh.json`：

```json
{
  "voice": "冰糖",
  "apiKey": "sk-...",
  "ttsEnabled": true,
  "sttEnabled": true,
  "ttsShortcut": "ctrl+shift+k",
  "sttShortcut": "ctrl+shift+v"
}
```

| 字段 | 说明 |
| ------ | ------ |
| `voice` | 音色：冰糖 / 茉莉 / 苏打 / 白桦 |
| `apiKey` | MiMo API Key |
| `ttsEnabled` | TTS 朗读开关 |
| `sttEnabled` | STT 语音输入开关 |
| `ttsShortcut` | TTS 快捷键 |
| `sttShortcut` | STT 快捷键 |

## MiMo 模型费用说明

MiMo ASR 按用量收费，TTS 限时免费。详见 [MiMo 模型定价](https://mimo.mi.com/#/docs/pricing)。

如希望完全免费，可用 macOS 系统听写代替 ASR：

1. 系统设置 → 键盘 → 听写 → 开启
2. `~/.pi/mimo-voice-zh.json` → `sttEnabled: false` 关闭 ASR
3. 按两下 Ctrl 触发系统听写，口述后文字自动输入。

## 技术说明

MiMo TTS 是 LLM 驱动的语音合成，底层走的是 Chat Completions 端点，而非传统 TTS 引擎。这意味着文本是作为对话内容传给大模型的，模型"扮演"助理将文字念出来。

这种行为带来一个特性：**单次传入的文本过长（实测 ~10000 字）时，模型可能"跑偏"**，表现为语音变得不连贯或内容错乱。短文本（~3000 字以内）则表现正常。

本扩展的应对策略：

1. **按段落拆分**：以空行为界将回复拆成多个段落，逐段调用 TTS
2. **段落内语气一致**：段落是天然的语气单元，同段内的语音自然连贯
3. **超长段落兜底**：遇到超过 2000 字的段落，再降级按句子拆分

这样既保证了长文本不会触发模型"跑偏"，也避免了逐句拆分带来的语气割裂感。

## 状态栏

| 显示 | 含义 |
|------|------|
| 🔔 TTS 开启 | 语音输出已开启 |
| 🔕 TTS 关闭 | 语音输出已关闭 |
| 🔴 正在录音 | 录音中 |

## 功能清单

### TTS 语音输出

| # | 场景 | 预期 |
| --- | ------ | ------ |
| 1 | `/reload` 后发一条消息 | AI 回复自动朗读。状态栏显示 🔔 TTS 开启 |
| 2 | 回复很长（多段落） | 全文朗读，标点间自然停顿 |
| 3 | 回复含代码块、粗体、斜体 | markdown 格式被清洗，只朗读纯文字内容 |
| 4 | 回复含表格 | 表格内容按文本朗读 |
| 5 | 朗读中按 `Ctrl+Shift+K` | 立即停止，通知"朗读已打断" |
| 6 | 空闲时按 `Ctrl+Shift+K` | TTS 切换为关闭。状态栏变 🔕 TTS 关闭。再发消息不朗读 |
| 7 | TTS 关闭时按 `Ctrl+Shift+K` | TTS 切换为开启。状态栏变 🔔 TTS 开启 |
| 8 | 修改 `~/.pi/mimo-voice-zh.json` → `voice: "苏打"` → `/reload` | 朗读变为男声苏打 |

### STT 语音输入

| # | 场景 | 预期 |
| --- | ------ | ------ |
| 9 | 按 `Ctrl+Shift+V` | 状态栏变 🔴 正在录音 |
| 10 | 说话后按 `Ctrl+Shift+V` | 识别完成，文字填入编辑器 |
| 11 | 未设置麦克风权限 | `sox` 报错，通知"录音失败" |
| 12 | `~/.pi/mimo-voice-zh.json` → `sttEnabled: false` → `/reload` 后按快捷键 | 通知"ASR 已关闭" |
| 13 | `~/.pi/mimo-voice-zh.json` → `sttShortcut` 改为其他值 → `/reload` | 新快捷键生效，旧键失效 |

### 配置项测试

| # | 场景 | 预期 |
| --- | ------ | ------ |
| 14 | 首次启动，`~/.pi/mimo-voice-zh.json` 不存在 | 自动生成，使用默认值 |
| 15 | `~/.pi/mimo-voice-zh.json` → `apiKey` 为空 → `/reload` 后语音输入 | 通知"请先设置 API Key" |
| 16 | `~/.pi/mimo-voice-zh.json` → `ttsEnabled: false` → `/reload` | 状态栏 🔕 TTS 关闭，回复不朗读 |
| 17 | 手动在 `~/.pi/mimo-voice-zh.json` 添加额外字段，操作后检查 | 额外字段不被删除（merge 保存） |

## 更新日志

### 0.0.4

- **修复**：长文本 TTS 语音"跑偏"问题。改为按段落拆分后逐段调用 MiMo TTS，超长段落兜底按句拆分
- **新增**：README 技术说明章节，解释 MiMo TTS 的 LLM 驱动特性及应对策略

### 0.0.3

- **新增**：发布到 npm，支持 `pi install npm:pi-mimo-voice-zh`
- **新增**：npm 版本徽章、双安装方式（npm / GitHub）
- **优化**：`package.json` 补充 author、repository、files 字段

### 0.0.2

- **新增**：README 添加 AI 生成声明及 MiMo API Key 限制说明

### 0.0.1

- 初始版本：MiMo ASR 语音输入 + TTS 语音输出
