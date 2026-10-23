/**
 * emotions.js — emotion presets and resolution.
 *
 * An emotion maps to three independent layers, each applied only if the model
 * supports it (graceful degradation):
 *
 *   1. `expressions` — names of model expression files (exp3) to cross-fade.
 *      Names are matched case-insensitively; a candidate can also be a 0-based
 *      index string ("0") to address expression-less models that only expose
 *      an ordered list.
 *   2. `motions` — `{group, index?}` entries into the model's motion groups
 *      (e.g. TapBody). Missing groups are skipped.
 *   3. `params` — programmatic additive offsets on standard parameters
 *      (expressed with *logical* keys, see params.js STANDARD_PARAMS, or a raw
 *      model parameter id such as "ParamCheek15"). This is the layer that
 *      makes any model — even one with zero expression files — emote.
 *
 * `config.expressionMap` (or `createLive2DStage(..., {expressionMap})`)
 * shallow-merges per emotion name over the defaults, so hosts can override or
 * add emotions without touching the renderer.
 */

/** @typedef {{expressions?: string[], motions?: Array<{group:string,index?:number}>|string[],
 *            params?: Record<string, number>, gestures?: string[]}} EmotionPreset */

/** Aliases are checked after exact/default keys. */
const ALIASES = {
  默认: ['default', 'neutral', 'normal', '平静', 'calm', 'none', '无'],
  开心: ['高兴', 'happy', 'joy', 'joyful', '兴奋', 'excited', '微笑', 'smile'],
  委屈: ['aggrieved', 'wronged', '可怜', 'sad', '哭', 'cry'],
  生气: ['愤怒', 'angry', 'mad', 'angry_', '恼火'],
  悲伤: ['难过', 'sad', 'sorrow', 'sadness', '低落', 'down'],
  惊讶: ['吃惊', 'surprised', 'surprise', 'shock', '震惊'],
  害羞: ['shy', 'blush', '不好意思', '羞涩'],
  温柔: ['gentle', 'tender', 'soft', '温和', '柔和'],
  撒娇: ['coquettish', 'spoiled', '娇嗔'],
  傲娇: ['tsundere', 'tsun'],
  调皮: ['playful', 'naughty', '坏笑'],
  晕: ['dizzy', '晕晕', '眩晕'],
  无语: ['speechless', '汗', '流汗', '尴尬'],
  星星眼: ['star', 'starry', '星星'],
  爱心眼: ['love', 'heart', 'hearteyes', '爱心'],
  吐舌: ['tongue', '吐舌头'],
  问号: ['question', '疑惑', 'confused'],
  感叹号: ['exclamation', '感叹', '震惊表情'],
  亲切: ['affectionate', 'kind', 'warm', '友好'],
  强调: ['emphasized', 'emphasis', 'emphasis_', '认真', '坚定'],
  否认: ['denial', 'deny', '否认表情', '拒绝'],
};

/**
 * Default emotion table. Keys are Chinese names (the rest of the pipeline —
 * TTS segments — uses Chinese emotion names); aliases cover English/other.
 * @type {Record<string, EmotionPreset>}
 */
