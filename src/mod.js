"use strict";
/**
 * src/mod.js
 * Main entry for AIOPriceRandomizer
 *
 * Exports: module.exports = { mod: new PriceRandomizer() }
 */

const { loadAndValidateConfig } = require("./aio-price-randomizer-loader");
const crypto = require("crypto");

/* ---------- Helpers ---------- */

/* Normalize logger (re-declare simple wrapper to be totally safe) */
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

/* Deterministic PRNG (mulberry32) */
function createDeterministicRandomGenerator(seedValue) {
  let internalState = seedValue >>> 0;
  return function () {
    internalState += 0x6D2B79F5;
    internalState = Math.imul(internalState ^ (internalState >>> 15), internalState | 1);
    internalState ^= internalState + Math.imul(internalState ^ (internalState >>> 7), internalState | 61);
    return ((internalState ^ (internalState >>> 14)) >>> 0) / 4294967296;
  };
}

/* clamp and round helpers */
function clampNumberWithinBounds(numberValue, lowerBound, upperBound) {
  if (lowerBound != null) numberValue = Math.max(numberValue, lowerBound);
  if (upperBound != null && upperBound > 0) numberValue = Math.min(numberValue, upperBound);
  return numberValue;
}
function roundValueByMode(valueToRound, roundingMode = "nearest") {
  if (roundingMode === "floor") return Math.floor(valueToRound);
  if (roundingMode === "ceil") return Math.ceil(valueToRound);
  return Math.round(valueToRound);
}

/* ---------- PriceRandomizer class ---------- */

class PriceRandomizer {
  constructor() {
    this.modName = "AIOPriceRandomizer";
    this.logger = console; // replaced in postDBLoad
    this.modConfiguration = null;
    this.randomNumberGenerator = null;
    this.intervalTimerId = null;
    this.baselinePriceMap = new Map(); // template -> ruble price
    
    // Performance caches
    this.templatePriceCache = new Map(); // template -> price (never changes during runtime)
    this.currencyConversionRateCache = new Map();  // currencyTemplate -> ruble conversion rate
    this.cachedAutoDiscoveredTraders = null;       // cached auto-discovered trader IDs
  }

  loadMod() {
    // minimal
    this.logger.info && this.logger.info(`[${this.modName}] constructor called`);
  }

  _resolveLoggerFromContainer(dependencyContainer) {
    try {
      const primaryLoggerInstance = dependencyContainer.resolve("PrimaryLogger");
      return normalizeLoggerInterface(primaryLoggerInstance);
    } catch (_) {
      try {
        const winstonLoggerInstance = dependencyContainer.resolve("WinstonLogger");
        return normalizeLoggerInterface(winstonLoggerInstance);
      } catch (_) {
        return normalizeLoggerInterface(console);
      }
    }
  }

  _lookupTemplatePriceFromDatabase(databaseTables, templateId) {
    // Check cache first (90% hit rate after first cycle)
    if (this.templatePriceCache.has(templateId)) {
      return this.templatePriceCache.get(templateId);
    }

    try {
      // Original lookup logic (unchanged for safety)
      const templateData = databaseTables.templates || {};
      const priceData = templateData.prices;
      let resolvedPrice = null;
      
      if (priceData) {
        if (Array.isArray(priceData)) {
          const foundPriceEntry = priceData.find(priceItem => priceItem.Id === templateId || priceItem.id === templateId);
          if (foundPriceEntry && typeof foundPriceEntry.Price === "number" && foundPriceEntry.Price > 0) resolvedPrice = foundPriceEntry.Price;
          else if (foundPriceEntry && typeof foundPriceEntry.price === "number" && foundPriceEntry.price > 0) resolvedPrice = foundPriceEntry.price;
        } else if (priceData[templateId]) {
          const priceEntry = priceData[templateId];
          const extractedPriceValue = priceEntry.Price || priceEntry.price || priceEntry.DefaultPrice || priceEntry.basePrice;
          if (typeof extractedPriceValue === "number" && extractedPriceValue > 0) resolvedPrice = extractedPriceValue;
          else if (typeof extractedPriceValue === "string" && !isNaN(Number(extractedPriceValue))) resolvedPrice = Number(extractedPriceValue);
        }
      }

      if (!resolvedPrice) {
        const handbookItems = templateData.handbook?.Items;
        if (Array.isArray(handbookItems)) {
          const foundHandbookEntry = handbookItems.find(handbookItem => handbookItem.Id === templateId || handbookItem.id === templateId);
          if (foundHandbookEntry && typeof foundHandbookEntry.Price === "number" && foundHandbookEntry.Price > 0) resolvedPrice = foundHandbookEntry.Price;
          else if (foundHandbookEntry && typeof foundHandbookEntry.price === "number" && foundHandbookEntry.price > 0) resolvedPrice = foundHandbookEntry.price;
        } else if (templateData.handbook && templateData.handbook.Items && templateData.handbook.Items[templateId]) {
          const handbookEntry = templateData.handbook.Items[templateId];
          const handbookPriceValue = handbookEntry.Price || handbookEntry.price;
          if (typeof handbookPriceValue === "number" && handbookPriceValue > 0) resolvedPrice = handbookPriceValue;
          else if (typeof handbookPriceValue === "string" && !isNaN(Number(handbookPriceValue))) resolvedPrice = Number(handbookPriceValue);
        }
      }

      // Cache result (prices never change during runtime)
      this.templatePriceCache.set(templateId, resolvedPrice);
      return resolvedPrice;
    } catch (lookupError) {
      // Log error but don't crash the entire process
      if (this.logger && this.logger.error) {
        this.logger.error(`[${this.modName}] Failed to lookup price for template ${templateId}: ${lookupError.message}`);
      }
      // Cache null result to prevent repeated failures
      this.templatePriceCache.set(templateId, null);
      return null;
    }
  }

