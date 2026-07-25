/**
 * pi-mimo-voice-zh — 小米 MiMo 中文语音扩展
 *
 *   语音输入（MiMo ASR）  — 快捷键可配置，默认 Ctrl+Shift+V
 *   语音输出开关/打断     — 快捷键可配置，默认 Ctrl+Shift+K
 *   agent_end            — 自动朗读回复
 *   配置                  — ~/.pi/mimo-voice-zh.json
 */

// @ts-nocheck — pi 扩展由宿主环境 jiti 加载，依赖由 pi 运行时提供
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
	rmdirSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// ── 硬编码 API ────────────────────────────────────────────────────
const BASE_URL = "https://api.xiaomimimo.com/v1";
const TTS_MODEL = "mimo-v2.5-tts";
const ASR_MODEL = "mimo-v2.5-asr";
const VALID_VOICES = ["冰糖", "茉莉", "苏打", "白桦"];
const API_TIMEOUT_MS = 30_000;

// ── 类型 ──────────────────────────────────────────────────────────
interface VoiceSettings {
	ttsEnabled: boolean;
	sttEnabled: boolean;
	voice: string;
	apiKey: string;
	sttShortcut: string;
	ttsShortcut: string;
}

// ── 路径 ──────────────────────────────────────────────────────────
const CONFIG_PATH = join(homedir(), ".pi", "mimo-voice-zh.json");

const DEFAULT_SETTINGS: VoiceSettings = {
	voice: "冰糖",
	apiKey: "",
	ttsEnabled: true,
	sttEnabled: true,
	ttsShortcut: "ctrl+shift+k",
	sttShortcut: "ctrl+shift+v",
};

// ── 持久化 ────────────────────────────────────────────────────────
function loadSettings(): VoiceSettings {
	try {
		if (existsSync(CONFIG_PATH)) {
			return {
				...DEFAULT_SETTINGS,
				...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")),
			};
		}
	} catch {
		/* ignore */
	}
	return { ...DEFAULT_SETTINGS };
}

function saveSettings(cfg: VoiceSettings): void {
	try {
		mkdirSync(join(homedir(), ".pi"), { recursive: true });
		const existing = existsSync(CONFIG_PATH)
			? JSON.parse(readFileSync(CONFIG_PATH, "utf-8"))
			: {};
		writeFileSync(
			CONFIG_PATH,
			JSON.stringify({ ...existing, ...cfg }, null, 2),
			"utf-8",
		);
	} catch (e) {
		console.warn("[mimo-voice] save error:", e);
	}
}

// ── 状态 ──────────────────────────────────────────────────────────
let settings = loadSettings();
let speakGen = 0;
let currentPlayer: ChildProcess | null = null;
let recording = false;
let recorder: ChildProcess | null = null;
let recordingPath: string | null = null;
let tmpDir: string;

// ── 临时目录管理 ──────────────────────────────────────────────────

/** 清理旧的 pi-mimo-voice-zh-* 临时目录（保留当前的） */
function cleanupOldTmpDirs(): void {
	try {
		const parent = tmpdir();
		const entries = readdirSync(parent);
		for (const entry of entries) {
			if (!entry.startsWith("pi-mimo-voice-zh-")) continue;
			const dir = join(parent, entry);
			if (dir === tmpDir) continue; // 跳过当前目录
			try {
				const age = Date.now() - statSync(dir).mtimeMs;
				if (age > 3600_000) {
					// 超过 1 小时的旧目录
					for (const f of readdirSync(dir)) unlinkSync(join(dir, f));
					rmdirSync(dir);
				}
			} catch {
				/* ignore individual dir errors */
			}
		}
	} catch {
		/* ignore */
	}
}

/** 清理当前临时目录中的所有文件 */
function cleanTmpDir(): void {
	try {
		if (!tmpDir || !existsSync(tmpDir)) return;
		for (const f of readdirSync(tmpDir)) {
			try {
				unlinkSync(join(tmpDir, f));
			} catch {
				/* ignore */
			}
		}
	} catch {
		/* ignore */
	}
}