export const DEFAULT_EMOTION_MAP = {
  默认: {},

  开心: {
    expressions: ['开心兴奋', '开心', '高兴', 'happy', 'smile', 'F01', 'exp_01'],
    motions: ['TapBody'],
    params: {
      mouthForm: 0.35,
      eyeLOpen: -0.12,
      eyeROpen: -0.12,
      browLY: 0.22,
      browRY: 0.22,
      cheek: 0.25,
      angleZ: 2,
      bodyAngleZ: 1,
    },
  },

  委屈: {
    expressions: ['委屈', '悲伤', '哭', 'sad', 'F03'],
    params: {
      mouthForm: -0.45,
      browLY: -0.32,
      browRY: -0.32,
      browLAngle: 0.25,
      browRAngle: 0.25,
      angleY: -5,
      bodyAngleZ: -2,
      eyeLOpen: -0.1,
    },
  },

  生气: {
    expressions: ['生气', '愤怒', 'angry', 'F05', 'exp_05'],
    motions: ['TapBody'],
    params: {
      browLY: -0.5,
      browRY: -0.5,
      browLForm: -0.5,
      browRForm: -0.5,
      mouthForm: -0.4,
      eyeLOpen: 0.08,
      angleZ: 4,
      bodyAngleZ: 3,
    },
  },

  悲伤: {
    expressions: ['悲伤', '哭', 'sad', '难过', 'F03', 'exp_03'],
    params: {
      browLY: -0.42,
      browRY: -0.42,
      browLAngle: 0.3,
      browRAngle: 0.3,
      mouthForm: -0.55,
      eyeLOpen: -0.15,
      eyeROpen: -0.15,
      angleY: -6,
      bodyAngleZ: -2,
    },
  },

  惊讶: {
    expressions: ['惊讶', '感叹号', '问号', 'surprised', 'F02'],
    params: {
      browLY: 0.55,
      browRY: 0.55,
      eyeLOpen: 0.25,
      eyeROpen: 0.25,
      mouthOpenY: 0.12,
      bodyAngleZ: -1,
    },
  },

  害羞: {
    expressions: ['脸红', '害羞', 'shy', 'blush', 'F06'],
    params: {
      cheek: 0.65,
      eyeLOpen: -0.2,
      eyeROpen: -0.2,
      angleY: -4,
      angleZ: -4,
      mouthForm: 0.22,
        },
  },

  温柔: {
    expressions: ['温柔', 'gentle', 'smile', 'F07'],
    params: {
      eyeLOpen: -0.1,
      eyeROpen: -0.1,
      mouthForm: 0.25,
      browLY: 0.1,
      browRY: 0.1,
      angleZ: 1.5,
    },
  },

  撒娇: {
    expressions: ['撒娇', '爱心眼', 'coquettish', 'love'],
    params: {
      mouthForm: 0.4,
      eyeLOpen: -0.28,
      eyeROpen: -0.28,
      angleZ: 5,
      bodyAngleZ: 3,
      cheek: 0.2,
    },
  },

  傲娇: {
    expressions: ['傲娇', '调皮', 'tsundere'],
    params: {
      browLY: -0.25,
      browRY: -0.25,
      mouthForm: -0.12,
      angleZ: -5,
      bodyAngleZ: -2,
      eyeLOpen: 0.05,
    },
  },

  调皮: {
    expressions: ['调皮', '吐舌', 'playful'],
    params: {
      mouthForm: 0.3,
      eyeLOpen: -0.08,
      angleZ: 4,
      bodyAngleZ: 2,
    },
  },

  晕: {
    expressions: ['晕晕', 'dizzy', '晕'],
    params: {
      angleZ: 8,
      angleY: 3,
      eyeLOpen: -0.3,
      eyeROpen: 0.22,
      bodyAngleZ: 4,
    },
  },

  无语: {
    expressions: ['流汗', '问号', '无语', 'speechless'],
    params: {
      browLY: -0.18,
      browRY: -0.18,
      mouthForm: -0.2,
      angleZ: -2,
    },
  },

  星星眼: {
    expressions: ['星星眼', 'star', '爱心眼'],
    params: { eyeLOpen: 0.15, eyeROpen: 0.15, mouthForm: 0.3, cheek: 0.2 },
  },

  爱心眼: {
    expressions: ['爱心眼', 'love', 'heart'],
    params: { cheek: 0.5, mouthForm: 0.38, eyeLOpen: -0.05 },
  },

  吐舌: {
    expressions: ['吐舌', '调皮', 'tongue'],
    params: { mouthForm: 0.22 },
  },

  问号: {
    expressions: ['问号', '疑惑', 'question'],
    params: { browLY: 0.18, angleZ: -3 },
  },

  亲切: {
    expressions: ['爱心眼', '温柔', '脸红', 'affectionate'],
    params: {
      mouthForm: 0.38,
      eyeLOpen: -0.14,
      eyeROpen: -0.14,
      browLY: 0.12,
      browRY: 0.12,
      cheek: 0.35,
      angleZ: 2,
    },
  },

  强调: {
    expressions: ['感叹号', '星星眼', 'emphasized'],
    params: {
      browLY: 0.2,
      browRY: 0.2,
      mouthForm: 0.16,
      eyeLOpen: 0.08,
      angleY: 3,
    },
  },

  否认: {
    expressions: ['问号', '流汗', 'denial'],
    params: {
      browLY: 0.14,
      browRY: 0.14,
      mouthForm: -0.22,
      angleZ: -4,
      eyeLOpen: -0.05,
    },
  },

  感叹号: {
    expressions: ['感叹号', '惊讶', 'exclamation'],
    params: { browLY: 0.3, browRY: 0.3, eyeLOpen: 0.15 },
  },
};

