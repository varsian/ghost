/**
 * Model-facing `tts` tool: speaks text through a locally resident VoxCPM 1.5 daemon and resolves only
 * after the audio has finished playing. Every call that runs repeats the usable emotion list, so an unknown
 * emotion is a reported fallback rather than a failed call. Named exports preserve loader injection
 * metadata.
 * @module @deepseek-ai/dsh-tool-tts
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { parseTtsArgs } from "./args.js";
import { DaemonClient } from "./daemon.js";
import { fallbacksOf, renderFailureText, renderSuccessText } from "./result.js";
export const name = 'tool-tts';
export const inject = ['tools'];
/** The daemon script shipped inside this package, used when `daemonScript` is not configured. */
const DEFAULT_DAEMON_SCRIPT = fileURLToPath(new URL('../python/tts_daemon.py', import.meta.url));
/**
 * Where a call's WAV files go when the model asked to save but named no directory: the configured
 * `saveDir`, else `<cacheDir>\wav` — the same fallback the daemon applies, reported so the model
 * can find the files it asked for.
 * @param saveDir - the model-supplied directory, or `''` when it named none.
 * @param config - the deployment configuration.
 * @returns the directory the daemon will write to.
 */
function saveTarget(saveDir, config) {
    if (saveDir !== '')
        return saveDir;
    return config.saveDir !== '' ? config.saveDir : join(config.cacheDir, 'wav');
}
/**
 * Build the daemon argv. Every entry is a configured value: the daemon's behavior must be
 * reproducible from the composition, never from a constant buried in this plugin.
 * @param config - the deployment configuration.
 * @returns the daemon argv after the script path.
 */
function daemonArgs(config) {
    return [
        '--voices-dir', config.voicesDir,
        '--default-emotion', config.defaultEmotion,
        '--model-dir', config.modelDir,
        '--device', config.device,
        '--cfg-value', String(config.cfgValue),
        '--timesteps', String(config.inferenceTimesteps),
        '--optimize', String(config.optimize),
        '--normalize', String(config.normalizeText),
        '--cache-dir', config.cacheDir,
        '--save-dir', config.saveDir,
        '--max-sentence-chars', String(config.maxSentenceChars),
        '--first-sentence-max-chars', String(config.firstSentenceMaxChars),
        '--merge-sentences', config.mergeSentences,
        '--merge-max-chars', String(config.mergeMaxChars),
        '--short-sentence-chars', String(config.shortSentenceChars),
        '--seed', String(config.samplingSeed),
        '--idle-unload-sec', String(config.idleUnloadSec),
        '--preload', String(config.preload),
        '--output-device', config.outputDevice,
    ];
}
/**
 * Reject a configuration whose values are meaningless before the daemon ever starts. The daemon is
 * lazy, so a bad path surfaces on the first call; these are self-contained and fail at load. The
 * merge mode itself needs no check here: the `Config` schema's union already admits only
 * `off | short | all`, and the Loader validates the row against that schema before `apply` runs.
 * @param config - the deployment configuration.
 */
