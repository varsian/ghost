/**
 * assets.js — model discovery & settings assembly.
 *
 * pixi-live2d-display can load a model either from a URL or from an in-memory
 * settings JSON object (in which case the object MUST carry `url` so relative
 * resource paths resolve — same trick the library's own `urlToJSON` middleware
 * uses).
 *
 * Some models (notably VTube Studio exports) ship `.exp3.json` / `.motion3.json`
 * files that are *not registered* in `model3.json`. This module discovers them
 * from (in priority order):
 *
 *   1. the model descriptor passed by the host (`model.expressions`,
 *      `model.motions`, `model.hiddenParts`);
 *   2. a `live2d.manifest.json` placed inside the model directory (self
 *      contained; used by the bundled sample models);
 *   3. whatever the settings JSON already registers.
 *
 * and merges registered Motions groups into the settings JSON before handing
 * it to pixi-live2d-display. Expressions are applied by the renderer itself
 * (see stage.js) so they are only collected as `{name, file, url}` records.
 */

/** Fetch JSON with a clear error message including the URL and HTTP status. */
export async function fetchJSON(url, opts) {
  const res = await fetch(url, Object.assign({ cache: 'no-cache' }, opts));
  if (!res.ok) {
    const err = new Error(`[live2d] failed to fetch ${url}: HTTP ${res.status}`);
    err.status = res.status;
    err.url = url;
    throw err;
  }
  return res.json();
}

/** Join a base URL (directory, with or without trailing slash) and a relative path. */
export function joinUrl(base, rel) {
  if (!rel) return base || '';
  if (/^[a-z]+:/i.test(rel) || rel.startsWith('/')) return rel;
  if (!base) return rel;
  return base.endsWith('/') ? base + rel : base + '/' + rel;
}

/**
 * Detect the model format from the settings file name / descriptor.
 * @param {string} modelFile
 * @param {'cubism2'|'cubism4'|'auto'|undefined} explicit
 * @returns {'cubism2'|'cubism4'}
 */
export function detectFormat(modelFile, explicit) {
  if (explicit === 'cubism2' || explicit === 'cubism4') return explicit;
  const f = String(modelFile || '').toLowerCase();
  if (f.endsWith('.model3.json')) return 'cubism4';
  if (f.endsWith('.model.json')) return 'cubism2';
  // fall back to cubism4 (the modern format) but let the core check complain
  return 'cubism4';
}

/** Strip known Live2D extensions and directories to derive a display name. */
export function expressionNameFromFile(file) {
  const base = String(file).split('?')[0].split('#')[0].split(/[\\/]/).pop() || '';
  return base
    .replace(/\.exp3\.json$/i, '')
    .replace(/\.json$/i, '')
    .trim();
}

function normalizeExpressionEntry(entry, baseUrl) {
  if (Array.isArray(entry)) entry = entry[0];
  if (typeof entry === 'string') {
    return { name: expressionNameFromFile(entry), file: entry, url: joinUrl(baseUrl, entry) };
  }
  if (!entry || typeof entry !== 'object') return null;
  const file = entry.file || entry.File || entry.path || entry.url || '';
  const url = entry.url && /^[a-z]+:/i.test(entry.url) ? entry.url : joinUrl(baseUrl, file || '');
  const name = entry.name || entry.Name || expressionNameFromFile(file || url);
  if (!file && !url) return null;
  return { name, file: file || url, url };
}

function normalizeMotions(input) {
  /** @type {Array<{group:string, file:string, fadeIn?:number, fadeOut?:number}>} */
  const out = [];
  if (!input) return out;
  const push = (group, file, extra) => {
    if (!file) return;
    out.push(Object.assign({ group: String(group || 'Idle'), file: String(file) }, extra || {}));
  };
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') push('Idle', item);
      else if (item && typeof item === 'object') {
        push(item.group || item.Group || 'Idle', item.file || item.File, {
          fadeIn: item.fadeIn || item.FadeInTime,
          fadeOut: item.fadeOut || item.FadeOutTime,
        });
      }
    }
  } else if (typeof input === 'object') {
    for (const [group, files] of Object.entries(input)) {
      if (Array.isArray(files)) {
        for (const f of files) {
          if (typeof f === 'string') push(group, f);
          else if (f && typeof f === 'object') {
            push(group, f.file || f.File, {
              fadeIn: f.fadeIn || f.FadeInTime,
              fadeOut: f.fadeOut || f.FadeOutTime,
            });
          }
        }
      } else if (typeof files === 'string') {
        push(group, files);
      }
    }
  }
  return out;
}

function dedupeBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const k = keyFn(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/**
 * Load the model settings + discovered expression/motion/hidden-part lists.
 *
 * @param {object} model descriptor `{baseUrl, modelFile, format, expressions?,
 *        motions?, hiddenParts?, manifestFile?}`
 * @returns {Promise<{format:'cubism2'|'cubism4', modelUrl:string,
 *   settings:object, expressions:Array<{name,file,url}>,
 *   motions:Array<{group,file,fadeIn,fadeOut}>, hiddenParts:string[],
 *   manifest:object|null}>}
 */
export async function loadModelAssets(model) {
  const baseUrl = model.baseUrl || '';
  const modelFile = model.modelFile || '';
  const format = detectFormat(modelFile, model.format);
  const modelUrl = joinUrl(baseUrl, modelFile);
  const settings = await fetchJSON(modelUrl);

  // 1) optional self-contained manifest bundled with the model directory
  let manifest = null;
  const manifestFile = model.manifestFile || 'live2d.manifest.json';
  if (manifestFile) {
    try {
      manifest = await fetchJSON(joinUrl(baseUrl, manifestFile));
    } catch (e) {
      manifest = null; // 404 is expected for models without a manifest
    }
  }

  const settingsExpressions =
    settings &&
    settings.FileReferences &&
    Array.isArray(settings.FileReferences.Expressions)
      ? settings.FileReferences.Expressions
      : null;

  // 2) expressions: descriptor > manifest > settings JSON
  const rawExpressions = [];
  const addRawExpressions = (list, base) => {
    if (!list) return;
    const arr = Array.isArray(list) ? list : Object.entries(list).map(([name, file]) => ({ name, file }));
    for (const entry of arr) {
      const norm = normalizeExpressionEntry(entry, base);
      if (norm) rawExpressions.push(norm);
    }
  };
  if (model.expressions) addRawExpressions(model.expressions, baseUrl);
  if (manifest && manifest.expressions) addRawExpressions(manifest.expressions, baseUrl);
  if (settingsExpressions) addRawExpressions(settingsExpressions, baseUrl);
  const expressions = dedupeBy(rawExpressions, (e) => e.name + '|' + e.file);

  // 3) motions: descriptor > manifest > settings JSON (settings JSON kept as-is
  //    when nothing extra is discovered, so widely-tuned models are untouched)
  const rawMotionInputs = [];
  if (model.motions) rawMotionInputs.push(...normalizeMotions(model.motions));
  if (manifest && manifest.motions) rawMotionInputs.push(...normalizeMotions(manifest.motions));
  const extraMotions = dedupeBy(rawMotionInputs, (m) => m.group + '|' + m.file);
  const merged = JSON.parse(JSON.stringify(settings));
  merged.url = modelUrl;
  if (!merged.FileReferences) merged.FileReferences = {};
  if (extraMotions.length) {
    const existing = merged.FileReferences.Motions || {};
    const groups = {};
    // keep already-registered motions first
    for (const [group, defs] of Object.entries(existing)) {
      groups[group] = (groups[group] || []).concat(
        (Array.isArray(defs) ? defs : []).map((d) => d)
      );
    }
    // Files already registered in the model3.json must not be duplicated.
    const registeredFiles = new Set();
    for (const defs of Object.values(existing)) {
      for (const d of Array.isArray(defs) ? defs : []) {
        if (d && d.File) registeredFiles.add(String(d.File));
      }
    }
    for (const m of extraMotions) {
      if (registeredFiles.has(String(m.file))) continue;
      registeredFiles.add(String(m.file));
      const def = { File: m.file };
      if (m.fadeIn) def.FadeInTime = m.fadeIn;
      if (m.fadeOut) def.FadeOutTime = m.fadeOut;
      (groups[m.group] = groups[m.group] || []).push(def);
    }
    merged.FileReferences.Motions = groups;
  }

  // 4) hidden parts (props/desk/background parts to force invisible)
  const hiddenParts = [];
  const addHidden = (list) => {
    if (!Array.isArray(list)) return;
    for (const id of list) if (typeof id === 'string' && id && !hiddenParts.includes(id)) hiddenParts.push(id);
  };
  if (manifest && manifest.hiddenParts) addHidden(manifest.hiddenParts);
  if (model.hiddenParts) addHidden(model.hiddenParts);

  // 5) optional behavioural flags (manifest > descriptor)
  const disableIdleMotion =
    model.disableIdleMotion !== undefined
      ? !!model.disableIdleMotion
      : !!(manifest && manifest.disableIdleMotion);

  return {
    format,
    modelUrl,
    settings: merged,
    expressions,
    motions: extraMotions,
    hiddenParts,
    disableIdleMotion,
    manifest,
  };
}
