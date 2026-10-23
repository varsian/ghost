/**
 * params.js — model capability adaptation for Cubism 2 & Cubism 4 parameters.
 *
 * Live2D models expose *arbitrary* parameter ids; a renderer must probe what a
 * given model actually has and silently skip the rest ("不存在就跳过，不报错").
 *
 * Cubism 4 parameter ids are PascalCase (ParamMouthOpenY) while Cubism 2 ones
 * are SCREAMING_SNAKE (PARAM_MOUTH_OPEN_Y). Every logical key below therefore
 * carries both candidates plus a sane numeric range used when the model cannot
 * report its own range (Cubism 2 has no min/max getter).
 */

/** @typedef {'cubism2'|'cubism4'} ModelFormat */

/**
 * Logical parameter table. `c4`/`c2` are candidate ids tried in order.
 * `range` is the fallback range when the core model has no getter (cubism2).
 */
export const STANDARD_PARAMS = {
  mouthOpenY: { c4: ['ParamMouthOpenY'], c2: ['PARAM_MOUTH_OPEN_Y'], range: [0, 1], def: 0 },
  mouthForm: { c4: ['ParamMouthForm'], c2: ['PARAM_MOUTH_FORM'], range: [-1, 1], def: 0 },
  eyeLOpen: { c4: ['ParamEyeLOpen'], c2: ['PARAM_EYE_L_OPEN'], range: [0, 1], def: 1 },
  eyeROpen: { c4: ['ParamEyeROpen'], c2: ['PARAM_EYE_R_OPEN'], range: [0, 1], def: 1 },
  eyeBallX: { c4: ['ParamEyeBallX'], c2: ['PARAM_EYE_BALL_X'], range: [-1, 1], def: 0 },
  eyeBallY: { c4: ['ParamEyeBallY'], c2: ['PARAM_EYE_BALL_Y'], range: [-1, 1], def: 0 },
  browLY: { c4: ['ParamBrowLY'], c2: ['PARAM_BROW_L_Y'], range: [-1, 1], def: 0 },
  browRY: { c4: ['ParamBrowRY'], c2: ['PARAM_BROW_R_Y'], range: [-1, 1], def: 0 },
  browLX: { c4: ['ParamBrowLX'], c2: ['PARAM_BROW_L_X'], range: [-1, 1], def: 0 },
  browRX: { c4: ['ParamBrowRX'], c2: ['PARAM_BROW_R_X'], range: [-1, 1], def: 0 },
  browLAngle: { c4: ['ParamBrowLAngle'], c2: ['PARAM_BROW_L_ANGLE'], range: [-1, 1], def: 0 },
  browRAngle: { c4: ['ParamBrowRAngle'], c2: ['PARAM_BROW_R_ANGLE'], range: [-1, 1], def: 0 },
  browLForm: { c4: ['ParamBrowLForm'], c2: ['PARAM_BROW_L_FORM'], range: [-1, 1], def: 0 },
  browRForm: { c4: ['ParamBrowRForm'], c2: ['PARAM_BROW_R_FORM'], range: [-1, 1], def: 0 },
  angleX: { c4: ['ParamAngleX'], c2: ['PARAM_ANGLE_X'], range: [-30, 30], def: 0 },
  angleY: { c4: ['ParamAngleY'], c2: ['PARAM_ANGLE_Y'], range: [-30, 30], def: 0 },
  angleZ: { c4: ['ParamAngleZ'], c2: ['PARAM_ANGLE_Z'], range: [-30, 30], def: 0 },
  bodyAngleX: { c4: ['ParamBodyAngleX'], c2: ['PARAM_BODY_ANGLE_X'], range: [-10, 10], def: 0 },
  bodyAngleY: { c4: ['ParamBodyAngleY'], c2: ['PARAM_BODY_ANGLE_Y'], range: [-10, 10], def: 0 },
  bodyAngleZ: { c4: ['ParamBodyAngleZ'], c2: ['PARAM_BODY_ANGLE_Z'], range: [-10, 10], def: 0 },
  breath: { c4: ['ParamBreath'], c2: ['PARAM_BREATH'], range: [0, 1], def: 0 },
  cheek: { c4: ['ParamCheek'], c2: ['PARAM_CHEEK'], range: [0, 1], def: 0 },
  hairFront: { c4: ['ParamHairFront'], c2: ['PARAM_HAIR_FRONT'], range: [-1, 1], def: 0 },
  armLA: { c4: ['ParamArmLA'], c2: ['PARAM_ARM_L_A'], range: [-1, 1], def: 0 },
  armRA: { c4: ['ParamArmRA'], c2: ['PARAM_ARM_R_A'], range: [-1, 1], def: 0 },
};

/** Reverse index: raw parameter id -> logical key (for cubism4 ids). */
const C4_TO_LOGICAL = new Map();
/** Reverse index: raw parameter id -> logical key (for cubism2 ids). */
const C2_TO_LOGICAL = new Map();
for (const [logical, def] of Object.entries(STANDARD_PARAMS)) {
  for (const id of def.c4) C4_TO_LOGICAL.set(id, logical);
  for (const id of def.c2) C2_TO_LOGICAL.set(id, logical);
}