function assertConfig(config) {
    if (config.pythonPath === '') {
        throw new Error('tool-tts: config.pythonPath must name the Python interpreter that runs the daemon');
    }
    if (!Number.isFinite(config.toolTimeoutMs) || config.toolTimeoutMs <= 0) {
        throw new Error(`tool-tts: config.toolTimeoutMs must be a positive finite number, got ${String(config.toolTimeoutMs)}`);
    }
    if (!Number.isInteger(config.maxSentenceChars) || config.maxSentenceChars < 1) {
        throw new Error(`tool-tts: config.maxSentenceChars must be a positive integer, got ${String(config.maxSentenceChars)}`);
    }
    if (!Number.isInteger(config.firstSentenceMaxChars) || config.firstSentenceMaxChars < 1) {
        throw new Error(`tool-tts: config.firstSentenceMaxChars must be a positive integer, got ${String(config.firstSentenceMaxChars)}`);
    }
    if (!Number.isInteger(config.idleUnloadSec) || config.idleUnloadSec < 0) {
        throw new Error(`tool-tts: config.idleUnloadSec must be a non-negative integer, got ${String(config.idleUnloadSec)}`);
    }
    if (!Number.isInteger(config.mergeMaxChars) || config.mergeMaxChars < 0) {
        throw new Error(`tool-tts: config.mergeMaxChars must be a non-negative integer, got ${String(config.mergeMaxChars)}`);
    }
    if (!Number.isInteger(config.shortSentenceChars) || config.shortSentenceChars < 0) {
        throw new Error(`tool-tts: config.shortSentenceChars must be a non-negative integer, got ${String(config.shortSentenceChars)}`);
    }
    if (!Number.isInteger(config.samplingSeed) || config.samplingSeed < 0) {
        throw new Error(`tool-tts: config.samplingSeed must be a non-negative integer, got ${String(config.samplingSeed)}`);
    }
    if (!Number.isFinite(config.cfgValue) || config.cfgValue < 0.1 || config.cfgValue > 10) {
        throw new Error(`tool-tts: config.cfgValue must be a finite number in [0.1, 10], got ${String(config.cfgValue)}`);
    }
    if (!Number.isInteger(config.inferenceTimesteps) || config.inferenceTimesteps < 1 || config.inferenceTimesteps > 100) {
        throw new Error(`tool-tts: config.inferenceTimesteps must be an integer in [1, 100], got ${String(config.inferenceTimesteps)}`);
    }
}
/**
 * The model-facing description, written to the repository's tool-description conventions. The
 * reusable rules were distilled from the shipped tools and apply here as noted:
 *
 * 1. Open with what the tool does and its one-shot or blocking cost
 *    (`tool-pwsh` "Execute a PowerShell command … Each call runs in a fresh pwsh process";
 *    `tool-fs` read.ts "Read a UTF-8 text file and return line-numbered content"). Here: the first
 *    paragraph says the tool speaks locally, that the call blocks until playback drains, and that
 *    the first call loads the voice model.
 * 2. Give every input form with a concrete example and name the canonical one (`tool-todo`,
 *    `tool-web` search.ts). Here: object items are canonical, the flat string form is the shorthand,
 *    and both appear with examples.
 * 3. Per parameter, state the default and the exact reach of the value (`tool-pwsh` `timeoutMs` /
 *    `workdir`; read.ts "Defaults to 1."). Here: the parameter descriptions own the `play`,
 *    `save_dir`, and `gap_ms` defaults and reach, so the description keeps only the cross-parameter
 *    fact they cannot state — `gap_ms` has no effect with `play: false`.
 * 4. Enumerate a closed value set the model must choose from, instead of describing it in prose
 *    (`tool-subagent`'s provider wording, plan-mode's outcome labels). Here: the usable-emotion list
 *    every call that runs repeats, which after rev 10 is the only closed set the model chooses from.
 * 5. State the failure semantics the model must avoid (`tool-pwsh`'s denial/escalation rules). Here:
 *    text in a script the installed model cannot read fails the whole call, while an unknown emotion
 *    never fails one.
 * 6. No implementation vocabulary and no knobs the model cannot use: engine flags, daemon details,
 *    sentence-splitting limits, language-resolution internals, and tunables stay out. Here: nothing
 *    about the engine, the sentence cap, or the reference-text machinery appears.
 * 7. One topic per short paragraph, so a long description stays scannable (`tool-pwsh`); the wording
 *    is stable, because the generated tool catalog and the README quote it verbatim.
 * 8. Compose from configuration where a clause genuinely depends on the deployment
 *    (`pwshDescription`, `tool-todo`'s `describe()`). Here: the emotion-list clause follows
 *    `emotionListInResults`, because `onFallback` shortens a routine success while `always` repeats
 *    the list on every call that runs. Everything else is deployment-independent — the voice
 *    paragraph states the clone relationship generically, and the installed voices are README data.
 */
/**
 * Build the model-facing description for one deployment.
 * @param emotionListInResults - whether a successful call repeats the usable-emotion list.
 * @returns the description with its paragraphs joined by blank lines.
 */