// ── 文本清洗 ──────────────────────────────────────────────────────
function cleanText(text: string): string {
	return (
		text
			// 移除代码块
			.replace(/```[\s\S]*?```/g, "")
			// 移除行内代码
			.replace(/`([^`]+)`/g, "$1")
			// 移除图片 ![alt](url)
			.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
			// 移除链接，保留文字 [text](url) → text
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			// 移除 HTML 标签
			.replace(/<[^>]+>/g, "")
			// 移除加粗/斜体/删除线标记
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/__([^_]+)__/g, "$1")
			.replace(/\*([^*]+)\*/g, "$1")
			.replace(/_([^_]+)_/g, "$1")
			.replace(/~~([^~]+)~~/g, "$1")
			// 移除 markdown 特殊字符
			.replace(/[#>|\\]/g, " ")
			// 合并空白
			.replace(/\s+/g, " ")
			.trim()
	);
}

// ── 文本分段 ──────────────────────────────────────────────────────
// MiMo TTS 是 LLM 驱动的，单次调用文本过长会导致模型"跑偏"。
// 实测 ~3000 字无问题，~10000 字开始乱说。
// 按段落拆分：段落内语气自然连贯，段落间过渡也比逐句拆分平滑。
// 遇超长段落再兜底按句子拆分。
const MAX_CHUNK = 2000;

function splitChunks(text: string): string[] {
	const paragraphs = text
		.split(/\n{2,}/)
		.map((s) => s.trim())
		.filter(Boolean);
	const result: string[] = [];
	for (const p of paragraphs) {
		if (p.length <= MAX_CHUNK) {
			result.push(p);
		} else {
			// 超长段落兜底：按句子拆分
			const sentences = p
				.split(/(?<=[。！？])/)
				.map((s) => s.trim())
				.filter(Boolean);
			for (const s of sentences) result.push(s);
		}
	}
	return result;
}

// ── MiMo ASR ──────────────────────────────────────────────────────
async function callASR(wavPath: string): Promise<string | null> {
	if (!settings.apiKey) return null;
	try {
		const b64 = readFileSync(wavPath).toString("base64");
		const res = await fetch(`${BASE_URL}/chat/completions`, {
			method: "POST",
			headers: {
				"api-key": settings.apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: ASR_MODEL,
				messages: [
					{
						role: "user",
						content: [
							{
								type: "input_audio",
								input_audio: { data: `data:audio/wav;base64,${b64}` },
							},
						],
					},
				],
				asr_options: { language: "zh" },
			}),
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		});
		if (!res.ok) {
			console.warn("[mimo-voice] ASR HTTP:", res.status);
			return null;
		}
		const data: any = await res.json();
		return data?.choices?.[0]?.message?.content || null;
	} catch (e: any) {
		console.warn("[mimo-voice] ASR:", e.message);
		return null;
	}
}

// ── MiMo TTS ──────────────────────────────────────────────────────
async function callTTS(text: string, voiceId: string): Promise<Buffer | null> {
	if (!settings.apiKey) return null;
	try {
		const res = await fetch(`${BASE_URL}/chat/completions`, {
			method: "POST",
			headers: {
				"api-key": settings.apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: TTS_MODEL,
				messages: [{ role: "assistant", content: text }],
				audio: { format: "wav", voice: voiceId },
			}),
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		});
		if (!res.ok) {
			console.warn("[mimo-voice] TTS HTTP:", res.status);
			return null;
		}
		const data: any = await res.json();
		const b64 = data?.choices?.[0]?.message?.audio?.data;
		return b64 ? Buffer.from(b64, "base64") : null;
	} catch (e: any) {
		console.warn("[mimo-voice] TTS:", e.message);
		return null;
	}
}

// ── 播放 ──────────────────────────────────────────────────────────
function stopSpeak(): void {
	if (currentPlayer) {
		currentPlayer.kill("SIGTERM");
		currentPlayer = null;
	}
	speakGen++;
}

function playWav(wavPath: string, gen: number): void {
	currentPlayer = spawn("afplay", [wavPath], { stdio: "ignore" });
	currentPlayer.on("error", (err: Error) => {
		console.warn("[mimo-voice] afplay:", err.message);
		// 播放失败时也清理临时文件
		try {
			unlinkSync(wavPath);
		} catch {
			/* ignore */
		}
		if (speakGen === gen) currentPlayer = null;
	});
	currentPlayer.on("close", () => {
		try {
			unlinkSync(wavPath);
		} catch {
			/* ignore */
		}
		if (speakGen === gen) currentPlayer = null;
	});
}

async function speakChunks(
	chunks: string[],
	onProgress?: (current: number, total: number) => void,
): Promise<void> {
	if (!chunks.length) return;
	stopSpeak();
	const gen = speakGen;
	const total = chunks.length;
	for (let i = 0; i < total; i++) {
		if (speakGen !== gen) return;
		const chunk = chunks[i];
		if (!chunk) continue;
		onProgress?.(i + 1, total);
		const wav = await callTTS(chunk, settings.voice);
		if (!wav) continue;
		if (speakGen !== gen) return;
		const p = join(tmpDir, `tts-${gen}-${i}.wav`);
		writeFileSync(p, wav);
		playWav(p, gen);
		if (currentPlayer) {
			await new Promise<void>((r) => currentPlayer!.once("close", r));
		}
	}
	if (speakGen === gen) {
		currentPlayer = null;
		onProgress?.(0, 0);
	}
}

// ── STT handler ───────────────────────────────────────────────────
async function sttHandler(ctx: ExtensionContext): Promise<void> {
	if (!settings.sttEnabled) {
		ctx.ui.notify("ASR 已关闭", "warning");
		return;
	}
	if (!settings.apiKey) {
		ctx.ui.notify("请先设置 API Key（~/.pi/mimo-voice-zh.json）", "error");
		return;
	}

	if (recording) {
		// ── 停止录音并识别 ──
		if (recorder) {
			recorder.kill("SIGTERM");
			recorder = null;
		}
		recording = false;
		ctx.ui.setStatus(
			"mimo-voice",
			settings.ttsEnabled ? "🔔 TTS 开启" : "🔕 TTS 关闭",
		);
		ctx.ui.notify("识别中...", "info");

		// 等待 recorder 进程完全退出，确保文件写入完成
		await new Promise<void>((resolve) => {
			const check = () => {
				if (!recording) return resolve();
				setTimeout(check, 100);
			};
			setTimeout(check, 200);
		});

		if (!recordingPath || !existsSync(recordingPath)) {
			ctx.ui.notify("录音文件丢失", "error");
			recordingPath = null;
			return;
		}

		const text = await callASR(recordingPath);
		try {
			unlinkSync(recordingPath);
		} catch {
			/* ignore */
		}
		recordingPath = null;

		if (text) {
			ctx.ui.setEditorText(text);
			ctx.ui.notify(`识别: ${text.slice(0, 40)}`, "info");
		} else {
			ctx.ui.notify("语音识别失败，请检查网络或 API Key", "error");
		}
	} else {
		// ── 开始录音 ──
		stopSpeak();
		recording = true;
		recordingPath = join(tmpDir, `stt-${Date.now()}.wav`);
		recorder = spawn(
			"sox",
			["-d", "-r", "16000", "-c", "1", "-b", "16", recordingPath],
			{ stdio: "ignore" },
		);
		recorder.on("error", (err: Error) => {
			console.warn("[mimo-voice] sox:", err.message);
			recording = false;
			recorder = null;
			recordingPath = null;
			ctx.ui.notify(`录音失败: ${err.message}`, "error");
		});
		ctx.ui.setStatus("mimo-voice", "🔴 正在录音");
		ctx.ui.notify("🔴 录音中，再按快捷键停止", "info");
	}
}

// ── 入口 ──────────────────────────────────────────────────────────
export default function mimoVoiceZh(pi: ExtensionAPI) {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-mimo-voice-zh-"));

	function updateStatus(ctx?: ExtensionContext) {
		if (ctx?.ui)
			ctx.ui.setStatus(
				"mimo-voice",
				settings.ttsEnabled ? "🔔 TTS 开启" : "🔕 TTS 关闭",
			);
	}

	pi.on("session_start", (_event, ctx) => {
		settings = loadSettings();
		saveSettings(settings);

		// 校验 voice 配置
		if (!VALID_VOICES.includes(settings.voice)) {
			ctx.ui.notify(
				`无效音色 "${settings.voice}"，已重置为"冰糖"。可选: ${VALID_VOICES.join("、")}`,
				"warning",
			);
			settings.voice = DEFAULT_SETTINGS.voice;
			saveSettings(settings);
		}

		// 清理旧临时目录，确保当前临时目录存在
		cleanupOldTmpDirs();
		cleanTmpDir();
		updateStatus(ctx);
	});

	// STT 快捷键
	pi.registerShortcut(settings.sttShortcut, {
		description: "MiMo 语音输入",
		handler: async (ctx) => sttHandler(ctx),
	});

	// TTS 快捷键
	pi.registerShortcut(settings.ttsShortcut, {
		description: "MiMo TTS 开关/打断",
		handler: async (ctx) => {
			if (currentPlayer) {
				stopSpeak();
				ctx.ui.notify("朗读已打断", "warning");
			} else {
				settings.ttsEnabled = !settings.ttsEnabled;
				saveSettings(settings);
				updateStatus(ctx);
				ctx.ui.notify(
					`TTS：${settings.ttsEnabled ? "开启" : "关闭"}`,
					settings.ttsEnabled ? "info" : "warning",
				);
			}
		},
	});

	// agent_end 自动朗读
	pi.on("agent_end", async (event, ctx) => {
		if (!settings.ttsEnabled || !settings.apiKey) return;
		const msgs = event.messages;
		if (!msgs?.length) return;
		const last = msgs[msgs.length - 1];
		if (last.role !== "assistant") return;
		const text = (last.content as { type: string; text?: string }[])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
		const cleaned = cleanText(text);
		if (!cleaned) return;
		const chunks = splitChunks(cleaned);
		speakChunks(chunks, (cur, total) => {
			if (total > 1) ctx.ui.setStatus("mimo-voice", `🔊 朗读 ${cur}/${total}`);
			else ctx.ui.setStatus("mimo-voice", "🔊 朗读中");
		}).then(() => updateStatus(ctx));
	});

	pi.on("session_shutdown", () => {
		stopSpeak();
		cleanTmpDir();
	});
}
