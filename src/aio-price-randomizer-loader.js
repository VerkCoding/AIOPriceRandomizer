"use strict";
/**
 * config-loader.js - AIOPriceRandomizerLoader
 * - Searches upward for defaults (near mod root) and user config (config/config.json or config.json).
 * - Merges defaults <- user config
 * - Validates and normalizes values
 * - Returns { config, tried }
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* logger normalizer reused here to avoid TypeErrors */
function normalizeLoggerInterface(rawLoggerInput) {
  if (!rawLoggerInput) return console;
  if (typeof rawLoggerInput === "function") {
    return {
      info: (...argumentsList) => { try { rawLoggerInput(...argumentsList); } catch { console.info(...argumentsList); } },
      warn: (...argumentsList) => { try { rawLoggerInput(...argumentsList); } catch { console.warn(...argumentsList); } },
      error: (...argumentsList) => { try { rawLoggerInput(...argumentsList); } catch { console.error(...argumentsList); } },
      debug: (...argumentsList) => { try { rawLoggerInput(...argumentsList); } catch { console.debug(...argumentsList); } }
    };
  }
  const findAvailableMethod = (...methodNames) => methodNames.find(methodName => typeof rawLoggerInput[methodName] === "function") || null;
  const availableInfoMethod = findAvailableMethod("info", "log", "trace", "write");
  const availableWarnMethod = findAvailableMethod("warn", "warning", "log", "info");
  const availableErrorMethod = findAvailableMethod("error", "err", "log");
  const availableDebugMethod = findAvailableMethod("debug", "info", "log");
  return {
    info: (...argumentsList) => { if (availableInfoMethod) return rawLoggerInput[availableInfoMethod](...argumentsList); return console.info(...argumentsList); },
    warn: (...argumentsList) => { if (availableWarnMethod) return rawLoggerInput[availableWarnMethod](...argumentsList); return console.warn(...argumentsList); },
    error: (...argumentsList) => { if (availableErrorMethod) return rawLoggerInput[availableErrorMethod](...argumentsList); return console.error(...argumentsList); },
    debug: (...argumentsList) => { if (availableDebugMethod) return rawLoggerInput[availableDebugMethod](...argumentsList); return console.debug(...argumentsList); }
  };
}

/* Search upward from startDir for candidate file names */
function searchDirectoryTreeUpward(startingDirectory, candidateFilenames = [], maximumLevelsToSearch = 6) {
  let currentDirectory = startingDirectory || process.cwd();
  const attemptedPaths = [];
  // Walk up directory tree to find config files for flexible mod installation paths
  for (let levelIndex = 0; levelIndex <= maximumLevelsToSearch; levelIndex++) {
    for (const candidateFilename of candidateFilenames) {
      const candidateFilePath = path.join(currentDirectory, candidateFilename);
      attemptedPaths.push(candidateFilePath);
      if (fs.existsSync(candidateFilePath)) return { found: candidateFilePath, tried: attemptedPaths };
    }
    const parentDirectory = path.dirname(currentDirectory);
    if (!parentDirectory || parentDirectory === currentDirectory) break;
    currentDirectory = parentDirectory;
  }
  return { found: null, tried: attemptedPaths };
}

/* Read JSON safely */
function readJsonFileSecurely(targetFilePath, loggerInstance) {
  try {
    const fileContentRaw = fs.readFileSync(targetFilePath, "utf8");
    return JSON.parse(fileContentRaw);
  } catch (parseError) {
    loggerInstance.warn(`[AIOPriceRandomizerLoader] failed to parse ${targetFilePath}: ${parseError && parseError.message ? parseError.message : parseError}`);
    return null;
  }
}

/* Provide built-in defaults if no defaults file present */
const BUILTIN_DEFAULT_CONFIGURATION = {
  enabled: true,
  autoDiscoverTraderIds: true,
  traderIds: [],
  minMultiplier: 0.85,
  maxMultiplier: 1.35,
  intervalSeconds: 3600,
  rounding: "nearest",
  onlyCashTrades: true,
  currencyTpls: {
    ruble: "5449016a4bdc2d6f028b456f",
    dollar: "5696686a4bdc2da3298b456a",
    eur: "569668774bdc2da2298b4568"
  },
  CurrencyConversion: {
    enabled: true,
    rounding: "nearest"
  },
  stickToBaseline: true,
  minAbsolute: 0,
  maxAbsolute: 0,
  seed: null,
  debug: false
};