function describe(emotionListInResults) {
    // One home per fact: the parameter descriptions own the per-parameter defaults and reach, so this
    // description keeps only the cross-parameter fact they cannot state (`gap_ms` with `play: false`).
    const emotionParagraph = emotionListInResults === 'always'
        ? '`emotion` names a voice from the usable-emotion list. An unknown name never fails the call: the '
            + 'default voice speaks and the result reports the substitution. Every call that runs — success or '
            + 'failure — repeats that list as `(a,b,c)`; use only those names.'
        : '`emotion` names a voice from the usable-emotion list. An unknown name never fails the call: the '
            + 'default voice speaks and the result reports the substitution. Every failure repeats that list as '
            + '`(a,b,c)`, and a successful call repeats it when an emotion was substituted; use only those names.';
    return [
        'Speak text aloud on this machine through a local voice model. The call returns after the audio '
            + 'has finished playing — or after the WAV files are written, either with `play: false` or into a '
            + '`save_dir` — so a long utterance keeps the call running; the first call also loads the model, '
            + 'which delays that first utterance by about ten seconds.',
        '',
        '`segments` takes either objects `{ emotion?, content }` — for example '
            + '`[{"emotion":"开心","content":"你好"}]` — or a flat alternating list whose positions 0, 2, 4… '
            + 'are emotions and 1, 3, 5… their contents, for example '
            + '`["开心","你好","默认","再见"]`. In the string form every emotion must be followed by its '
            + 'content; use object items for content that needs no emotion. Several segments play back to back '
            + '— prefer one call with several segments over one per sentence.',
        '',
        'Voices clone the reference recording installed for each emotion and continue from it, so that '
            + 'recording carries its timbre and its delivery into the speech; replacing an emotion\'s reference '
            + 'audio changes its voice. The installed voice model speaks Chinese and English only: text in a '
            + 'script it cannot read — Japanese, Korean, or Russian, for example — fails the call instead of '
            + 'being read as Chinese, so pass Chinese or English text only.',
        '',
        emotionParagraph,
        '',
        'With `play: false` nothing is played, so `gap_ms` has no effect.',
    ].join('\n');
}
/** Schemastery configuration for the `tts` tool. */
export const Config = z.object({
    pythonPath: z.string().required(),
    daemonScript: z.string().default(DEFAULT_DAEMON_SCRIPT),
    voicesDir: z.string().required(),
    defaultEmotion: z.string().default('默认'),
    modelDir: z.string().required(),
    device: z.string().default('cuda:0'),
    cfgValue: z.number().default(2.7),
    inferenceTimesteps: z.number().default(10),
    optimize: z.boolean().default(false),
    normalizeText: z.boolean().default(false),
    cacheDir: z.string().required(),
    saveDir: z.string().default(''),
    maxSentenceChars: z.number().default(60),
    firstSentenceMaxChars: z.number().default(20),
    idleUnloadSec: z.number().default(1800),
    preload: z.boolean().default(false),
    outputDevice: z.string().default(''),
    mergeSentences: z.union(['off', 'short', 'all']).default('short'),
    mergeMaxChars: z.number().default(0),
    shortSentenceChars: z.number().default(20),
    samplingSeed: z.number().default(0),
    emotionListInResults: z.union(['always', 'onFallback']).default('always'),
    toolTimeoutMs: z.number().default(600_000),
});
/**
 * Register the `tts` tool on `ctx.tools` and own one daemon for this plugin's lifetime.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment paths, engine options, and the per-call deadline.
 */