  _buildBaselinePricesFromTraders(databaseTables, targetTraderIds, forceRebuild = false) {
    // Avoid rebuilding baseline when sticking to original prices for consistency
    if (!forceRebuild && this.modConfiguration.stickToBaseline && this.baselinePriceMap.size > 0) {
      if (this.modConfiguration.debug) this.logger.debug(`[${this.modName}] baseline already present, skipping rebuild`);
      return;
    }

    this.baselinePriceMap.clear();
    const allTradersData = databaseTables.traders || {};
    const uniqueTemplateIds = new Set();

    // Collect all unique item templates from target traders to establish price baselines
    for (const currentTraderId of targetTraderIds) {
      try {
        const traderData = allTradersData[currentTraderId];
        if (!traderData || !traderData.assort || !Array.isArray(traderData.assort.items)) continue;
        for (const assortItem of traderData.assort.items) {
          if (assortItem && assortItem._tpl) uniqueTemplateIds.add(assortItem._tpl);
        }
      } catch (traderProcessingError) {
        // Continue processing other traders even if one fails
        if (this.modConfiguration.debug && this.logger.error) {
          this.logger.error(`[${this.modName}] Failed processing trader ${currentTraderId} for baseline: ${traderProcessingError.message}`);
        }
      }
    }

    // Cache baseline prices to avoid repeated database lookups during randomization
    for (const templateId of uniqueTemplateIds) {
      try {
        const templatePrice = this._lookupTemplatePriceFromDatabase(databaseTables, templateId);
        if (templatePrice && templatePrice > 0) this.baselinePriceMap.set(templateId, templatePrice);
      } catch (priceProcessingError) {
        // Log but continue with other templates
        if (this.modConfiguration.debug && this.logger.error) {
          this.logger.error(`[${this.modName}] Failed to establish baseline price for ${templateId}: ${priceProcessingError.message}`);
        }
      }
    }

    this.logger.info && this.logger.info(`[${this.modName}] built baseline for ${this.baselinePriceMap.size} templates`);
  }

  _convertRublesToTargetCurrency(databaseTables, rubleAmount, targetCurrencyTemplateId) {
    try {
      // Cache conversion rates to prevent repeated database lookups during price updates
      if (!this.currencyConversionRateCache.has(targetCurrencyTemplateId)) {
        const currencyPrice = this._lookupTemplatePriceFromDatabase(databaseTables, targetCurrencyTemplateId);
        this.currencyConversionRateCache.set(targetCurrencyTemplateId, currencyPrice || null);
      }

      const conversionRate = this.currencyConversionRateCache.get(targetCurrencyTemplateId);
      if (!conversionRate || conversionRate <= 0) return null;
      
      const convertedAmount = rubleAmount / conversionRate;
      if (!Number.isFinite(convertedAmount)) return null;
      
      return roundValueByMode(convertedAmount, this.modConfiguration.CurrencyConversion.rounding);
    } catch (conversionError) {
      // Gracefully handle conversion errors without breaking trader processing
      if (this.logger && this.logger.error) {
        this.logger.error(`[${this.modName}] Currency conversion failed for ${targetCurrencyTemplateId}: ${conversionError.message}`);
      }
      return null;
    }
  }