function mergeConfigurationObjectsShallow(baseConfiguration, overrideConfiguration) {
  const mergedConfiguration = Object.assign({}, baseConfiguration);
  for (const configurationKey of Object.keys(overrideConfiguration || {})) {
    if (overrideConfiguration[configurationKey] && typeof overrideConfiguration[configurationKey] === "object" && !Array.isArray(overrideConfiguration[configurationKey])) {
      mergedConfiguration[configurationKey] = Object.assign({}, baseConfiguration[configurationKey] || {}, overrideConfiguration[configurationKey]);
    } else {
      mergedConfiguration[configurationKey] = overrideConfiguration[configurationKey];
    }
  }
  return mergedConfiguration;
}

/* Main exported function */
function loadAndValidateConfig(modDirectoryPath, rawLoggerInput) {
  const normalizedLogger = normalizeLoggerInterface(rawLoggerInput);
  // 1) try to find defaults near mod root (no deep search)
  const defaultsFileSearchResult = searchDirectoryTreeUpward(modDirectoryPath, ["config.defaults.json", "defaults.json"], 0);
  let loadedFileDefaults = null;
  if (defaultsFileSearchResult.found) {
    loadedFileDefaults = readJsonFileSecurely(defaultsFileSearchResult.found, normalizedLogger);
    if (loadedFileDefaults) normalizedLogger.info(`[AIOPriceRandomizerLoader] loaded defaults from ${defaultsFileSearchResult.found}`);
  } else {
    normalizedLogger.debug && normalizedLogger.debug(`[AIOPriceRandomizerLoader] no defaults file at ${modDirectoryPath}`);
  }

  // 2) search for user config upward
  const userConfigSearchResult = searchDirectoryTreeUpward(modDirectoryPath, [path.join("config", "config.json"), "config.json"], 6);
  if (!userConfigSearchResult.found) {
    normalizedLogger.warn(`[AIOPriceRandomizerLoader] No user config found near ${modDirectoryPath}; using defaults. (tried ${userConfigSearchResult.tried.slice(0,8).join(" | ")})`);
  }

  let loadedUserConfiguration = null;
  if (userConfigSearchResult.found) {
    loadedUserConfiguration = readJsonFileSecurely(userConfigSearchResult.found, normalizedLogger);
    if (loadedUserConfiguration) normalizedLogger.info(`[AIOPriceRandomizerLoader] loaded user config from ${userConfigSearchResult.found}`);
  }

  // 3) merge: built-in <- fileDefaults <- userConfig
  let mergedConfiguration = mergeConfigurationObjectsShallow(BUILTIN_DEFAULT_CONFIGURATION, loadedFileDefaults || {});
  mergedConfiguration = mergeConfigurationObjectsShallow(mergedConfiguration, loadedUserConfiguration || {});

  // ensure nested objects merged shallowly
  mergedConfiguration.currencyTpls = Object.assign({}, BUILTIN_DEFAULT_CONFIGURATION.currencyTpls, (loadedFileDefaults && loadedFileDefaults.currencyTpls) || {}, (loadedUserConfiguration && loadedUserConfiguration.currencyTpls) || {});
  mergedConfiguration.CurrencyConversion = Object.assign({}, BUILTIN_DEFAULT_CONFIGURATION.CurrencyConversion, (loadedFileDefaults && loadedFileDefaults.CurrencyConversion) || {}, (loadedUserConfiguration && loadedUserConfiguration.CurrencyConversion) || {});

  // Normalize and validate
  mergedConfiguration.enabled = !!mergedConfiguration.enabled;
  mergedConfiguration.autoDiscoverTraderIds = !!mergedConfiguration.autoDiscoverTraderIds;
  mergedConfiguration.onlyCashTrades = !!mergedConfiguration.onlyCashTrades;
  mergedConfiguration.stickToBaseline = !!mergedConfiguration.stickToBaseline;
  mergedConfiguration.debug = !!mergedConfiguration.debug;

  if (!Array.isArray(mergedConfiguration.traderIds)) mergedConfiguration.traderIds = [];
  mergedConfiguration.traderIds = mergedConfiguration.traderIds.map(String).filter(traderIdString => traderIdString.length > 0);
  mergedConfiguration.traderIds = Array.from(new Set(mergedConfiguration.traderIds));

  mergedConfiguration.minMultiplier = Number(mergedConfiguration.minMultiplier);
  mergedConfiguration.maxMultiplier = Number(mergedConfiguration.maxMultiplier);
  if (!Number.isFinite(mergedConfiguration.minMultiplier)) mergedConfiguration.minMultiplier = BUILTIN_DEFAULT_CONFIGURATION.minMultiplier;
  if (!Number.isFinite(mergedConfiguration.maxMultiplier)) mergedConfiguration.maxMultiplier = BUILTIN_DEFAULT_CONFIGURATION.maxMultiplier;
  if (mergedConfiguration.minMultiplier > mergedConfiguration.maxMultiplier) {
    const temporaryMinMultiplier = mergedConfiguration.minMultiplier; mergedConfiguration.minMultiplier = mergedConfiguration.maxMultiplier; mergedConfiguration.maxMultiplier = temporaryMinMultiplier;
    normalizedLogger.warn("[AIOPriceRandomizerLoader] minMultiplier > maxMultiplier — swapped values.");
  }

  mergedConfiguration.intervalSeconds = Number.isFinite(Number(mergedConfiguration.intervalSeconds)) ? Math.floor(Math.abs(Number(mergedConfiguration.intervalSeconds))) : BUILTIN_DEFAULT_CONFIGURATION.intervalSeconds;
  if (!["nearest","floor","ceil"].includes(mergedConfiguration.rounding)) mergedConfiguration.rounding = BUILTIN_DEFAULT_CONFIGURATION.rounding;
  if (!["nearest","floor","ceil"].includes(mergedConfiguration.CurrencyConversion.rounding)) mergedConfiguration.CurrencyConversion.rounding = BUILTIN_DEFAULT_CONFIGURATION.CurrencyConversion.rounding;

  mergedConfiguration.minAbsolute = Number(mergedConfiguration.minAbsolute) || 0;
  mergedConfiguration.maxAbsolute = Number(mergedConfiguration.maxAbsolute) || 0;
  if (mergedConfiguration.minAbsolute < 0) mergedConfiguration.minAbsolute = 0;
  if (mergedConfiguration.maxAbsolute < 0) mergedConfiguration.maxAbsolute = 0;
  if (mergedConfiguration.maxAbsolute > 0 && mergedConfiguration.minAbsolute > mergedConfiguration.maxAbsolute) {
    const temporaryMinAbsolute = mergedConfiguration.minAbsolute; mergedConfiguration.minAbsolute = mergedConfiguration.maxAbsolute; mergedConfiguration.maxAbsolute = temporaryMinAbsolute;
    normalizedLogger.warn("[AIOPriceRandomizerLoader] minAbsolute > maxAbsolute — swapped values.");
  }

  // Seed handling for deterministic randomization across server restarts
  if (mergedConfiguration.seed == null) {
    // Generate seed from config parameters to ensure consistent randomization patterns
    const seedHashBaseString = JSON.stringify({ minMultiplier: mergedConfiguration.minMultiplier, maxMultiplier: mergedConfiguration.maxMultiplier, traderIds: mergedConfiguration.traderIds });
    mergedConfiguration.seed = parseInt(crypto.createHash("md5").update(seedHashBaseString).digest("hex").slice(0,8), 16) >>> 0;
    mergedConfiguration._derivedSeed = true;
    normalizedLogger.debug && normalizedLogger.debug(`[AIOPriceRandomizerLoader] derived seed ${mergedConfiguration.seed}`);
  } else {
    if (typeof mergedConfiguration.seed === "number" && Number.isFinite(mergedConfiguration.seed)) mergedConfiguration.seed = Math.floor(Math.abs(mergedConfiguration.seed));
    else if (typeof mergedConfiguration.seed === "string" && /^\\d+$/.test(mergedConfiguration.seed)) mergedConfiguration.seed = parseInt(mergedConfiguration.seed, 10);
    else {
      normalizedLogger.warn("[AIOPriceRandomizerLoader] Invalid seed provided; deriving seed instead.");
      const seedHashBaseString = JSON.stringify({ minMultiplier: mergedConfiguration.minMultiplier, maxMultiplier: mergedConfiguration.maxMultiplier, traderIds: mergedConfiguration.traderIds });
      mergedConfiguration.seed = parseInt(crypto.createHash("md5").update(seedHashBaseString).digest("hex").slice(0,8), 16) >>> 0;
      mergedConfiguration._derivedSeed = true;
    }
  }

  return { config: mergedConfiguration, tried: userConfigSearchResult.tried };
}

module.exports = { loadAndValidateConfig };