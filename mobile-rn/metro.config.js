const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

if (!config.resolver.assetExts.includes("gguf")) {
  config.resolver.assetExts.push("gguf");
}

module.exports = config;