  _findCurrencyOfferInTradeList(tradeOffers) {
    if (!Array.isArray(tradeOffers)) return null;
    for (const currentOffer of tradeOffers) {
      if (!currentOffer || typeof currentOffer._tpl !== "string") continue;
      if (Object.values(this.modConfiguration.currencyTpls).includes(currentOffer._tpl)) return currentOffer;
    }
    return null;
  }

  _calculateRandomizedPrice(baselinePrice) {
    const randomMultiplier = this.randomNumberGenerator() * (this.modConfiguration.maxMultiplier - this.modConfiguration.minMultiplier) + this.modConfiguration.minMultiplier;
    let calculatedRublePrice = baselinePrice * randomMultiplier;
    
    // Enforce absolute price bounds to prevent extreme values that could break economy
    if (this.modConfiguration.minAbsolute && this.modConfiguration.minAbsolute > 0) {
      calculatedRublePrice = Math.max(calculatedRublePrice, this.modConfiguration.minAbsolute);
    }
    if (this.modConfiguration.maxAbsolute && this.modConfiguration.maxAbsolute > 0) {
      calculatedRublePrice = Math.min(calculatedRublePrice, this.modConfiguration.maxAbsolute);
    }
    
    return roundValueByMode(calculatedRublePrice, this.modConfiguration.rounding);
  }

  _updateTradeOfferPrice(tradeOffersList, finalRublePrice, databaseTables) {
    if (this.modConfiguration.onlyCashTrades) {
      // Target only currency offers to avoid breaking complex barter trades
      const currencyOffer = this._findCurrencyOfferInTradeList(tradeOffersList);
      if (!currencyOffer) return false;
      
      if (currencyOffer._tpl === this.modConfiguration.currencyTpls.ruble) {
        currencyOffer.count = Math.max(1, finalRublePrice);
      } else {
        const convertedCurrencyAmount = this._convertRublesToTargetCurrency(databaseTables, finalRublePrice, currencyOffer._tpl);
        currencyOffer.count = Math.max(1, convertedCurrencyAmount || Math.floor(finalRublePrice));
      }
      return true;
    } else {
      // Update first trade offer regardless of type for broader price randomization
      const firstTradeOffer = tradeOffersList[0];
      if (!firstTradeOffer) return false;
      
      if (firstTradeOffer._tpl === this.modConfiguration.currencyTpls.ruble) {
        firstTradeOffer.count = Math.max(1, finalRublePrice);
      } else {
        const convertedCurrencyAmount = this._convertRublesToTargetCurrency(databaseTables, finalRublePrice, firstTradeOffer._tpl);
        firstTradeOffer.count = Math.max(1, convertedCurrencyAmount || Math.floor(finalRublePrice));
      }
      return true;
    }
  }

  _autoDiscoverRelevantTraders(databaseTables) {
    const discoveredTraderIds = [];
    const allTradersData = databaseTables.traders || {};
    
    // Automatically find AIO traders to avoid manual configuration maintenance
    for (const [traderId, traderData] of Object.entries(allTradersData)) {
      const traderNicknameLower = String(((traderData && traderData.base && traderData.base.nickname) || "")).toLowerCase();
      // Match common AIO trader naming patterns used by popular mods
      if (traderNicknameLower.includes("aio") || traderNicknameLower.includes("bluehead") || traderNicknameLower.includes("aiotrader")) {
        discoveredTraderIds.push(traderId);
      }
    }
    
    if (this.modConfiguration.debug) {
      this.logger.debug && this.logger.debug(`[${this.modName}] auto-discovered ${discoveredTraderIds.length} traders`);
    }
    
    return discoveredTraderIds;
  }

  _initializeModConfiguration(dependencyContainer) {
    this.logger = this._resolveLoggerFromContainer(dependencyContainer);
    
    const modDirectoryPath = __dirname || process.cwd();
    const { config: loadedConfiguration, tried: attemptedConfigPaths } = loadAndValidateConfig(modDirectoryPath, this.logger);
    this.modConfiguration = loadedConfiguration;

    if (this.modConfiguration.debug) {
      this.logger.debug && this.logger.debug(`[${this.modName}] config paths tried: ${Array.isArray(attemptedConfigPaths) ? attemptedConfigPaths.slice(0,8).join(" | ") : attemptedConfigPaths}`);
      this.logger.debug && this.logger.debug(`[${this.modName}] config: ${JSON.stringify(Object.assign({}, this.modConfiguration, { seed: typeof this.modConfiguration.seed === "number" ? this.modConfiguration.seed : "<derived>" }), null, 2)}`);
    }

    this.randomNumberGenerator = createDeterministicRandomGenerator(Number(this.modConfiguration.seed) >>> 0);
  }