/** @param {number} v @param {number} lo @param {number} hi */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Adapter over a pixi-live2d-display core model that unifies Cubism 2 & 4
 * parameter access and gracefully reports missing parameters.
 */
export class ParamAdapter {
  /**
   * @param {object} coreModel `internalModel.coreModel`
   * @param {ModelFormat} format
   */
  constructor(coreModel, format) {
    this.coreModel = coreModel;
    this.format = format === 'cubism2' ? 'cubism2' : 'cubism4';
    this.isCubism4 = this.format === 'cubism4';
    /** @type {Map<string, {id:string, index:number, min:number, max:number, def:number}|null>} */
    this.cache = new Map();
    this.missing = new Set();
  }

  /** Resolve logical key or raw id to a parameter handle, or null. */
  resolve(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    let handle = null;
    if (this.isCubism4) handle = this._resolveCubism4(name);
    else handle = this._resolveCubism2(name);
    this.cache.set(name, handle);
    if (!handle) this.missing.add(name);
    return handle;
  }

  has(name) {
    return !!this.resolve(name);
  }

  _logicalOf(name) {
    const logical = (this.isCubism4 ? C4_TO_LOGICAL : C2_TO_LOGICAL).get(name) || STANDARD_PARAMS[name];
    return logical || null;
  }

  _resolveCubism4(name) {
    const core = this.coreModel;
    const candidates = [];
    const std = STANDARD_PARAMS[name];
    if (std) candidates.push(...std.c4);
    else {
      // raw id may itself be a cubism4 id; also allow "mouthOpenY" style keys
      const logical = C4_TO_LOGICAL.get(name);
      if (logical) candidates.push(...STANDARD_PARAMS[logical].c4);
      else candidates.push(name);
    }
    for (const id of candidates) {
      let index = -1;
      try {
        index = core.getParameterIndex(id);
      } catch (e) {
        index = -1;
      }
      if (index < 0) continue;
      let min = 0;
      let max = 1;
      let def = 0;
      try {
        min = core.getParameterMinimumValue(index);
        max = core.getParameterMaximumValue(index);
        def = core.getParameterDefaultValue(index);
      } catch (e) {
        const r = (std && std.range) || [0, 1];
        min = r[0];
        max = r[1];
        def = (std && std.def) || 0;
      }
      return { id, index, min, max, def };
    }
    return null;
  }

  _resolveCubism2(name) {
    const core = this.coreModel;
    const candidates = [];
    const std = STANDARD_PARAMS[name];
    if (std) candidates.push(...std.c2);
    else {
      const logical = C2_TO_LOGICAL.get(name);
      if (logical) candidates.push(...STANDARD_PARAMS[logical].c2);
      else candidates.push(name);
    }
    for (const id of candidates) {
      let index = -1;
      try {
        index = typeof core.getParamIndex === 'function' ? core.getParamIndex(id) : -1;
      } catch (e) {
        index = -1;
      }
      if (index < 0) continue;
      const r = (std && std.range) || [0, 1];
      return { id, index, min: r[0], max: r[1], def: (std && std.def) || 0 };
    }
    return null;
  }

  /** Current value of a parameter (or null when missing). */
  get(name) {
    const h = this.resolve(name);
    if (!h) return null;
    try {
      if (this.isCubism4) return this.coreModel.getParameterValueByIndex(h.index);
      return this.coreModel.getParamFloat(h.index);
    } catch (e) {
      return null;
    }
  }

  /** Set absolute value, clamped to the parameter range. No-op when missing. */
  set(name, value) {
    const h = this.resolve(name);
    if (!h) return false;
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    const v = clamp(value, h.min, h.max);
    try {
      if (this.isCubism4) this.coreModel.setParameterValueByIndex(h.index, v);
      else this.coreModel.setParamFloat(h.index, v);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Add delta to current value (clamped). No-op when missing. */
  add(name, delta) {
    const h = this.resolve(name);
    if (!h) return false;
    if (typeof delta !== 'number' || !Number.isFinite(delta) || delta === 0) return false;
    try {
      if (this.isCubism4) this.coreModel.addParameterValueByIndex(h.index, delta);
      else this.coreModel.addToParamFloat(h.index, delta);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Multiply current value. No-op when missing. */
  multiply(name, factor) {
    const h = this.resolve(name);
    if (!h) return false;
    if (typeof factor !== 'number' || !Number.isFinite(factor)) return false;
    try {
      if (this.isCubism4) this.coreModel.multiplyParameterValueByIndex(h.index, factor);
      else if (typeof this.coreModel.multParamFloat === 'function') {
        this.coreModel.multParamFloat(h.index, factor);
      } else {
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Range of a parameter, or null when missing. */
  range(name) {
    const h = this.resolve(name);
    return h ? { min: h.min, max: h.max, def: h.def } : null;
  }

  /** Summary used by `stage.stats()` / acceptance logs. */
  describe() {
    const out = {};
    for (const key of Object.keys(STANDARD_PARAMS)) {
      const h = this.resolve(key);
      out[key] = h ? { id: h.id, min: h.min, max: h.max } : null;
    }
    return out;
  }
}