/** Chinese text cues used when a speech segment carries text but no emotion. */
export const TEXT_EMOTION_CUES = [
  { re: /(哈哈|嘿嘿|嘻嘻|笑死|lol|haha)/i, emotion: '开心' },
  { re: /(呜呜|嘤嘤|哭|泪|伤心|难过)/, emotion: '悲伤' },
  { re: /(生气|讨厌|哼！|可恶)/, emotion: '生气' },
  { re: /(哎呀|哇|天哪|真的吗|不会吧|！)/, emotion: '惊讶' },
  { re: /(害羞|脸红|不好意思)/, emotion: '害羞' },
  { re: /(爱你|喜欢|比心|么么)/, emotion: '爱心眼' },
  { re: /(晕|转圈|头好晕)/, emotion: '晕' },
];

/** Lower-case/trim helper that also strips a leading/trailing "emo:" prefix. */
function normalizeName(name) {
  if (name === null || name === undefined) return '';
  let s = String(name).trim();
  if (/^emo(?:tion)?[:：]/i.test(s)) s = s.replace(/^emo(?:tion)?[:：]/i, '').trim();
  return s;
}

/** Build a name -> canonical key index from the default map + aliases. */
function buildIndex() {
  const index = new Map();
  for (const key of Object.keys(DEFAULT_EMOTION_MAP)) index.set(key.toLowerCase(), key);
  for (const [key, aliases] of Object.entries(ALIASES)) {
    for (const alias of aliases) {
      const k = String(alias).toLowerCase();
      if (!index.has(k)) index.set(k, key);
    }
  }
  return index;
}
const NAME_INDEX = buildIndex();

/**
 * Resolve an emotion name into a preset.
 *
 * Resolution order:
 *   1. exact key of `override` (config.expressionMap) — merged over defaults,
 *      so custom params can extend a default emotion;
 *   2. exact key / alias of the defaults;
 *   3. unknown name → treated as a raw model expression name (exp3 file/name or
 *      index), with no param offsets. This lets hosts emit arbitrary
 *      expression names for a specific model and still get a result.
 *
 * @param {string|number} name
 * @param {Record<string, EmotionPreset>} [override]
 * @returns {{key:string, matched:boolean, requested:string,
 *            expressions:string[], motions:Array<{group:string,index?:number}>,
 *            params:Record<string,number>, gestures:string[]}}
 */
export function resolveEmotion(name, override) {
  const requested = normalizeName(name);
  const norm = requested.toLowerCase();
  const custom = override && typeof override === 'object' ? override : null;

  let key = null;
  let matched = false;
  if (custom) {
    for (const k of Object.keys(custom)) {
      if (k.toLowerCase() === norm) {
        key = k;
        matched = true;
        break;
      }
    }
  }
  if (!key && NAME_INDEX.has(norm)) {
    key = NAME_INDEX.get(norm);
    matched = true;
  }

  const base = (key && DEFAULT_EMOTION_MAP[key]) || {};
  const over = key && custom ? custom[key] : null;
  const merged = mergePresets(base, over);

  if (!key) {
    // Unknown name: treat it as a model expression name (or index).
    return {
      key: requested,
      requested,
      matched: false,
      expressions: requested ? [requested] : [],
      motions: [],
      params: {},
      gestures: [],
    };
  }

  return {
    key,
    requested,
    matched: true,
    expressions: merged.expressions,
    motions: merged.motions,
    params: merged.params,
    gestures: merged.gestures,
  };
}

/** Shallow-merge two presets (override wins; params are merged per key). */
function mergePresets(base, over) {
  const out = {
    expressions: (base && base.expressions) || [],
    motions: (base && base.motions) || [],
    params: Object.assign({}, (base && base.params) || {}),
    gestures: (base && base.gestures) || [],
  };
  if (!over) return out;
  if (Array.isArray(over.expressions)) out.expressions = over.expressions.slice();
  if (Array.isArray(over.motions)) {
    out.motions = over.motions.map((m) =>
      typeof m === 'string' ? { group: m } : m
    );
  }
  if (over.params && typeof over.params === 'object') {
    Object.assign(out.params, over.params);
  }
  if (Array.isArray(over.gestures)) out.gestures = over.gestures.slice();
  return out;
}

/** All known emotion names (defaults + aliases), for docs/debug/help text. */
export function listEmotionNames() {
  const names = new Set(Object.keys(DEFAULT_EMOTION_MAP));
  for (const [key, aliases] of Object.entries(ALIASES)) {
    if (!names.has(key)) names.add(key);
    for (const a of aliases) names.add(a);
  }
  return Array.from(names);
}