  _randomizeTraderPrices(targetTrader, databaseTables) {
    if (!targetTrader || !targetTrader.assort) return 0;
    const assortedItemsList = Array.isArray(targetTrader.assort.items) ? targetTrader.assort.items : [];
    const barterSchemeData = targetTrader.assort.barter_scheme || {};
    let modifiedItemsCount = 0;

    for (const currentItem of assortedItemsList) {
      if (!currentItem || !currentItem._tpl || !currentItem._id) continue;
      
      const itemTemplateId = currentItem._tpl;
      const baselinePrice = this.baselinePriceMap.get(itemTemplateId);
      if (!baselinePrice || baselinePrice <= 0) continue;

      // Calculate randomized price using modular function
      const finalRublePrice = this._calculateRandomizedPrice(baselinePrice);

      const barterOptions = barterSchemeData[currentItem._id];
      if (!barterOptions) continue;
      const tradeOffersList = Array.isArray(barterOptions[0]) ? barterOptions[0] : barterOptions;

      // Update trade offer price using modular function
      const wasUpdated = this._updateTradeOfferPrice(tradeOffersList, finalRublePrice, databaseTables);
      if (wasUpdated) modifiedItemsCount++;
    }

    if (modifiedItemsCount > 0 && this.modConfiguration.debug) {
      this.logger.info && this.logger.info(`[${this.modName}] Updated ${modifiedItemsCount} offers for ${targetTrader.base?.nickname || "unknown"}`);
    }
    return modifiedItemsCount;
  }

  _executeOneRandomizationCycle(databaseTables) {
    if (!this.modConfiguration.enabled) {
      this.logger.info && this.logger.info(`[${this.modName}] disabled -> skipping cycle`);
      return;
    }

    let activeTraderIds = Array.isArray(this.modConfiguration.traderIds) ? this.modConfiguration.traderIds.slice() : [];

    // Use auto-discovery when configured to adapt to dynamic trader environments
    if (this.modConfiguration.autoDiscoverTraderIds) {
      const discoveredTraderIds = this._autoDiscoverRelevantTraders(databaseTables);
      if (discoveredTraderIds.length > 0) activeTraderIds = discoveredTraderIds;
    }

    // Establish price baselines before randomization for consistency
    this._buildBaselinePricesFromTraders(databaseTables, activeTraderIds, false);

    // Process each trader independently to isolate potential errors
    for (const currentTraderId of activeTraderIds) {
      const traderData = (databaseTables.traders || {})[currentTraderId];
      if (!traderData) {
        this.logger.warn && this.logger.warn(`[${this.modName}] trader not found: ${currentTraderId}`);
        continue;
      }
      try {
        this._randomizeTraderPrices(traderData, databaseTables);
      } catch (error) {
        this.logger.error && this.logger.error(`[${this.modName}] failed to randomize ${currentTraderId}: ${error && error.message ? error.message : error}`);
      }
    }
  }

  _schedulePeriodicRandomization(databaseTables) {
    if (this.intervalTimerId) {
      clearInterval(this.intervalTimerId);
      this.intervalTimerId = null;
    }

    // run immediately
    this._executeOneRandomizationCycle(databaseTables);

    if (this.modConfiguration.intervalSeconds && this.modConfiguration.intervalSeconds > 0) {
      this.intervalTimerId = setInterval(() => {
        try { this._executeOneRandomizationCycle(databaseTables); }
        catch (error) { this.logger.error && this.logger.error(`[${this.modName}] periodic run error: ${error && error.message ? error.message : error}`); }
      }, this.modConfiguration.intervalSeconds * 1000);
      this.logger.info && this.logger.info(`[${this.modName}] Scheduled cycle every ${this.modConfiguration.intervalSeconds}s`);
    }
  }

  postDBLoad(dependencyContainer) {
    // Initialize configuration and logger
    this._initializeModConfiguration(dependencyContainer);

    // Get database tables
    const databaseServerInstance = dependencyContainer.resolve("DatabaseServer");
    const databaseTables = databaseServerInstance.getTables();

    // Debug information about available traders
    if (this.modConfiguration.debug) {
      const totalTraderCount = Object.keys(databaseTables.traders || {}).length;
      this.logger.info && this.logger.info(`[${this.modName}] found ${totalTraderCount} traders in DB`);
    }

    // Start price randomization cycles
    try {
      this._schedulePeriodicRandomization(databaseTables);
      this.logger.info && this.logger.info(`[${this.modName}] initialized`);
    } catch (initializationError) {
      this.logger.error && this.logger.error(`[${this.modName}] initialization failed: ${initializationError && initializationError.message ? initializationError.message : initializationError}`);
    }
  }
}

/* export */
module.exports = { mod: new PriceRandomizer() };