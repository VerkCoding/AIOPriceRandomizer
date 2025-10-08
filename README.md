# AIO Price Randomizer

A price randomization mod for SPT-AKI that works with BlueHead's AIO Trader and similar mods. Provides configurable price variation with deterministic seeding, currency conversion support, and flexible trader targeting.

## Features

- **Seeded randomization** - Consistent prices across server restarts
- **Currency support** - Automatic conversion between RUB/USD/EUR
- **Flexible configuration** - Override defaults with user config
- **Auto-discovery** - Automatically finds AIO traders by nickname
- **Periodic updates** - Configurable price refresh intervals
- **Safe barter handling** - Only modifies currency trades by default
- **Debug logging** - Optional detailed diagnostics

## Installation

1. Extract the mod folder into `[SPT]/user/mods/`
2. Verify folder structure: `user/mods/AIOPriceRandomizer/`
3. Start server - default config will be used on first run
4. (Optional) Edit `config/config.json` to customize settings

## Configuration

Edit `config/config.json` to adjust behavior:

- `enabled` - Enable/disable the mod
- `autoDiscoverTraderIds` - Automatically find AIO traders
- `traderIds` - Manual list of trader IDs (if auto-discover is off)
- `minMultiplier` / `maxMultiplier` - Price variation range (default: 0.85 - 1.35)
- `intervalSeconds` - How often to randomize prices (default: 3600)
- `rounding` - Price rounding mode: "nearest", "floor", or "ceil"
- `onlyCashTrades` - Only modify currency trades, ignore barter items
- `stickToBaseline` - Use original prices as reference (recommended)
- `minAbsolute` / `maxAbsolute` - Hard price limits (0 = disabled)
- `seed` - RNG seed for deterministic prices (null = auto-generate)
- `debug` - Enable detailed logging

## Requirements

- **SPT-AKI 3.11.x** or compatible version
- **BlueHead's AIO Trader** (or similar Trader mods)
  - Download: https://forge.sp-tarkov.com/mod/374/blueheads-aio-trader

## Troubleshooting

**Prices aren't changing:**
- Enable `debug: true` in config and check server logs
- Verify trader IDs are correct (check debug output for discovered traders)
- Ensure mod loads after your AIO trader mod

**Traders showing no items:**
- Check that other mods aren't clearing trader assortments
- Verify BlueHead's AIO Trader is installed and working
- Review startup logs for errors

**Config not loading:**
- Ensure `config/config.json` is valid JSON (no trailing commas or comments)
- Check file permissions
- Enable debug mode to see config search paths

## File Structure
AIOPriceRandomizer/
├── src/
│   ├── mod.js                          # Main mod entry point
│   └── aio-price-randomizer-loader.js  # Config loader
├── config/
│   └── config.json                     # User configuration
└── package.json                        # Mod metadata

## Credits

Built to complement **BlueHead's AIO Trader** by bluehead:
https://forge.sp-tarkov.com/mod/374/blueheads-aio-trader

## License

MIT License - Feel free to modify and redistribute