export function apply(ctx, config) {
    // schemastery (Config) has already filled every defaulted field.
    const resolved = config;
    assertConfig(resolved);
    const client = new DaemonClient({
        pythonPath: resolved.pythonPath,
        script: resolved.daemonScript,
        argsFor: () => daemonArgs(resolved),
        timeoutMs: resolved.toolTimeoutMs,
        // The daemon's stderr records (and any non-JSON stdout line) reach the host log, never the model.
        onLog: (line) => { ctx.logger.warn(`[tool-tts] ${line}`); },
    });
    // Disposal order is reverse registration order, so the tool unregisters before its daemon dies.
    ctx.effect(() => () => client.dispose(), 'tool-tts daemon');
    ctx.tools.register(defineTool({
        name: 'tts',
        description: describe(resolved.emotionListInResults),
        parameters: {
            segments: {
                type: 'array',
                required: true,
                description: 'The utterance: `{emotion?,content}` items, or the flat alternating '
                    + 'string form (`emotion`, `content`, `emotion`, `content`, …). Several segments play back '
                    + 'to back.',
                items: {
                    oneOf: [
                        {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                emotion: {
                                    type: 'string',
                                    description: 'Voice name from the usable-emotion list every result returns. Omit for the default voice.',
                                },
                                content: { type: 'string', required: true, description: 'Text to speak.' },
                            },
                        },
                        { type: 'string' },
                    ],
                },
            },
            play: {
                type: 'boolean',
                description: 'Play on this machine\'s speakers (default true). `false` saves WAV files only.',
            },
            save_dir: {
                type: 'string',
                description: 'Directory for the produced WAV files (created if missing); naming one writes '
                    + 'the files even while the audio plays.',
            },
            gap_ms: {
                type: 'integer',
                description: 'Silence played between segments, in milliseconds (default 120). Playback only: '
                    + 'not written to the saved files and not counted in the reported total.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true, description: 'Whether every segment produced audio.' },
                    totalSeconds: { type: 'number', required: true, description: 'Audible audio seconds produced.' },
                    segments: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                index: { type: 'integer', required: true },
                                requestedEmotion: { type: 'string', required: true },
                                usedEmotion: { type: 'string', required: true },
                                fallback: { type: 'boolean', required: true },
                                seconds: { type: 'number', required: true },
                                sentences: { type: 'integer', required: true },
                            },
                        },
                    },
                    emotions: { type: 'array', required: true, description: 'Usable emotions at call time.', items: { type: 'string' } },
                    defaultEmotion: { type: 'string', required: true, description: 'The engine\'s effective default emotion.' },
                    fallbacks: {
                        type: 'array',
                        required: true,
                        description: 'Every requested emotion that the engine replaced.',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                requestedEmotion: { type: 'string', required: true },
                                usedEmotion: { type: 'string', required: true },
                            },
                        },
                    },
                    rtf: { type: 'number', required: true, description: 'Generation seconds ÷ audio seconds for this call.' },
                    firstAudioMs: {
                        type: 'integer',
                        required: true,
                        description: 'Wall milliseconds from `speak_start` to the first audible sample.',
                    },
                    modelLoadMs: { type: 'integer', required: true, description: 'Model load milliseconds; 0 once resident.' },
                    modelWasLoaded: { type: 'boolean', required: true, description: 'Whether the model was already resident.' },
                    files: { type: 'array', required: true, description: 'WAV files produced by this call.', items: { type: 'string' } },
                    savedTo: { type: 'string', description: 'Directory the WAV files were written to.' },
                    notes: { type: 'array', required: true, description: 'Engine notes, e.g. an unsupported speed.', items: { type: 'string' } },
                    error: {
                        type: 'object',
                        additionalProperties: false,
                        description: 'Present exactly when `ok` is false.',
                        properties: {
                            code: { type: 'string', required: true },
                            message: { type: 'string', required: true },
                        },
                    },
                    engineRestarted: { type: 'boolean', required: true, description: 'This call ran on a restarted daemon.' },
                    backend: {
                        type: 'string',
                        required: true,
                        description: 'Engine that served this call (`voxcpm`).',
                    },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.ok
                        ? renderSuccessText(value, resolved.emotionListInResults)
                        : renderFailureText(value.error?.message ?? value.error?.code ?? '未知错误', value.emotions),
                }],
        },
        // The tool forwards `exec.signal` into the daemon call, which kills a daemon that overran its
        // deadline, so the cooperative budget reaches quiescence on abort.
        timeoutMs: resolved.toolTimeoutMs,
        presentCall: args => ({
            card: 'generic',
            title: 'Speak text aloud',
            kind: 'other',
            rawInput: args.segments,
        }),
        async execute(args, exec) {
            const parsed = parseTtsArgs(args);
            const requestedSaveDir = parsed.saveDir ?? '';
            const save = parsed.saveDir !== undefined || !parsed.play || resolved.saveDir !== '';
            const request = {
                op: 'speak',
                segments: parsed.segments,
                play: parsed.play,
                save,
                saveDir: requestedSaveDir,
                gapMs: parsed.gapMs,
                speed: parsed.speed,
            };
            const outcome = await client.speak(request, exec.signal);
            const savedTo = save ? saveTarget(requestedSaveDir, resolved) : undefined;
            if (outcome.kind === 'done') {
                return {
                    ok: true,
                    totalSeconds: outcome.done.totalSeconds,
                    segments: outcome.done.segments,
                    emotions: outcome.emotions,
                    defaultEmotion: outcome.defaultEmotion,
                    fallbacks: fallbacksOf(outcome.done.segments),
                    rtf: outcome.done.rtf,
                    firstAudioMs: outcome.done.firstAudioMs,
                    modelLoadMs: outcome.done.modelLoadMs,
                    modelWasLoaded: outcome.done.modelWasLoaded,
                    files: outcome.done.files,
                    notes: outcome.done.notes,
                    engineRestarted: outcome.engineRestarted,
                    backend: outcome.backend,
                    ...savedTo === undefined ? {} : { savedTo },
                };
            }
            const logs = client.logs;
            return {
                ok: false,
                totalSeconds: 0,
                segments: [],
                emotions: outcome.emotions,
                defaultEmotion: outcome.defaultEmotion,
                fallbacks: [],
                rtf: 0,
                firstAudioMs: 0,
                modelLoadMs: 0,
                modelWasLoaded: false,
                files: [],
                notes: logs.length === 0 ? [] : [`引擎日志（末行）：${logs[logs.length - 1]}`],
                error: outcome.error,
                engineRestarted: outcome.engineRestarted,
                backend: outcome.backend,
                ...savedTo === undefined ? {} : { savedTo },
            };
        },
    }));
}
//# sourceMappingURL=index.js.map