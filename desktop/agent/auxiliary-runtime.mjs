const MAX_CACHE_ENTRIES = 32;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function cacheKey(model) {
  return JSON.stringify(stable({
    provider: model.provider,
    id: model.id,
    api: model.api,
    baseUrl: model.baseUrl,
    compat: model.compat,
    thinkingLevelMap: model.thinkingLevelMap,
  }));
}

function unsupportedReasoningEffort(value) {
  const message = String(value?.errorMessage ?? value?.message ?? "");
  return /reasoning_effort/i.test(message) && /unsupported|not supported|invalid|unknown|unrecognized|not allowed|not permitted/i.test(message);
}

function remember(cache, key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

function cached(cache, key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function shouldTryDisabledEffort(model, options) {
  return options?.reasoning === "off"
    && model?.reasoning === true
    && model.compat?.thinkingFormat === "openai"
    && model.compat?.supportsReasoningEffort === true
    && !Object.hasOwn(model.thinkingLevelMap || {}, "off");
}

function withNoneEffort(model) {
  return {
    ...model,
    thinkingLevelMap: { ...(model.thinkingLevelMap || {}), off: "none" },
  };
}

export function createAuxiliaryCompleter(complete) {
  if (typeof complete !== "function") throw new TypeError("complete 必须是函数");
  const cache = new Map();

  return async function completeAuxiliary(model, context, options) {
    if (!shouldTryDisabledEffort(model, options)) return complete(model, context, options);

    const key = cacheKey(model);
    const state = cached(cache, key);
    if (state === "unsupported") return complete(model, context, options);

    // Accepted means use "none" directly on every real auxiliary call; it does not claim zero reasoning.
    const adaptedModel = withNoneEffort(model);
    let result;
    try {
      result = await complete(adaptedModel, context, options);
    } catch (error) {
      if (options?.signal?.aborted || !unsupportedReasoningEffort(error)) throw error;
      remember(cache, key, "unsupported");
      return complete(model, context, options);
    }

    if (options?.signal?.aborted || result?.stopReason === "aborted") return result;
    if (result?.stopReason === "error") {
      if (!unsupportedReasoningEffort(result)) return result;
      remember(cache, key, "unsupported");
      return complete(model, context, options);
    }

    remember(cache, key, "accepted");
    return result;
  };
}
