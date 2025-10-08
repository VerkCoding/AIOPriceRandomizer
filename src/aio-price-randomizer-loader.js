"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * Search upward through directory tree for config files
 */
function findConfigFile(startDir, filenames, maxDepth = 6) {
  let currentDir = startDir || process.cwd();
  const tried = [];

  for (let i = 0; i <= maxDepth; i++) {
    for (const filename of filenames) {
      const filepath = path.join(currentDir, filename);
      tried.push(filepath);
      
      if (fs.existsSync(filepath)) {
        return { found: filepath, tried };
      }
    }
    
    const parent = path.dirname(currentDir);
    if (!parent || parent === currentDir) break;
    currentDir = parent;
  }

  return { found: null, tried };
}

/**
 * Safely read and parse JSON file
 */
function readJsonFile(filepath, logger) {
  try {
    const content = fs.readFileSync(filepath, "utf8");
    return JSON.parse(content);
  } catch (err) {
    logger.warn(`[Loader] Failed to parse ${filepath}: ${err.message}`);
    return null;
  }
}

/**
 * Shallow merge with special handling for nested objects
 */
function mergeConfig(base, override) {
  const result = Object.assign({}, base);
  
  for (const key in override) {
    if (!override.hasOwnProperty(key)) continue;
    
    const value = override[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = Object.assign({}, base[key] || {}, value);
    } else {
      result[key] = value;
    }
  }
  
  return result;
}

const DEFAULT_CONFIG = {
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

function loadAndValidateConfig(modDir, logger) {
  // Try to load defaults file
  const defaultsSearch = findConfigFile(modDir, ["config.defaults.json", "defaults.json"], 0);
  const fileDefaults = defaultsSearch.found ? readJsonFile(defaultsSearch.found, logger) : null;
  
  if (fileDefaults) {
    logger.info(`[Loader] Loaded defaults from ${defaultsSearch.found}`);
  }

  // Try to load user config
  const configSearch = findConfigFile(
    modDir, 
    [path.join("config", "config.json"), "config.json"], 
    6
  );
  const userConfig = configSearch.found ? readJsonFile(configSearch.found, logger) : null;
  
  if (userConfig) {
    logger.info(`[Loader] Loaded user config from ${configSearch.found}`);
  } else {
    const searchPaths = configSearch.tried.slice(0, 5).join(", ");
    logger.warn(`[Loader] No user config found (searched: ${searchPaths})`);
  }

  // Merge configurations: defaults -> file defaults -> user config
  let config = mergeConfig(DEFAULT_CONFIG, fileDefaults || {});
  config = mergeConfig(config, userConfig || {});
  
  // Handle nested objects separately to ensure deep merge
  config.currencyTpls = Object.assign(
    {},
    DEFAULT_CONFIG.currencyTpls,
    fileDefaults?.currencyTpls || {},
    userConfig?.currencyTpls || {}
  );
  
  config.CurrencyConversion = Object.assign(
    {},
    DEFAULT_CONFIG.CurrencyConversion,
    fileDefaults?.CurrencyConversion || {},
    userConfig?.CurrencyConversion || {}
  );

  // Normalize boolean values
  config.enabled = !!config.enabled;
  config.autoDiscoverTraderIds = !!config.autoDiscoverTraderIds;
  config.onlyCashTrades = !!config.onlyCashTrades;
  config.stickToBaseline = !!config.stickToBaseline;
  config.debug = !!config.debug;

  // Validate and normalize trader IDs
  if (!Array.isArray(config.traderIds)) {
    config.traderIds = [];
  }
  config.traderIds = Array.from(
    new Set(config.traderIds.map(String).filter(id => id.length > 0))
  );

  // Validate multipliers
  config.minMultiplier = Number(config.minMultiplier) || DEFAULT_CONFIG.minMultiplier;
  config.maxMultiplier = Number(config.maxMultiplier) || DEFAULT_CONFIG.maxMultiplier;
  
  // Swap if min > max
  if (config.minMultiplier > config.maxMultiplier) {
    [config.minMultiplier, config.maxMultiplier] = [config.maxMultiplier, config.minMultiplier];
  }

  // Validate interval
  config.intervalSeconds = Math.abs(
    Math.floor(Number(config.intervalSeconds) || DEFAULT_CONFIG.intervalSeconds)
  );

  // Validate rounding modes
  const validRounding = ["nearest", "floor", "ceil"];
  if (!validRounding.includes(config.rounding)) {
    config.rounding = DEFAULT_CONFIG.rounding;
  }
  if (!validRounding.includes(config.CurrencyConversion.rounding)) {
    config.CurrencyConversion.rounding = DEFAULT_CONFIG.CurrencyConversion.rounding;
  }

  // Validate absolute price bounds
  config.minAbsolute = Math.max(0, Number(config.minAbsolute) || 0);
  config.maxAbsolute = Math.max(0, Number(config.maxAbsolute) || 0);
  
  if (config.maxAbsolute > 0 && config.minAbsolute > config.maxAbsolute) {
    [config.minAbsolute, config.maxAbsolute] = [config.maxAbsolute, config.minAbsolute];
  }

  // Handle seed generation
  if (config.seed == null) {
    const seedData = JSON.stringify({
      minMultiplier: config.minMultiplier,
      maxMultiplier: config.maxMultiplier,
      traderIds: config.traderIds
    });
    const hash = crypto.createHash("md5").update(seedData).digest("hex");
    config.seed = parseInt(hash.slice(0, 8), 16) >>> 0;
    config._derivedSeed = true;
    
    if (config.debug) {
      logger.debug(`[Loader] Derived seed: ${config.seed}`);
    }
  } else {
    const numericSeed = Number(config.seed);
    if (Number.isFinite(numericSeed)) {
      config.seed = Math.floor(Math.abs(numericSeed));
    } else {
      logger.warn("[Loader] Invalid seed provided, deriving from config");
      const seedData = JSON.stringify({
        minMultiplier: config.minMultiplier,
        maxMultiplier: config.maxMultiplier,
        traderIds: config.traderIds
      });
      const hash = crypto.createHash("md5").update(seedData).digest("hex");
      config.seed = parseInt(hash.slice(0, 8), 16) >>> 0;
      config._derivedSeed = true;
    }
  }

  return { config, tried: configSearch.tried };
}

module.exports = { loadAndValidateConfig };