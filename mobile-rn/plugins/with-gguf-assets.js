const { createRunOncePlugin, withAppBuildGradle } = require("expo/config-plugins");

const NO_COMPRESS_LINE = "noCompress 'gguf'";

function withGgufAssets(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "groovy") {
      throw new Error("OpenFicM GGUF packaging requires a Groovy app build.gradle");
    }
    if (nextConfig.modResults.contents.includes(NO_COMPRESS_LINE)) return nextConfig;

    const androidResources = /^(\s*)androidResources\s*\{\s*$/m;
    if (!androidResources.test(nextConfig.modResults.contents)) {
      throw new Error("Unable to configure GGUF packaging: androidResources block not found");
    }
    nextConfig.modResults.contents = nextConfig.modResults.contents.replace(
      androidResources,
      (line, indentation) => line + "\n" + indentation + "    " + NO_COMPRESS_LINE,
    );
    return nextConfig;
  });
}

module.exports = createRunOncePlugin(withGgufAssets, "openfic-gguf-assets", "1.0.0");
